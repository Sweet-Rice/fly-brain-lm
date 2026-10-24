import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildMapping, firePairs } from '../harness/app/vibe2/mapping.js';
import { buildBrainGraph, BrainActivity, curvePoint } from '../frontend/src/brain/graph.ts';
const atlas = JSON.parse(fs.readFileSync(new URL('../frontend/public/brain/regions.json', import.meta.url)));
const recording = JSON.parse(fs.readFileSync(new URL('../frontend/public/brain/recorded-preview.json', import.meta.url)));

test('trained browser mapping and every golden inference fire fit the 3D graph', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../frontend/public/models/vibe2-tinystories/manifest.json', import.meta.url)));
  const golden = JSON.parse(fs.readFileSync(new URL('../frontend/public/models/vibe2-tinystories/golden.json', import.meta.url)));
  const { message, kcPairs } = buildMapping(manifest);
  const graph = buildBrainGraph(message, atlas);
  assert.equal(graph.nodes.length, 1959);
  assert.equal(graph.edges.length, 19037);
  assert.ok(graph.nodes.every(node => node.position.every(Number.isFinite)));
  const indices = new Map(graph.edges.map((edge, i) => [`${edge.source}:${edge.target}`, i]));
  const activity = new BrainActivity(graph);
  for (const [t, step] of golden.steps.entries()) {
    const pairs = firePairs(kcPairs, step.active_kcs);
    assert.equal(activity.fire(pairs, t), true);
    for (const [source, target] of pairs) {
      const index = indices.get(`${source}:${target}`);
      assert.notEqual(index, undefined);
      assert.equal(activity.edges[index], t);
    }
  }
});
test('real reference graph preserves sparse IDs, topology, and finite 3D routes', () => {
  const graph = buildBrainGraph(recording.mapping, atlas);
  assert.equal(graph.nodes.length, 1958); assert.equal(graph.edges.length, 19037);
  assert.equal(graph.slots.size, graph.nodes.length);
  for (const [i, e] of graph.edges.entries()) {
    assert.deepEqual([e.source, e.target], recording.mapping.edges[i]);
    assert.deepEqual(curvePoint(e.points, 0), graph.nodes[graph.slots.get(e.source)].position);
    assert.deepEqual(curvePoint(e.points, 1), graph.nodes[graph.slots.get(e.target)].position);
    assert.ok(e.points.flat().every(Number.isFinite));
  }
  assert.deepEqual(buildBrainGraph(recording.mapping, atlas).nodes, graph.nodes);
});
test('fires follow declared direction, reject absent edges, and reset with mapping', () => {
  const mapping = { groups: [{ id: 7, name: 'Glomerulus' }, { id: 9, name: 'KC_gamma' }], nodes: [{ id: 100, group: 7 }, { id: 9001, group: 9 }], edges: [[100, 9001]] };
  const graph = buildBrainGraph(mapping, atlas); const activity = new BrainActivity(graph);
  assert.equal(activity.fire([[9001, 100], [100, 9999]], 5), false);
  assert.equal(activity.deadline, -Infinity);
  assert.equal(activity.fire([[100, 9001]], 7), true);
  assert.equal(activity.edges[0], 7); assert.deepEqual([...activity.nodes], [7, 7]);
  assert.ok(activity.deadline > 7);
  assert.equal(new BrainActivity(graph).edges[0], -100);
});
test('neuron samples stay inside their assigned region bounds and anatomy includes both hemispheres', () => {
  assert.equal(Object.keys(atlas.regions).length, 79);
  for (const key of ['Whole_brain', 'MB_CA_R', 'MB_CA_L', 'AL_R', 'AL_L', 'ME_R', 'ME_L']) assert.ok(atlas.regions[key]);
  for (const n of buildBrainGraph(recording.mapping, atlas).nodes) {
    const name = n.group === 'Glomerulus' ? 'AL_R' : n.group.startsWith('KC_') ? 'MB_CA_R' : n.id % 2 ? 'MB_VL_R' : 'MB_ML_R';
    const r = atlas.regions[name];
    n.position.forEach((v, a) => assert.ok(v >= r.min[a] && v <= r.max[a]));
  }
});
