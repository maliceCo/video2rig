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
      const bodyPose = Array(n * 63).fill(0);
      bodyPose[63 + 15 * 3 + 2] = 0.35; // Move the left upper arm in the second frame.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        n, fps: 30, global_orient: Array(n * 3).fill(0), body_pose: bodyPose,
        transl: [0, 0, 0, 0.1, 0, 0], leg_length: 0.85, incam_global_orient0: [0, 0, 0],
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
    page.on('requestfailed', (request) => { errors += `\nrequest failed: ${request.url()} ${request.failure()?.errorText}`; });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('p2r', JSON.stringify({ stream: true, hq: false, hands: false, showSkel: false }));
      const originalFetch = window.fetch.bind(window);
      const originalCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        if (blob.type === 'model/gltf-binary') window.__p2rDownloadedGlb = blob;
        return originalCreateObjectURL(blob);
      };
      window.__p2rCalls = [];
      window.fetch = (input, init) => {
        const raw = typeof input === 'string' ? input : input.url;
        const url = new URL(raw, location.href);
        if (url.origin === location.origin && url.pathname.startsWith('/api/')) window.__p2rCalls.push(url.pathname);
        if (url.pathname === '/api/takes') {
          window.__p2rSavedGlb = init.body;
          return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return originalFetch(input, init);
      };
    });
    try { await page.goto(origin, { waitUntil: 'domcontentloaded' }); }
    catch (error) { throw new Error(`${error.message}\nBrowser errors:\n${errors}`); }
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

    const runtimeNames = await page.evaluate(() => {
      const names = [];
      window.p2r.rig.model.traverse((object) => { if (object.isBone) names.push(object.name); });
      window.__p2rExportState = () => {
        const state = [];
        window.p2r.rig.model.traverse((object) => {
          state.push([object.scale.toArray(), object.isSkinnedMesh ? object.skeleton.boneInverses.map((inverse) => inverse.toArray()) : null]);
        });
        return JSON.stringify(state);
      };
      window.__p2rBeforeExportState = window.__p2rExportState();
      return names;
    });
    cards = await page.$$('.take');
    await cards[0].$('[data-a="glb"]').then((button) => button.click());
    try {
      await page.waitForFunction(() => document.querySelector('#log')?.innerText.includes('exported ') && document.querySelector('#log')?.innerText.includes('.glb'), { timeout: 30000 });
    } catch (error) {
      const log = await page.$eval('#log', (element) => element.innerText).catch(() => '(no app log)');
      throw new Error(`${error.message}\nApp log:\n${log}\nBrowser errors:\n${errors}`);
    }
    assert.match(await page.$eval('#log', (element) => element.innerText), /exported take2__file_benchmark_mp4_hq\.glb/);

    const exported = await page.evaluate(async () => {
      const { AnimationMixer, PropertyBinding, Vector3 } = await import('three');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { clone } = await import('three/addons/utils/SkeletonUtils.js');
      const { trackToClip } = await import('/retarget.js');
      const bytes = window.__p2rSavedGlb;
      const saved = new Uint8Array(bytes);
      const downloaded = new Uint8Array(await window.__p2rDownloadedGlb.arrayBuffer());
      const parseGlb = (buffer) => {
        const view = new DataView(buffer);
        return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, view.getUint32(12, true))));
      };
      const skeleton = (gltf) => {
        const joints = new Set(gltf.skins.flatMap((skin) => skin.joints));
        return [...joints].map((index) => {
          const node = gltf.nodes[index];
          return [node.name, (node.children || []).filter((child) => joints.has(child)).map((child) => gltf.nodes[child].name).sort()];
        }).sort(([a], [b]) => a.localeCompare(b));
      };
      const source = parseGlb(await (await fetch('https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/models/gltf/Xbot.glb')).arrayBuffer());
      const json = parseGlb(bytes);
      const animation = json.animations[0];
      const armChannel = animation.channels.find((channel) => json.nodes[channel.target.node].name === 'mixamorig:LeftArm');
      const armAccessor = json.accessors[animation.samplers[armChannel.sampler].output];
      const armView = json.bufferViews[armAccessor.bufferView];
      const jsonView = new DataView(bytes);
      const binaryOffset = 20 + jsonView.getUint32(12, true) + 8;
      const armValues = new Float32Array(bytes, binaryOffset + (armView.byteOffset || 0) + (armAccessor.byteOffset || 0), armAccessor.count * 4);

      // Reimport and sample the actual exported animation, not just its names.
      const reimported = await new GLTFLoader().parseAsync(bytes, '');
      const clip = reimported.animations[0];
      const mixer = new AnimationMixer(reimported.scene);
      mixer.clipAction(clip).play();
      const sampleTime = clip.duration / 2;
      mixer.setTime(sampleTime);
      const samplesMatch = clip.tracks.every((track) => {
        const parsed = PropertyBinding.parseTrackName(track.name);
        const target = PropertyBinding.findNode(reimported.scene, parsed.nodeName);
        if (!target?.isBone) return false;
        const expected = track.createInterpolant().evaluate(sampleTime);
        const actual = target[parsed.propertyName].toArray();
        return expected.every((value, index) => Math.abs(value - actual[index]) < 1e-5);
      });
      const take = window.p2r.takes.at(-1);
      const referenceClip = trackToClip(window.p2r.rig, take.best, 'reference');
      const reference = clone(window.p2r.rig.model);
      const referenceMixer = new AnimationMixer(reference);
      referenceMixer.clipAction(referenceClip).play();
      const referenceMeshes = [];
      const reimportedMeshes = [];
      reference.traverse((object) => { if (object.isSkinnedMesh) referenceMeshes.push(object); });
      reimported.scene.traverse((object) => { if (object.isSkinnedMesh) reimportedMeshes.push(object); });
      let worldVerticesMatch = referenceMeshes.length === reimportedMeshes.length;
      let worldBonesMatch = true;
      const a = new Vector3(), b = new Vector3();
      for (const time of [0, clip.duration / 2, clip.duration * 0.9]) {
        mixer.setTime(time); referenceMixer.setTime(time);
        reimported.scene.updateMatrixWorld(true); reference.updateMatrixWorld(true);
        reference.traverse((object) => {
          if (!object.isBone) return;
          const target = reimported.scene.getObjectByName(object.name);
          if (!target || object.getWorldPosition(a).distanceTo(target.getWorldPosition(b)) > 5e-5) worldBonesMatch = false;
        });
        referenceMeshes.forEach((mesh, index) => {
          const target = reimportedMeshes[index];
          const count = mesh.geometry.attributes.position.count;
          if (!target || target.geometry.attributes.position.count !== count) { worldVerticesMatch = false; return; }
          for (let vertex = 0; vertex < count; vertex += Math.max(1, Math.floor(count / 40))) {
            mesh.getVertexPosition(vertex, a).applyMatrix4(mesh.matrixWorld);
            target.getVertexPosition(vertex, b).applyMatrix4(target.matrixWorld);
            if (a.distanceTo(b) > 5e-5) worldVerticesMatch = false;
          }
        });
      }
      const names = [];
      window.p2r.rig.model.traverse((object) => { if (object.isBone) names.push(object.name); });
      return {
        sourceSkeleton: skeleton(source), exportedSkeleton: skeleton(json), runtimeNames: names,
        sameBytes: downloaded.length === saved.length && downloaded.every((value, index) => value === saved[index]),
        animationTargets: animation.channels.map(({ target }) => `${json.nodes[target.node].name}.${target.path}`).sort(),
        expectedTargets: [...window.p2r.rig.order.map((name) => `mixamorig:${name}.rotation`), 'mixamorig:Hips.translation'].sort(),
        reimportedTrackCount: clip.tracks.length, samplesMatch,
        allUnitScales: json.nodes.every((node) => (node.scale || [1, 1, 1]).every((value) => value === 1)),
        runtimeScalesUnchanged: window.__p2rExportState() === window.__p2rBeforeExportState,
        worldVerticesMatch, worldBonesMatch,
        armMoves: armValues.slice(0, 4).some((value, index) => Math.abs(value - armValues[4 + index]) > 1e-5),
      };
    });
    assert.equal(exported.sameBytes, true, 'download and saved take must contain identical GLB bytes');
    assert.equal(exported.sourceSkeleton.length, 67);
    assert.deepEqual(exported.exportedSkeleton, exported.sourceSkeleton, 'all source bone names and hierarchy must survive export');
    assert.deepEqual(exported.runtimeNames, runtimeNames, 'export must not rename runtime bones');
    assert.deepEqual(exported.animationTargets, exported.expectedTargets, 'animation channels must still target the intended bones');
    assert.equal(exported.reimportedTrackCount, exported.expectedTargets.length);
    assert.equal(exported.armMoves, true, 'the exported fixture must contain actual motion');
    assert.equal(exported.samplesMatch, true, 'reimported animation must bind and sample every bone track');
    assert.equal(exported.allUnitScales, true, 'all exported objects and bones must have unit scale');
    assert.equal(exported.runtimeScalesUnchanged, true, 'normalization must not modify runtime scales or inverse bind matrices');
    assert.equal(exported.worldBonesMatch, true, 'bone positions and root motion must retain their world-space size');
    assert.equal(exported.worldVerticesMatch, true, 'skinned deformation must remain unchanged throughout the animation');
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
