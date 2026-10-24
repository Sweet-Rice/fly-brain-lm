// Run after `npm --prefix frontend ci`. Inputs are pinned in assets/brain/README.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as THREE from '../frontend/node_modules/three/build/three.module.js';
import { PLYLoader } from '../frontend/node_modules/three/examples/jsm/loaders/PLYLoader.js';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'assets/brain/source');
const out = path.join(root, 'frontend/public/brain');
fs.mkdirSync(out, { recursive: true });
const loader = new PLYLoader();
function read(file) {
  const b = fs.readFileSync(file);
  return loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
const shell = read(path.join(source, 'FLYWIRE_whole_brain.ply'));
shell.computeBoundingBox();
const center = shell.boundingBox.getCenter(new THREE.Vector3());
const scale = 6 / shell.boundingBox.getSize(new THREE.Vector3()).x;
const transform = new THREE.Matrix4().set(
  scale, 0, 0, -center.x * scale,
  0, -scale, 0, center.y * scale,
  0, 0, -scale, center.z * scale,
  0, 0, 0, 1,
);
const gltf = { asset: { version: '2.0', generator: 'Fly Brain LM scientific mesh packer' },
  scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [],
  accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
const chunks = [];
let byteLength = 0;
function accessor(array, type, componentType, bounds) {
  const data = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4); data.copy(padded);
  gltf.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length });
  chunks.push(padded); byteLength += padded.length;
  gltf.accessors.push({ bufferView: gltf.bufferViews.length - 1, componentType,
    count: array.length / (type === 'VEC3' ? 3 : 1), type, ...bounds });
  return gltf.accessors.length - 1;
}
let seed = 719;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
const regions = {};
const colorFor = name => name.startsWith('AL_') ? [0.43, 0.87, 0.5] :
  name.startsWith('MB_CA') ? [0.23, 0.84, 0.95] : name.startsWith('MB_') ? [0.94, 0.64, 0.26] :
  /^(ME|LO|LOP|LA)_/.test(name) ? [0.25, 0.42, 0.62] : [0.27, 0.52, 0.57];
function add(name, geometry) {
  geometry.applyMatrix4(transform); geometry.computeVertexNormals(); geometry.computeBoundingBox();
  const bbox = geometry.boundingBox;
  const color = name === 'Whole_brain' ? [0.17, 0.36, 0.45] : colorFor(name);
  const position = accessor(new Float32Array(geometry.attributes.position.array), 'VEC3', 5126,
    { min: bbox.min.toArray(), max: bbox.max.toArray() });
  const normal = accessor(new Float32Array(geometry.attributes.normal.array), 'VEC3', 5126);
  const indices = accessor(new Uint32Array(geometry.index.array), 'SCALAR', 5125);
  gltf.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [...color, name === 'Whole_brain' ? 0.07 : 0.16], metallicFactor: 0.1, roughnessFactor: 0.55 }, alphaMode: 'BLEND', doubleSided: true });
  gltf.meshes.push({ name, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices, material: gltf.materials.length - 1 }] });
  gltf.nodes.push({ name, mesh: gltf.meshes.length - 1 }); gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  const samples = [];
  // Region interiors, rather than synthetic ellipsoids. These are display coordinates,
  // NOT measurements of model neurons or cross-connectome registration.
  if (/^(AL_|MB_)/.test(name)) {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    const direction = new THREE.Vector3(1, 0.031, 0.017).normalize();
    for (let attempt = 0; samples.length < 768 && attempt < 30000; attempt++) {
      const p = new THREE.Vector3(...[0, 1, 2].map(i => bbox.min.getComponent(i) + random() * (bbox.max.getComponent(i) - bbox.min.getComponent(i))));
      ray.set(p, direction);
      if (ray.intersectObject(mesh).length % 2 === 1) samples.push(p.toArray().map(v => +v.toFixed(6)));
    }
    mesh.material.dispose();
    if (samples.length < 100) throw new Error(`Insufficient interior samples for ${name}`);
  }
  regions[name] = { center: bbox.getCenter(new THREE.Vector3()).toArray(), min: bbox.min.toArray(), max: bbox.max.toArray(), color, samples };
}
add('Whole_brain', shell);
for (const file of fs.readdirSync(path.join(source, 'neuropils')).filter(n => n.endsWith('.ply')).sort())
  add(path.basename(file, '.ply'), read(path.join(source, 'neuropils', file)));
gltf.buffers[0].byteLength = byteLength;
const json = Buffer.from(JSON.stringify(gltf));
const jp = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(jp);
const bin = Buffer.concat(chunks);
const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jp.length + bin.length, 8); header.writeUInt32LE(jp.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(path.join(out, 'flywire-brain.glb'), Buffer.concat([header, jp, bh, bin]));
fs.writeFileSync(path.join(out, 'regions.json'), JSON.stringify({ coordinateNote: 'FlyWire anatomical context; illustrative model placement, not registered MaleCNS coordinates.', sourceCenter: center.toArray(), scale, regions }));
const hashes = Object.fromEntries(['FLYWIRE_whole_brain.ply', 'JFRC2NP.surf.fw.zip'].map(n => [n, crypto.createHash('sha256').update(fs.readFileSync(path.join(source, n))).digest('hex')]));
fs.writeFileSync(path.join(out, 'source-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(out, 'LICENSE'));
fs.copyFileSync(path.join(root, 'assets/brain/README.md'), path.join(out, 'ATTRIBUTION.md'));
console.log(`Packed ${gltf.meshes.length} meshes, ${(bin.length / 1e6).toFixed(2)} MB geometry`);
