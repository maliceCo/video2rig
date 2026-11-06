import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rememberOriginalBoneNames, copyOriginalBoneName, originalBoneNamesPlugin } from '../public/export-names.js';

const bone = (name, userData = {}) => Object.freeze({ isBone: true, name, userData: Object.freeze(userData) });
const model = (objects) => ({ traverse(callback) { objects.forEach(callback); } });
const exportedName = (plugin, object) => {
  const node = { name: object.name };
  plugin.writeNode(object, node);
  return node.name;
};

test('GLTF export restores exact source names for body, fingers, and auxiliary bones', () => {
  const names = ['mixamorig:Hips', 'mixamorig:LeftHandIndex3', 'mixamorig:HeadTop_End', 'mixamorig1:RightToe_End', 'Spine', 'mixamorig_LeftArm'];
  const bones = names.map((name) => bone(name.replaceAll(':', '')));
  const parser = {
    associations: new Map(bones.map((object, nodes) => [object, { nodes }])),
    json: { nodes: names.map((name) => ({ name })) },
  };
  rememberOriginalBoneNames(model(bones), parser);
  const plugin = originalBoneNamesPlugin();
  assert.deepEqual(bones.map((object) => exportedName(plugin, object)), names);
  assert.deepEqual(bones.map((object) => object.name), names.map((name) => name.replaceAll(':', '')));
});

test('GLTF uses source node names rather than stale or conflicting extras', () => {
  const hips = bone('mixamorigHips', { name: 'stale:Hips', originalName: 'wrong:Hips' });
  rememberOriginalBoneNames(model([hips]), {
    associations: new Map([[hips, { nodes: 0 }]]),
    json: { nodes: [{ name: 'mixamorig:Hips', extras: hips.userData }] },
  });
  assert.equal(exportedName(originalBoneNamesPlugin(), hips), 'mixamorig:Hips');
  assert.equal(hips.userData.name, 'stale:Hips');
});

test('FBX export restores original names without inventing a namespace', () => {
  const names = ['mixamorig:Hips', 'mixamorig2:LeftHandThumb1', 'RightHand', 'mixamorig_LeftArm'];
  const bones = names.map((name) => bone(name.replaceAll(':', ''), { originalName: name }));
  rememberOriginalBoneNames(model(bones));
  const plugin = originalBoneNamesPlugin();
  assert.deepEqual(bones.map((object) => exportedName(plugin, object)), names);
});

test('missing or empty originals leave runtime names unchanged', () => {
  const bones = [bone('mixamorigHips'), bone('Head', { originalName: '' }), bone('LeftArm', { originalName: 12 })];
  rememberOriginalBoneNames(model(bones));
  const gltfBone = bone('RightArm', { name: 'untrusted:RightArm' });
  rememberOriginalBoneNames(model([gltfBone]), { associations: new Map(), json: { nodes: [] } });
  const plugin = originalBoneNamesPlugin();
  for (const object of [...bones, gltfBone]) assert.equal(exportedName(plugin, object), object.name);
});

test('non-bone names are not restored', () => {
  const mesh = Object.freeze({ name: 'Mesh', userData: { originalName: 'original:Mesh' } });
  rememberOriginalBoneNames(model([mesh]));
  assert.equal(exportedName(originalBoneNamesPlugin(), mesh), 'Mesh');
});

test('names belong to bone objects, even when sanitized names collide', () => {
  const first = bone('abHips', { originalName: 'a:bHips' });
  const second = bone('abHips', { originalName: 'ab:Hips' });
  rememberOriginalBoneNames(model([first, second]));
  for (let i = 0; i < 2; i++) {
    const plugin = originalBoneNamesPlugin();
    assert.equal(exportedName(plugin, first), 'a:bHips');
    assert.equal(exportedName(plugin, second), 'ab:Hips');
    assert.equal(first.name, 'abHips');
    assert.equal(second.name, 'abHips');
  }
});

test('export clones retain the recorded name without relying on their extras', () => {
  const source = bone('mixamorigHips', { originalName: 'mixamorig:Hips' });
  const copy = bone('mixamorigHips', { originalName: 'stale:Hips' });
  rememberOriginalBoneNames(model([source]));
  copyOriginalBoneName(source, copy);
  assert.equal(exportedName(originalBoneNamesPlugin(), copy), 'mixamorig:Hips');
  assert.equal(source.name, 'mixamorigHips');
  assert.equal(copy.name, 'mixamorigHips');
});
