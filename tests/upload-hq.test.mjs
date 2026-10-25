import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIDEO = Buffer.from('safe local video bytes\x00\x01');
let tempDir;
let worker;
let webProcess;
let webOrigin;
let uploadDir;
let workerPort;
let processCalls = [];
let activeJobs = 0;
let maxActiveJobs = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function startServer(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function startWebServer() {
  webProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FAL_KEY: '',
      HQ_URL: `http://127.0.0.1:${workerPort}`,
      MAX_UPLOAD_MB: '1',
      P2R_UPLOAD_DIR: uploadDir,
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let errors = '';
  webProcess.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  webProcess.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const match = output.match(/Prompt2Rig → http:\/\/localhost:(\d+)/);
    if (match) {
      webOrigin = `http://127.0.0.1:${match[1]}`;
      return;
    }
    if (webProcess.exitCode != null) throw new Error(`test server exited early: ${errors || output}`);
    await delay(10);
  }
  webProcess.kill();
  throw new Error(`test server did not start: ${errors || output}`);
}

async function upload(body = VIDEO, headers = {}) {
  const response = await fetch(`${webOrigin}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });
  return { response, json: await response.json().catch(() => ({})) };
}

async function processHq(body, headers = {}) {
  return fetch(`${webOrigin}/api/hq`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt2rig-upload-tests-'));
  uploadDir = path.join(tempDir, 'uploads');
  processCalls = [];
  activeJobs = 0;
  maxActiveJobs = 0;
  worker = http.createServer(async (req, res) => {
    try {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, device: 'test device' }));
      }
      if (req.url !== '/process' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      const call = JSON.parse((await readBody(req)).toString());
      processCalls.push(call);
      activeJobs++;
      maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
      if (call.video_url.includes('/api/uploads/')) {
        const downloaded = await fetch(call.video_url);
        call.downloadStatus = downloaded.status;
        call.downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
      }
      if (call.video_url.includes('/disconnect')) {
        activeJobs--;
        res.destroy();
        return;
      }
      await delay(call.hands === 'mediapipe' ? 160 : 70);
      activeJobs--;
      if (call.hands === 'wilor') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'simulated worker failure' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      activeJobs = Math.max(0, activeJobs - 1);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  workerPort = await startServer(worker);
  await startWebServer();
});

after(async () => {
  if (webProcess && webProcess.exitCode == null) {
    webProcess.kill();
    await once(webProcess, 'exit').catch(() => {});
  }
  if (worker?.listening) {
    worker.close();
    await once(worker, 'close');
  }
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test('upload stores bytes privately and worker can fetch through the local URL', async () => {
  const { response, json } = await upload();
  assert.equal(response.status, 201);
  assert.equal(json.bytes, VIDEO.length);
  assert.match(json.upload_id, /^[0-9a-f-]{36}$/i);

  const downloaded = await fetch(`${webOrigin}/api/uploads/${json.upload_id}`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), VIDEO);

  const hq = await processHq({ upload_id: json.upload_id, hands: 'off' }, { Host: 'attacker.invalid' });
  assert.equal(hq.status, 200);
  const call = processCalls.at(-1);
  assert.match(call.video_url, new RegExp(`^http://127\\.0\\.0\\.1:${webOrigin.split(':').at(-1)}/api/uploads/`));
  assert.equal(call.hands, 'off');
  assert.equal(call.downloadStatus, 200);
  assert.deepEqual(call.downloadedBytes, VIDEO);
});

