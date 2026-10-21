import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildGraph, buildSelectionGeometry } from '../layout.js';

const mapping = {
  groups: [{ id: 17, name: 'Output' }, { id: 4, name: 'Input' }, { id: 90, name: 'Empty' }],
  nodes: [{ id: 90001, group: 17 }, { id: 6, group: 4 }, { id: 2, group: 17 }],
  edges: [[6, 90001], [90001, 6], [2, 2]],
};

function checkGeometry(graph) {
  for (const vertices of [graph.nodes, graph.edges]) {
    assert.ok(vertices instanceof Float32Array);
    assert.equal(vertices.length % 21, 0);
    for (let i = 0; i < vertices.length; i += 7) {
      const [x, y, r, g, b, a, edgeIndex] = vertices.subarray(i, i + 7);
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      assert.ok(x >= graph.bounds.minX - 0.001 && x <= graph.bounds.maxX + 0.001);
      assert.ok(y >= graph.bounds.minY - 0.001 && y <= graph.bounds.maxY + 0.001);
      assert.ok([r, g, b, a].every(value => value >= 0 && value <= 1));
      assert.ok(Number.isInteger(edgeIndex));
      assert.ok(vertices === graph.nodes ? edgeIndex === -1 : edgeIndex >= 0 && edgeIndex < graph.edgeCount);
    }
  }
  assert.ok(Object.values(graph.bounds).every(Number.isFinite));
  assert.ok(graph.bounds.maxX > graph.bounds.minX);
  assert.ok(graph.bounds.maxY > graph.bounds.minY);
}

test('layout respects group order, sorts sparse ids, and does not mutate the mapping', () => {
  const original = structuredClone(mapping);
  const graph = buildGraph(mapping);
  checkGeometry(graph);
  assert.deepEqual(mapping, original);
  assert.deepEqual(graph.labels.map(label => label.id), [17, 4, 90]);
  assert.ok(graph.labels.every(label => label.width >= 140));
  assert.ok(graph.labels[0].x < graph.labels[1].x && graph.labels[1].x < graph.labels[2].x);
  assert.equal(graph.nodeCount, 3);
  assert.equal(graph.edgeCount, 3);
  assert.equal(graph.nodes.length, 3 * 12 * 21);
  assert.deepEqual(graph, buildGraph(mapping));
  assert.deepEqual(graph, buildGraph({ ...mapping, nodes: [...mapping.nodes].reverse() }));
  // Each circle begins with its center; node 2 precedes node 90001 in their group.
  assert.ok(graph.nodes[1] < graph.nodes[12 * 21 + 1]);
  assert.deepEqual([...graph.nodes.subarray(2, 5)], graph.labels[0].color.map(Math.fround));
});

test('each directed edge has a shaft and a destination arrowhead in source color', () => {
  const graph = buildGraph({ ...mapping, edges: [[6, 90001]] });
  assert.equal(graph.edges.length, 3 * 21);
  const arrowTip = [...graph.edges.subarray(42, 44)];
  const destination = [...graph.nodes.subarray(12 * 21, 12 * 21 + 2)];
  assert.ok(Math.abs(Math.hypot(arrowTip[0] - destination[0], arrowTip[1] - destination[1]) - 3) < 0.001);
  assert.deepEqual([...graph.edges.subarray(2, 5)], graph.labels[1].color.map(Math.fround));
  assert.ok(graph.edges[47] > graph.edges[5]);
});

test('self edges form a visible loop and arrow without NaNs', () => {
  const graph = buildGraph({ ...mapping, edges: [[2, 2]] });
  checkGeometry(graph);
  assert.equal(graph.edges.length, (16 * 2 + 1) * 21);
  const centerY = graph.nodes[1];
  const ys = [];
  for (let i = 1; i < graph.edges.length; i += 7) ys.push(graph.edges[i]);
  assert.ok(Math.min(...ys) < centerY - 15);
});

test('all shaft, arrow, and loop vertices retain their directed mapping edge index', () => {
  const graph = buildGraph(mapping);
  assert.deepEqual(graph.edgePairs, mapping.edges);
  const indices = [];
  for (let i = 6; i < graph.edges.length; i += 7) indices.push(graph.edges[i]);
  assert.deepEqual(indices, [
    ...Array(9).fill(0), ...Array(9).fill(1), ...Array(99).fill(2),
  ]);
});

test('empty networks, empty groups, and isolated nodes have valid bounds', () => {
  for (const empty of [
    { groups: [], nodes: [], edges: [] },
    { groups: mapping.groups, nodes: [], edges: [] },
    { ...mapping, edges: [] },
  ]) {
    const graph = buildGraph(empty);
    checkGeometry(graph);
    assert.equal(graph.edgeCount, 0);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.nodeCount, empty.nodes.length);
  }
});

test('bundled recording draws every declared node and edge deterministically', () => {
  const capture = JSON.parse(readFileSync(new URL('../../example/once_upon_a_time.ndjson', import.meta.url), 'utf8').split(/\r?\n/)[0]);
  const graph = buildGraph(capture);
  checkGeometry(graph);
  assert.equal(graph.nodeCount, 1958);
  assert.equal(graph.edgeCount, 19037);
  assert.equal(graph.labels.length, 5);
  assert.equal(graph.nodes.length, 1958 * 12 * 21);
  const selfEdges = capture.edges.filter(([a, b]) => a === b).length;
  assert.equal(graph.edges.length, ((19037 - selfEdges) * 3 + selfEdges * 33) * 21);
  assert.deepEqual(graph, buildGraph(capture));
});

test('buildGraph exposes positions map with coordinates and color for picking', () => {
  const graph = buildGraph(mapping);
  assert.ok(graph.positions instanceof Map);
  assert.equal(graph.positions.size, 3);
  for (const id of [90001, 6, 2]) {
    assert.ok(graph.positions.has(id));
    const pos = graph.positions.get(id);
    assert.ok(Number.isFinite(pos.x));
    assert.ok(Number.isFinite(pos.y));
    assert.equal(pos.color.length, 3);
    assert.ok(pos.color.every(Number.isFinite));
  }
  const emptyGraph = buildGraph({ groups: [], nodes: [], edges: [] });
  assert.ok(emptyGraph.positions instanceof Map);
  assert.equal(emptyGraph.positions.size, 0);
});

test('buildSelectionGeometry generates valid triangles for ring, incident edges, and neighbors', () => {
  const graph = buildGraph(mapping);
  const overlay = buildSelectionGeometry(graph, 2);
  assert.ok(overlay instanceof Float32Array);
  assert.ok(overlay.length > 0);
  assert.equal(overlay.length % 21, 0, 'must contain complete triangles');
  for (let i = 0; i < overlay.length; i += 7) {
    assert.ok(Number.isFinite(overlay[i]), 'x coordinate must be finite');
    assert.ok(Number.isFinite(overlay[i + 1]), 'y coordinate must be finite');
    assert.equal(overlay[i + 6], -1, 'selection overlay vertex must use edgeIndex -1');
  }
  const missing = buildSelectionGeometry(graph, 999999);
  assert.equal(missing.length, 0);
  const noGraph = buildSelectionGeometry(null, 2);
  assert.equal(noGraph.length, 0);
});
