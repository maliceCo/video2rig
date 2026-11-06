import { AttachedBindMode, Matrix4, PropertyBinding } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { copyOriginalBoneName } from './export-names.js';

/** Remove static, positive uniform scales on a copy, preserving world-space motion. */
export function prepareUnitScaleExport(model, clip) {
  const originals = [];
  const parentScales = new Map();
  const worldScales = new Map();
  let problem = '';
  const collect = (object, parentScale) => {
    originals.push(object);
    const { x, y, z } = object.scale;
    const max = Math.max(x, y, z);
    if (![x, y, z].every((value) => Number.isFinite(value) && value > 0)
      || max - Math.min(x, y, z) > max * 1e-6) {
      problem ||= `non-uniform or non-positive scale on ${object.name || object.type}`;
    }
    // Ignore the tiny per-axis differences introduced by matrix decomposition.
    const worldScale = parentScale * ((x + y + z) / 3);
    if (!Number.isFinite(worldScale) || worldScale <= 0) problem ||= 'invalid cumulative scale';
    parentScales.set(object, parentScale);
    worldScales.set(object, worldScale);
    for (const child of object.children) collect(child, worldScale);
  };
  collect(model, 1);
  for (const object of originals) {
    if (object.isInstancedMesh) problem ||= 'instanced meshes';
    if (!object.isSkinnedMesh) continue;
    if (object.bindMode !== AttachedBindMode) problem ||= 'detached skin binding';
    if (object.skeleton.bones.some((bone) => !worldScales.has(bone))) problem ||= 'bones outside the exported model';
  }
  const positionScales = new Map();
  for (const track of clip.tracks) {
    const parsed = PropertyBinding.parseTrackName(track.name);
    if (parsed.propertyName === 'scale') problem ||= 'animated scale tracks';
    if (parsed.propertyName !== 'position') continue;
    const target = PropertyBinding.findNode(model, parsed.nodeName);
    if (!parentScales.has(target) || parsed.objectName) problem ||= `unsupported position track ${track.name}`;
    else positionScales.set(track.name, parentScales.get(target));
  }
  // Do not silently damage custom rigs whose transforms cannot be normalized this way.
  if (problem) return { model, clip, warning: `export scale not normalized (${problem}); original transforms preserved` };

  const exportedModel = clone(model);
  const copies = [];
  exportedModel.traverse((object) => copies.push(object));
  const scaleMatrix = new Matrix4();
  originals.forEach((source, index) => {
    const target = copies[index];
    copyOriginalBoneName(source, target);
    target.position.multiplyScalar(parentScales.get(source));
    target.scale.setScalar(1);
    target.updateMatrix();
    if (target.isSkinnedMesh) {
      // W' = W * S^-1, so B' = S * B keeps W' * B' (and every skinned vertex) unchanged.
      target.skeleton.boneInverses = source.skeleton.boneInverses.map((inverse, boneIndex) => {
        const scale = worldScales.get(source.skeleton.bones[boneIndex]);
        return inverse.clone().premultiply(scaleMatrix.makeScale(scale, scale, scale));
      });
      target.boundingBox = null;
      target.boundingSphere = null;
    } else if (target.geometry && worldScales.get(source) !== 1) {
      const scale = worldScales.get(source);
      target.geometry = source.geometry.clone();
      target.geometry.applyMatrix4(scaleMatrix.makeScale(scale, scale, scale));
      for (const attribute of target.geometry.morphAttributes.position || []) attribute.applyMatrix4(scaleMatrix);
      target.geometry.boundingBox = null;
      target.geometry.boundingSphere = null;
    }
  });
  exportedModel.updateMatrixWorld(true);
  const exportedClip = clip.clone();
  for (const track of exportedClip.tracks) {
    const scale = positionScales.get(track.name);
    if (scale !== undefined) for (let i = 0; i < track.values.length; i++) track.values[i] *= scale;
  }
  return { model: exportedModel, clip: exportedClip, warning: null };
}