test('upload rejects empty, invalid MIME, invalid origin, unknown IDs, and malformed HQ bodies', async () => {
  assert.equal((await upload(Buffer.alloc(0))).response.status, 400);
  assert.equal((await upload(VIDEO, { 'Content-Type': 'text/plain' })).response.status, 415);
  assert.equal((await upload(VIDEO, { Origin: 'https://attacker.invalid' })).response.status, 403);
  assert.equal((await fetch(`${webOrigin}/api/uploads/not-a-uuid`)).status, 404);
  assert.equal((await processHq({ upload_id: '../server.mjs' })).status, 400);
  assert.equal((await processHq({ upload_id: '00000000-0000-4000-8000-000000000000' })).status, 404);
  assert.equal((await processHq({ video_url: 'blob:http://localhost/id' })).status, 400);
  assert.equal((await processHq({ upload_id: '00000000-0000-4000-8000-000000000000', video_url: 'https://example.invalid/v.mp4' })).status, 400);
  const nullBody = await fetch(`${webOrigin}/api/hq`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
  assert.equal(nullBody.status, 400);
  const invalidJson = await fetch(`${webOrigin}/api/hq`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
});

test('upload limit returns 413 for declared and chunked oversized bodies and leaves no partial files', async () => {
  const large = Buffer.alloc(1024 * 1024 + 1, 7);
  const declared = await upload(large);
  assert.equal(declared.response.status, 413);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024));
      controller.enqueue(new Uint8Array(512 * 1024 + 1));
      controller.close();
    },
  });
  const chunked = await fetch(`${webOrigin}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: stream,
    duplex: 'half',
  });
  assert.equal(chunked.status, 413);
  const files = await fs.readdir(uploadDir);
  assert.equal(files.some((name) => name.endsWith('.part')), false);
});

test('an interrupted request removes its temporary upload without stopping the server', async () => {
  await new Promise((resolve) => {
    const request = http.request(`${webOrigin}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 100000 },
    });
    request.on('error', resolve);
    request.on('close', resolve);
    request.write(Buffer.alloc(1024, 1));
    request.destroy();
  });
  await delay(50);
  assert.equal((await fs.readdir(uploadDir)).some((name) => name.endsWith('.part')), false);
  assert.equal((await fetch(`${webOrigin}/api/hq/health`)).status, 200);
});

test('remote video URLs retain the existing HQ contract', async () => {
  const url = 'https://example.invalid/existing-clip.mp4';
  const response = await processHq({ video_url: url, hands: 'auto' });
  assert.equal(response.status, 200);
  assert.equal(processCalls.at(-1).video_url, url);
  assert.equal(processCalls.at(-1).hands, 'auto');
});

test('local file HQ refuses a worker configured on another machine', async () => {
  const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt2rig-remote-hq-test-'));
  const isolatedUploads = path.join(isolatedDir, 'uploads');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, FAL_KEY: '', HQ_URL: 'http://192.0.2.1:5178', MAX_UPLOAD_MB: '1', P2R_UPLOAD_DIR: isolatedUploads, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
    const started = Date.now();
    let origin;
    while (Date.now() - started < 5000) {
      const match = output.match(/Prompt2Rig → http:\/\/localhost:(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; break; }
      if (child.exitCode != null) throw new Error(`isolated server exited: ${errors || output}`);
      await delay(10);
    }
    assert.ok(origin, `isolated server did not start: ${errors || output}`);
    const received = await fetch(`${origin}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: VIDEO,
    });
    const receipt = await received.json();
    assert.equal(received.status, 201);
    const response = await fetch(`${origin}/api/hq`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: receipt.upload_id, hands: 'off' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /on this computer/);
  } finally {
    if (child.exitCode == null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    await fs.rm(isolatedDir, { recursive: true, force: true });
  }
});

test('HQ calls are serialized, health stays responsive, and a failure does not block the next call', async () => {
  const first = processHq({ video_url: 'https://example.invalid/slow.mp4', hands: 'mediapipe' });
  await delay(20);
  const healthStart = Date.now();
  const health = await fetch(`${webOrigin}/api/hq/health`);
  assert.equal(health.status, 200);
  assert.ok(Date.now() - healthStart < 150);
  assert.equal((await first).status, 200);

  const before = processCalls.length;
  const concurrentA = processHq({ video_url: 'https://example.invalid/queue-a.mp4', hands: 'mediapipe' });
  const concurrentB = processHq({ video_url: 'https://example.invalid/queue-b.mp4', hands: 'off' });
  assert.deepEqual((await Promise.all([concurrentA, concurrentB])).map((r) => r.status), [200, 200]);
  assert.equal(processCalls.length, before + 2);

  const disconnected = await processHq({ video_url: 'https://example.invalid/disconnect.mp4', hands: 'off' });
  assert.equal(disconnected.status, 502);
  const failed = await processHq({ video_url: 'https://example.invalid/fails.mp4', hands: 'wilor' });
  assert.equal(failed.status, 503);
  const next = await processHq({ video_url: 'https://example.invalid/next.mp4', hands: 'off' });
  assert.equal(next.status, 200);
  assert.equal(processCalls.length, before + 5);
  assert.equal(maxActiveJobs, 1);
});
