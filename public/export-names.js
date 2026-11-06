// Keep source names separate from Three.js names, which strip characters such as ':'.
const originalBoneNames = new WeakMap();

/** Remember every bone's source name without changing runtime animation bindings. */
export function rememberOriginalBoneNames(model, parser = null) {
  model.traverse((object) => {
    if (!object.isBone) return;
    const nodeIndex = parser?.associations.get(object)?.nodes;
    // GLTF source JSON is authoritative: extras may overwrite userData.name.
    const name = parser ? parser.json.nodes?.[nodeIndex]?.name : object.userData.originalName;
    if (typeof name === 'string' && name) originalBoneNames.set(object, name);
  });
}

/** Carry source names onto an export-only clone without trusting copied extras. */
export function copyOriginalBoneName(source, target) {
  const name = originalBoneNames.get(source);
  if (name !== undefined) originalBoneNames.set(target, name);
}

/** GLTFExporter plugin: rename serialized nodes only, not objects or animation tracks. */
export function originalBoneNamesPlugin() {
  return {
    name: 'OriginalBoneNames',
    writeNode(object, nodeDef) {
      const name = originalBoneNames.get(object);
      if (name !== undefined) nodeDef.name = name;
    },
  };
}
