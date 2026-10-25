// Prompt2Rig — tiny zero-dependency server.
// Serves ./public and proxies fal.ai so the API key never reaches the browser.
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const TAKES = path.join(ROOT, 'takes'); // exported takes for tools/render_blender.py

// --- .env -------------------------------------------------------------------
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const FAL_KEY = process.env.FAL_KEY;
const PORT = Number(process.env.PORT || 5177);
const HQ_URL = process.env.HQ_URL || 'http://127.0.0.1:5178';
const UPLOADS = path.resolve(process.env.P2R_UPLOAD_DIR || path.join(ROOT, 'hq', 'cache', 'uploads'));
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 250);
if (!Number.isSafeInteger(MAX_UPLOAD_MB) || MAX_UPLOAD_MB < 1 || !Number.isSafeInteger(MAX_UPLOAD_MB * 1024 * 1024)) {
  throw new Error('MAX_UPLOAD_MB must be a positive safe integer');
}
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
if (!FAL_KEY) console.warn('[prompt2rig] FAL_KEY is not set — generation will fail. Put it in .env');

let hqProcess = null;
let hqLaunchError = null;

function hqPythonPath() {
  if (process.env.HQ_PYTHON) return path.resolve(ROOT, process.env.HQ_PYTHON);
  return path.join(ROOT, 'hq', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
}

async function startHqWorker(req, res) {
  if (!localRequestAllowed(req)) return send(res, 403, { error: 'starting the HQ worker is only available from this computer' });
  if (!localWorkerConfigured()) return send(res, 400, { error: 'HQ_URL must point to a worker on this computer' });

  const target = new URL(HQ_URL);
  if (target.protocol !== 'http:') return send(res, 400, { error: 'the local HQ worker must use http://' });
  if (hqProcess && hqProcess.exitCode == null && !hqProcess.killed) {
    return send(res, 202, { started: false, starting: true });
  }
  try {
    const existing = await fetch(`${HQ_URL}/health`, { signal: AbortSignal.timeout(1000) });
    const status = await existing.json();
    if (existing.ok && typeof status?.ok === 'boolean') {
      return send(res, 200, { started: false, ready: !!status.ok, ...status });
    }
  } catch {}

  const python = hqPythonPath();
  let pythonReady = false;
  try { pythonReady = fs.statSync(python).isFile(); } catch {}
  if (!pythonReady) {
    const hint = process.env.HQ_PYTHON
      ? `HQ_PYTHON does not exist: ${python}`
      : `HQ Python environment not found at ${python}. Run hq/setup.ps1 on Windows, or set HQ_PYTHON in .env to your environment's Python executable.`;
    return send(res, 400, { error: hint });
  }

  hqLaunchError = null;
  const child = spawn(python, [path.join(ROOT, 'hq', 'worker.py')], {
    cwd: path.join(ROOT, 'hq'),
    env: { ...process.env, HQ_PORT: target.port || '80' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  hqProcess = child;

  for (const [stream, label] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line) console.log(`[hq ${label}] ${line}`);
    });
    stream.on('end', () => { if (pending) console.log(`[hq ${label}] ${pending}`); });
  }

  child.once('error', (error) => {
    hqLaunchError = `could not start HQ worker: ${error.message}`;
    console.error(`[hq] ${hqLaunchError}`);
    if (hqProcess === child) hqProcess = null;
  });
  child.once('exit', (code, signal) => {
    console.log(`[hq] worker exited (${signal || code})`);
    hqLaunchError = `HQ worker exited (${signal || `code ${code}`})`;
    if (hqProcess === child) hqProcess = null;
  });
  return send(res, 202, { started: true });
}

const VIDEO_MODELS = {
  // MiniMax H3 Max Turbo — faster than real time (~0.5s GPU for 5s @ 480P)
  h3: {
    t2v: 'minimax/h3-max-turbo/text-to-video',
    i2v: 'minimax/h3-max-turbo/image-to-video',
    input: (b, i2v) => ({
      duration: Math.min(15, Math.max(1, Number(b.duration) || 5)),
      resolution: ['480P', '768P', '1080P'].includes(b.resolution) ? b.resolution : '480P',
      prompt_expansion_mode: 'disabled',
      ...(i2v ? {} : { aspect_ratio: b.aspect_ratio || '16:9' }),
    }),
  },
  // FLUX 3 Max — higher fidelity, ~real time (5s @ 720p ≈ 4.5s GPU, ~9s wall)
  flux3: {
    t2v: 'blackforestlabs/flux-3-max/text-to-video',
    i2v: 'blackforestlabs/flux-3-max/image-to-video',
    input: (b, i2v) => ({
      duration: Math.min(20, Math.max(5, Math.round(Number(b.duration) || 5))),
      resolution: b.resolution === '1080P' ? '1080p' : '720p',
      generate_audio: false,
      reasoning_level: b.reasoning_level === 'high' ? 'high' : 'low',
      aspect_ratio: i2v ? 'auto' : (b.aspect_ratio || '16:9'),
    }),
  },
};
const IMAGE_MODEL = 'fal-ai/flux/schnell';

async function falRun(model, input) {
  const t0 = performance.now();
  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const detail = json?.detail ? JSON.stringify(json.detail) : text.slice(0, 500);
    throw Object.assign(new Error(`fal ${model} → ${res.status}: ${detail}`), { status: res.status });
  }
  return { ...json, _elapsed: (performance.now() - t0) / 1000 };
}

