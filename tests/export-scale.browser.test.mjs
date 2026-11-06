import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const executable = process.env.P2R_BROWSER_EXECUTABLE;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('unit-scale export preserves GLTF and FBX skinning, static meshes, morphs, and motion', {
  skip: !executable && 'set P2R_BROWSER_EXECUTABLE to run the browser integration test',
  timeout: 120000,
}, async (t) => {
  let puppeteer;
  try { ({ default: puppeteer } = await import('puppeteer-core')); }
  catch { return t.skip('install puppeteer-core to run the browser integration test'); }
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"}}</script>');
    }
    if (!['/export-scale.js', '/export-names.js'].includes(req.url)) return res.writeHead(404).end();
    try {
      const data = await fs.readFile(path.join(ROOT, 'public', req.url.slice(1)));
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(data);
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: executable, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
    const results = await page.evaluate(async () => {
      const THREE = await import('three');
      const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { prepareUnitScaleExport } = await import('/export-scale.js');
      const { rememberOriginalBoneNames, originalBoneNamesPlugin } = await import('/export-names.js');
      const makeRig = (format) => {
        const root = new THREE.Group(); root.name = 'Character';
        root.scale.setScalar(format === 'gltf' ? 0.01 : 1);
        const hips = new THREE.Bone(); hips.name = 'mixamorigHips'; hips.position.y = 100;
        const head = new THREE.Bone(); head.name = 'mixamorigHead'; head.position.y = 80; head.scale.setScalar(2);
        hips.userData.originalName = 'mixamorig:Hips'; head.userData.originalName = 'mixamorig:Head';
        hips.add(head); root.add(hips);
        const geometry = new THREE.BufferGeometry();
        const unit = format === 'gltf' ? 1 : 100;
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.5, 0, 0.1, 1.2, 0, -0.1, 1.8, 0].map((value) => value * unit), 3));
        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], 4));
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([0.25, 0.75, 0, 0, 0.4, 0.6, 0, 0, 0.1, 0.9, 0, 0], 4));
        geometry.computeVertexNormals();
        const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial()); mesh.name = 'Body';
        if (format === 'fbx') mesh.position.x = 20;
        root.add(mesh); root.updateMatrixWorld(true);
        const skeleton = new THREE.Skeleton([hips, head]);
        mesh.bind(skeleton, format === 'gltf' ? new THREE.Matrix4() : mesh.matrixWorld.clone());
        // FBX is converted to meters after the loader has already bound its centimeter-sized mesh.
        root.scale.setScalar(0.01); root.position.set(2, 0.3, -3); root.rotation.y = 0.2;
        const accessoryGeometry = new THREE.BufferGeometry();
        accessoryGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 2, 0, -1, 0, 0], 3));
        accessoryGeometry.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0.2, 0, 0, 0.2, 0, 0, 0.2, 0], 3)];
        accessoryGeometry.morphTargetsRelative = true; accessoryGeometry.computeVertexNormals();
        const accessory = new THREE.Mesh(accessoryGeometry, new THREE.MeshStandardMaterial()); accessory.name = 'Accessory';
        accessory.position.set(5, 90, 0); accessory.scale.setScalar(3); accessory.morphTargetInfluences[0] = 0.4;
        head.add(accessory); root.updateMatrixWorld(true);
        rememberOriginalBoneNames(root);
        const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.45).toArray();
        const clip = new THREE.AnimationClip('motion', 2, [
          new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 1, 2], [0, 0, 0, 1, ...turn, 0, 0, 0, 1]),
          new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1, 2], [0, 100, 0, 30, 115, -20, 0, 100, 0]),
        ]);
        return { root, clip };
      };
      const state = (root, clip) => {
        const objects = [];
        root.traverse((object) => objects.push({
          name: object.name, position: object.position.toArray(), rotation: object.quaternion.toArray(), scale: object.scale.toArray(),
          geometry: object.geometry && Array.from(object.geometry.attributes.position.array),
          morphs: object.geometry?.morphAttributes.position?.map((attribute) => Array.from(attribute.array)),
          inverses: object.skeleton?.boneInverses.map((inverse) => inverse.toArray()),
        }));
        return JSON.stringify([objects, clip.tracks.map((track) => Array.from(track.values))]);
      };
      const matches = (source, target) => {
        const a = new THREE.Vector3(), b = new THREE.Vector3();
        let equal = true;
        source.traverse((object) => {
          if (!object.isBone && !object.geometry) return;
          const copy = target.getObjectByName(object.name);
          if (!copy) { equal = false; return; }
          if (object.isBone && object.getWorldPosition(a).distanceTo(copy.getWorldPosition(b)) > 5e-5) equal = false;
          if (!object.geometry) return;
          for (let index = 0; index < object.geometry.attributes.position.count; index++) {
            object.getVertexPosition(index, a).applyMatrix4(object.matrixWorld);
            copy.getVertexPosition(index, b).applyMatrix4(copy.matrixWorld);
            if (a.distanceTo(b) > 5e-5) equal = false;
          }
        });
        return equal;
      };
      const cases = [];
      for (const format of ['gltf', 'fbx']) {
        const { root, clip } = makeRig(format);
        const before = state(root, clip);
        const restBounds = new THREE.Box3().setFromObject(root);
        const exported = prepareUnitScaleExport(root, clip);
        const unchanged = state(root, clip) === before;
        const bounds = new THREE.Box3().setFromObject(exported.model);
        let unitScales = true;
        exported.model.traverse((object) => { if (!object.scale.equals(new THREE.Vector3(1, 1, 1))) unitScales = false; });
        const mixer = new THREE.AnimationMixer(root); mixer.clipAction(clip).play();
        const exportMixer = new THREE.AnimationMixer(exported.model); exportMixer.clipAction(exported.clip).play();
        let motionMatches = true;
        for (const time of [0, 0.4, 1.5]) {
          mixer.setTime(time); exportMixer.setTime(time);
          root.updateMatrixWorld(true); exported.model.updateMatrixWorld(true);
          motionMatches &&= matches(root, exported.model);
        }
        const bytes = await new GLTFExporter().register(originalBoneNamesPlugin).parseAsync(exported.model, { binary: true, animations: [exported.clip] });
        const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, new DataView(bytes).getUint32(12, true))));
        const reimported = await new GLTFLoader().parseAsync(bytes, '');
        const reimportedMixer = new THREE.AnimationMixer(reimported.scene); reimportedMixer.clipAction(reimported.animations[0]).play();
        let roundTripMatches = true;
        for (const time of [0, 0.4, 1.5]) {
          mixer.setTime(time); reimportedMixer.setTime(time);
          root.updateMatrixWorld(true); reimported.scene.updateMatrixWorld(true);
          roundTripMatches &&= matches(root, reimported.scene);
        }
        cases.push({
          format, warning: exported.warning, unchanged, unitScales, motionMatches, roundTripMatches,
          boundsMatch: bounds.min.distanceTo(restBounds.min) < 5e-5 && bounds.max.distanceTo(restBounds.max) < 5e-5,
          exportedUnitScales: json.nodes.every((node) => (node.scale || [1, 1, 1]).every((value) => value === 1)),
          boneNames: json.skins[0].joints.map((index) => json.nodes[index].name),
        });
      }
      const fallbacks = [];
      for (const scale of [[1, 2, 1], [-1, -1, -1], [0, 0, 0]]) {
        const { root, clip } = makeRig('gltf'); root.scale.fromArray(scale);
        const before = state(root, clip);
        const exported = prepareUnitScaleExport(root, clip);
        fallbacks.push(!!exported.warning && exported.model === root && exported.clip === clip && before === state(root, clip));
      }
      const { root, clip } = makeRig('gltf');
      clip.tracks.push(new THREE.VectorKeyframeTrack('mixamorigHips.scale', [0, 1], [1, 1, 1, 2, 2, 2]));
      const fallback = prepareUnitScaleExport(root, clip);
      fallbacks.push(!!fallback.warning && fallback.model === root && fallback.clip === clip);
      for (const kind of ['detached', 'external-bone', 'instanced']) {
        const { root, clip } = makeRig('gltf');
        const body = root.getObjectByName('Body');
        if (kind === 'detached') body.bindMode = THREE.DetachedBindMode;
        if (kind === 'external-bone') body.skeleton.bones[1].removeFromParent();
        if (kind === 'instanced') root.add(new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 1));
        const before = state(root, clip);
        const exported = prepareUnitScaleExport(root, clip);
        fallbacks.push(!!exported.warning && exported.model === root && exported.clip === clip && before === state(root, clip));
      }
      return { cases, fallbacks };
    });
    for (const result of results.cases) {
      assert.equal(result.warning, null, `${result.format}: normalization must be supported`);
      for (const key of ['unchanged', 'unitScales', 'motionMatches', 'roundTripMatches', 'boundsMatch', 'exportedUnitScales']) {
        assert.equal(result[key], true, `${result.format}: ${key}`);
      }
      assert.deepEqual(result.boneNames, ['mixamorig:Hips', 'mixamorig:Head']);
    }
    assert.equal(results.fallbacks.every(Boolean), true, 'unsupported scales must preserve the original export and report a warning');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
