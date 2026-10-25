import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const executable = process.env.P2R_BROWSER_EXECUTABLE;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('browser imports local video, keeps stream mode off fal, runs HQ once per request, and exports GLB', {
  skip: !executable && 'set P2R_BROWSER_EXECUTABLE to run the browser integration test',
  timeout: 180000,
}, async (t) => {
  let puppeteer;
  try { ({ default: puppeteer } = await import('puppeteer-core')); }
  catch { return t.skip('install puppeteer-core to run the browser integration test'); }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt2rig-browser-test-'));
  const uploadDir = path.join(tempDir, 'uploads');
  const videoPath = path.join(ROOT, 'bench', 'clips', 'benchmark.mp4');
  const videoBytes = (await fs.stat(videoPath)).size;
  let worker;
  let workerProcessCount = 0;
  let workerHands;
  let webProcess;
  let browser;
  try {
    worker = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, device: 'browser test GPU' }));
      }
      if (req.url !== '/process' || req.method !== 'POST') return res.writeHead(404).end();
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      workerProcessCount++;
      workerHands = body.hands;
      const source = await fetch(body.video_url);
      const sourceBytes = Buffer.from(await source.arrayBuffer()).length;
      if (!source.ok || sourceBytes !== videoBytes) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'worker could not read the complete local video' }));
      }
      const n = 2;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        n, fps: 30, global_orient: Array(n * 3).fill(0), body_pose: Array(n * 63).fill(0),
        transl: Array(n * 3).fill(0), leg_length: 0.85, incam_global_orient0: [0, 0, 0],
        hands: null, elapsed: 0.01,
      }));
    });
    worker.listen(0, '127.0.0.1');
    await once(worker, 'listening');
    const workerPort = worker.address().port;

    webProcess = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        FAL_KEY: '',
        HQ_URL: `http://127.0.0.1:${workerPort}`,
        MAX_UPLOAD_MB: '10',
        P2R_UPLOAD_DIR: uploadDir,
        PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    webProcess.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    webProcess.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
    const startup = Date.now();
    let origin;
    while (Date.now() - startup < 5000) {
      const match = output.match(/Prompt2Rig → http:\/\/localhost:(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; break; }
      if (webProcess.exitCode != null) throw new Error(`web server exited: ${errors || output}`);
      await delay(10);
    }
    if (!origin) throw new Error(`web server did not start: ${errors || output}`);

    browser = await puppeteer.launch({
      executablePath: executable,
      headless: true,
      args: ['--no-sandbox', '--enable-webgl', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
      defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' });
    page.setDefaultTimeout(60000);
    page.on('pageerror', (error) => { errors += `\npage error: ${error.message}`; });
    page.on('console', (message) => { if (message.type() === 'error') errors += `\nconsole error: ${message.text()}`; });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('p2r', JSON.stringify({ stream: true, hq: false, hands: false, showSkel: false }));
      const originalFetch = window.fetch.bind(window);
      window.__p2rCalls = [];
      window.fetch = (input, init) => {
        const raw = typeof input === 'string' ? input : input.url;
        const url = new URL(raw, location.href);
        if (url.origin === location.origin && url.pathname.startsWith('/api/')) window.__p2rCalls.push(url.pathname);
        if (url.pathname === '/api/takes') return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        return originalFetch(input, init);
      };
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#pill-rig')?.classList.contains('ok'), { timeout: 90000 });
    await page.waitForFunction(() => document.querySelector('#pill-hq')?.classList.contains('ok'), { timeout: 15000 });

    const input = await page.$('#file-vid');
    await input.uploadFile(videoPath);
    await page.waitForFunction(() => document.querySelector('.take')?.innerText.includes('benchmark.mp4'));
    await page.waitForFunction(() => window.p2r?.current?.sourceKind === 'file');
    let apiCalls = await page.evaluate(() => window.__p2rCalls.slice());
    assert.equal(apiCalls.filter((url) => url === '/api/uploads').length, 0, 'HQ-off import must not upload');
    assert.equal(apiCalls.filter((url) => url === '/api/hq').length, 0, 'HQ-off import must not call worker');
    assert.equal(apiCalls.some((url) => ['/api/video', '/api/image'].includes(url)), false, 'stream mode must not call fal for a local video');

    await page.click('#hq');
    await input.uploadFile(videoPath);
    await page.waitForFunction(() => {
      const card = document.querySelector('.take');
      return card?.innerText.includes('reprocess hq') && !card.querySelector('[data-a="hq"]')?.disabled;
    }, { timeout: 90000 });
    assert.equal(workerProcessCount, 1);
    assert.equal(workerHands, 'off');

    let cards = await page.$$('.take');
    await cards[0].$('[data-a="hq"]').then((button) => button.click());
    await page.waitForFunction(() => {
      const card = document.querySelector('.take');
      return card?.innerText.includes('reprocess hq') && !card.querySelector('[data-a="hq"]')?.disabled
        && window.__p2rCalls.filter((url) => url === '/api/hq').length === 2;
    }, { timeout: 90000 });
    apiCalls = await page.evaluate(() => window.__p2rCalls.slice());
    assert.equal(apiCalls.filter((url) => url === '/api/uploads').length, 1, 'reprocess must reuse the local upload');
    assert.equal(apiCalls.some((url) => ['/api/video', '/api/image'].includes(url)), false, 'local import must not call fal');

    cards = await page.$$('.take');
    await cards[0].$('[data-a="glb"]').then((button) => button.click());
    try {
      await page.waitForFunction(() => document.querySelector('#log')?.innerText.includes('exported ') && document.querySelector('#log')?.innerText.includes('.glb'), { timeout: 30000 });
    } catch (error) {
      const log = await page.$eval('#log', (element) => element.innerText).catch(() => '(no app log)');
      throw new Error(`${error.message}\nApp log:\n${log}\nBrowser errors:\n${errors}`);
    }
    assert.match(await page.$eval('#log', (element) => element.innerText), /exported take2__file_benchmark_mp4_hq\.glb/);
  } finally {
    if (browser) await browser.close();
    if (webProcess && webProcess.exitCode == null) {
      webProcess.kill();
      await once(webProcess, 'exit').catch(() => {});
    }
    if (worker?.listening) {
      worker.close();
      await once(worker, 'close');
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