// --- request handling ----------------------------------------------------------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 25e6) reject(Object.assign(new Error('body too large'), { status: 413 })); else chunks.push(c); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(Object.assign(e, { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^::ffff:/, '');
  return normalized === '::1' || normalized === 'localhost' || normalized.startsWith('127.');
}

function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(String(hostname || '').toLowerCase().replace(/^\[|\]$/g, ''));
}

function localRequestAllowed(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return isLocalHost(new URL(origin).hostname); } catch { return false; }
}

function localWorkerConfigured() {
  try { return isLocalHost(new URL(HQ_URL).hostname); } catch { return false; }
}

function uploadPath(id, extension = '.bin') {
  if (!UUID_RE.test(id)) return null;
  return path.join(UPLOADS, id.toLowerCase() + extension);
}

function endAndCloseRequest(req, res, status, body) {
  req.pause();
  res.shouldKeepAlive = false;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  res.end(JSON.stringify(body));
}

async function receiveUpload(req, res) {
  if (!localRequestAllowed(req)) return send(res, 403, { error: 'local uploads are only available from this computer' });

  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/octet-stream' && !/^video\/[a-z0-9.+-]+$/.test(contentType)) {
    return send(res, 415, { error: 'send a video/* or application/octet-stream body' });
  }

  const rawLength = req.headers['content-length'];
  let tooLarge = false;
  if (rawLength != null) {
    if (!/^\d+$/.test(rawLength)) return send(res, 400, { error: 'invalid Content-Length' });
    tooLarge = Number(rawLength) > MAX_UPLOAD_BYTES;
  }

  const id = crypto.randomUUID();
  const partial = uploadPath(id, '.part');
  const complete = uploadPath(id);
  let file;
  let size = 0;
  try {
    await fs.promises.mkdir(UPLOADS, { recursive: true });
    if (!tooLarge) file = await fs.promises.open(partial, 'wx', 0o600);
    for await (const chunk of req) {
      size += chunk.length;
      if (tooLarge) continue;
      if (size > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        await file.close();
        file = null;
        await fs.promises.unlink(partial).catch(() => {});
        continue;
      }
      let offset = 0;
      while (offset < chunk.length) {
        const written = await file.write(chunk, offset, chunk.length - offset);
        if (!written.bytesWritten) throw new Error('could not write uploaded video');
        offset += written.bytesWritten;
      }
    }
    if (file) {
      await file.close();
      file = null;
    }
    if (tooLarge) {
      await fs.promises.unlink(partial).catch(() => {});
      return endAndCloseRequest(req, res, 413, { error: `video exceeds the ${MAX_UPLOAD_MB} MiB upload limit` });
    }
    if (size === 0) {
      await fs.promises.unlink(partial).catch(() => {});
      return send(res, 400, { error: 'video upload is empty' });
    }
    await fs.promises.rename(partial, complete);
    console.log(`[upload] ${id} ${size} bytes`);
    return send(res, 201, { upload_id: id, bytes: size });
  } catch (err) {
    if (file) await file.close().catch(() => {});
    await fs.promises.unlink(partial).catch(() => {});
    if (req.aborted || res.destroyed) return;
    console.error('[upload error]', err.message);
    return send(res, 500, { error: 'could not store video upload' });
  }
}

async function serveUpload(req, res, id) {
  if (!localRequestAllowed(req)) return send(res, 403, { error: 'local uploads are only available from this computer' });
  const file = uploadPath(id);
  if (!file) return send(res, 404, { error: 'upload not found' });
  let stat;
  try { stat = await fs.promises.lstat(file); } catch { return send(res, 404, { error: 'upload not found' }); }
  if (!stat.isFile()) return send(res, 404, { error: 'upload not found' });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    console.error('[upload read error]', err.message);
    if (!res.headersSent) send(res, 500, { error: 'could not read uploaded video' });
    else res.destroy(err);
  });
  stream.pipe(res);
}

function requestWorker(body) {
  const target = new URL(`${HQ_URL.replace(/\/+$/, '')}/process`);
  const transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (!transport) return Promise.reject(new Error('HQ_URL must use http or https'));
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const upstream = transport.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode || 502, type: response.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    upstream.on('error', reject);
    upstream.end(payload);
  });
}

let hqQueue = Promise.resolve();
function queueHQ(task) {
  const result = hqQueue.then(task, task);
  hqQueue = result.then(() => undefined, () => undefined);
  return result;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/uploads' && req.method === 'POST') return await receiveUpload(req, res);
    const uploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/);
    if (uploadMatch && req.method === 'GET') return await serveUpload(req, res, uploadMatch[1]);

    if (req.method === 'POST' && url.pathname === '/api/video') {
      const b = await readJson(req);
      const model = VIDEO_MODELS[b.model] ? b.model : 'h3';
      const mode = b.image_url ? 'i2v' : 't2v';
      const input = { prompt: String(b.prompt || '').slice(0, 4000), ...VIDEO_MODELS[model].input(b, mode === 'i2v') };
      if (b.seed != null && b.seed !== '') input.seed = Number(b.seed);
      if (mode === 'i2v') input.image_url = b.image_url;
      const out = await falRun(VIDEO_MODELS[model][mode], input);
      console.log(`[video] ${model} ${mode} ${input.duration}s ${input.resolution} in ${out._elapsed.toFixed(1)}s (gpu ${out.timings?.inference?.toFixed?.(2) ?? '?'}s)`);
      return send(res, 200, { model, mode, video_url: out.video?.url, timings: out.timings, elapsed: out._elapsed });
    }

    if (req.method === 'POST' && url.pathname === '/api/image') {
      const b = await readJson(req);
      const out = await falRun(IMAGE_MODEL, {
        prompt: String(b.prompt || '').slice(0, 4000),
        image_size: b.image_size || 'landscape_16_9',
        num_inference_steps: 4,
        enable_safety_checker: true,
      });
      console.log(`[image] in ${out._elapsed.toFixed(1)}s`);
      return send(res, 200, { image_url: out.images?.[0]?.url, elapsed: out._elapsed });
    }

    // Save an exported take (GLB body, ?name=…&source=<video url>) into ./takes for the Blender renderer.
    if (req.method === 'POST' && url.pathname === '/api/takes') {
      const name = (url.searchParams.get('name') || 'take').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 100e6) throw Object.assign(new Error('take too large'), { status: 413 }); chunks.push(c); }
      fs.mkdirSync(TAKES, { recursive: true });
      fs.writeFileSync(path.join(TAKES, name + '.glb'), Buffer.concat(chunks));
      const meta = { name, source: url.searchParams.get('source') || null, prompt: url.searchParams.get('prompt') || '', saved: new Date().toISOString() };
      fs.writeFileSync(path.join(TAKES, name + '.json'), JSON.stringify(meta, null, 2));
      console.log(`[take] saved takes/${name}.glb`);
      return send(res, 200, { path: `takes/${name}.glb` });
    }

    // Start the local worker from its prepared Python environment on request.
    if (req.method === 'POST' && url.pathname === '/api/hq/start') return startHqWorker(req, res);

    // HQ pass: forward to the local GVHMR worker (hq/worker.py).
    if (url.pathname === '/api/hq/health') {
      try {
        const r = await fetch(`${HQ_URL}/health`, { signal: AbortSignal.timeout(2000) });
        return send(res, 200, await r.json());
      } catch { return send(res, 200, { ok: false, error: hqLaunchError || 'worker offline' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/hq') {
      const b = await readJson(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'HQ request must be a JSON object' });
      const hasUpload = Object.hasOwn(b, 'upload_id');
      const hasUrl = Object.hasOwn(b, 'video_url');
      if (hasUpload === hasUrl) return send(res, 400, { error: 'provide exactly one of upload_id or video_url' });

      let videoUrl;
      if (hasUpload) {
        if (typeof b.upload_id !== 'string' || !uploadPath(b.upload_id)) return send(res, 400, { error: 'invalid upload_id' });
        if (!localWorkerConfigured()) return send(res, 400, { error: 'local video uploads require an HQ worker on this computer' });
        try { await fs.promises.access(uploadPath(b.upload_id)); }
        catch { return send(res, 404, { error: 'uploaded video not found; select the file again' }); }
        const address = server.address();
        if (!address || typeof address === 'string') return send(res, 503, { error: 'web server is not ready to serve the uploaded video' });
        videoUrl = `http://127.0.0.1:${address.port}/api/uploads/${b.upload_id.toLowerCase()}`;
      } else {
        if (typeof b.video_url !== 'string') return send(res, 400, { error: 'video_url must be an http(s) URL' });
        let parsed;
        try { parsed = new URL(b.video_url); } catch { return send(res, 400, { error: 'video_url must be an http(s) URL' }); }
        if (!['http:', 'https:'].includes(parsed.protocol)) return send(res, 400, { error: 'video_url must be an http(s) URL' });
        videoUrl = parsed.href;
      }

      if (b.hands != null && !['off', 'auto', 'wilor', 'mediapipe'].includes(b.hands)) {
        return send(res, 400, { error: 'hands must be off, auto, wilor, or mediapipe' });
      }
      const body = { video_url: videoUrl, ...(b.hands != null ? { hands: b.hands } : {}) };
      let result;
      try { result = await queueHQ(() => requestWorker(body)); }
      catch (err) { throw Object.assign(err, { status: 502 }); }
      res.writeHead(result.status, {
        'Content-Type': result.type || 'application/json',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(result.body);
    }

    if (req.method === 'GET') {
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';
      const file = path.normalize(path.join(PUBLIC, p));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }

    res.writeHead(405); res.end();
  } catch (err) {
    console.error('[error]', err.message);
    if (res.destroyed || req.aborted) return;
    const status = err.status && err.status < 600 ? err.status : 500;
    send(res, status, { error: err.message });
  }
});

process.once('exit', () => { if (hqProcess && hqProcess.exitCode == null) hqProcess.kill(); });

server.listen(PORT, () => {
  const address = server.address();
  console.log(`Prompt2Rig → http://localhost:${typeof address === 'object' && address ? address.port : PORT}`);
});
