import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildGraph,
  buildSelectionGeometry,
  computeEdgePath,
  RADIUS,
} from '../layout.js';
import {
  getBrainAreas,
  isInsideArea,
  getCentralBrainPolygon,
  isInsidePolygon,
} from '../brain-atlas.js';
import { Camera } from '../camera.js';

const gridMapping = {
  groups: [{ id: 17, name: 'Output' }, { id: 4, name: 'Input' }, { id: 90, name: 'Empty' }],
  nodes: [{ id: 90001, group: 17 }, { id: 6, group: 4 }, { id: 2, group: 17 }],
  edges: [[6, 90001], [90001, 6], [2, 2]],
};

function checkGeometry(graph) {
  const buffers = [graph.nodes, graph.edges];
  if (graph.regions && graph.regions.length > 0) {
    buffers.push(graph.regions);
  }
  for (const vertices of buffers) {
    assert.ok(vertices instanceof Float32Array);
    assert.equal(vertices.length % 21, 0, 'Buffer must be a multiple of 21 floats (complete triangles)');
    for (let i = 0; i < vertices.length; i += 7) {
      const [x, y, r, g, b, a, edgeIndex] = vertices.subarray(i, i + 7);
      assert.ok(Number.isFinite(x) && Number.isFinite(y), 'Coordinates must be finite');
      assert.ok(x >= graph.bounds.minX - 0.001 && x <= graph.bounds.maxX + 0.001, `X ${x} within bounds [${graph.bounds.minX}, ${graph.bounds.maxX}]`);
      assert.ok(y >= graph.bounds.minY - 0.001 && y <= graph.bounds.maxY + 0.001, `Y ${y} within bounds [${graph.bounds.minY}, ${graph.bounds.maxY}]`);
      assert.ok([r, g, b, a].every(value => value >= 0 && value <= 1), 'Colors must be normalized floats in [0, 1]');
      assert.ok(Number.isInteger(edgeIndex), 'edgeIndex must be integer');
    }
  }
  assert.ok(Object.values(graph.bounds).every(Number.isFinite), 'All bounds values must be finite');
  assert.ok(graph.bounds.maxX >= graph.bounds.minX, 'maxX must be >= minX');
  assert.ok(graph.bounds.maxY >= graph.bounds.minY, 'maxY must be >= minY');
}

test('layout respects group order, sorts sparse ids, and does not mutate the mapping in grid mode', () => {
  const original = structuredClone(gridMapping);
  const graph = buildGraph(gridMapping);
  checkGeometry(graph);
  assert.deepEqual(gridMapping, original);
  assert.deepEqual(graph.labels.map(label => label.id), [17, 4, 90]);
  assert.ok(graph.labels.every(label => label.width >= 140));
  assert.ok(graph.labels[0].x < graph.labels[1].x && graph.labels[1].x < graph.labels[2].x);
  assert.equal(graph.nodeCount, 3);
  assert.equal(graph.edgeCount, 3);
  assert.equal(graph.regions.length, 0, 'Grid mode must have empty regions buffer');
});

test('fixture names fall back to the grid with empty regions', () => {
  const fixtures = [
    { groups: [{ id: 1, name: 'PN' }, { id: 2, name: 'KC' }], nodes: [{ id: 1, group: 1 }, { id: 2, group: 2 }], edges: [[1, 2]] },
    { groups: [{ id: 5, name: 'Sensory' }, { id: 6, name: 'Motor' }], nodes: [{ id: 10, group: 5 }], edges: [] },
    { groups: [{ id: 100, name: 'Input' }, { id: 200, name: 'Output' }], nodes: [], edges: [] },
  ];
  for (const fixture of fixtures) {
    const graph = buildGraph(fixture);
    checkGeometry(graph);
    assert.equal(graph.regions.length, 0, `Fixture ${fixture.groups.map(g => g.name).join(',')} must not draw brain regions`);
    assert.ok(graph.labels.every(label => label.width >= 140));
  }
});

test('real capture places nodes in anatomical areas, routes curved edges, and satisfies fit dot size', () => {
  const capture = JSON.parse(
    readFileSync(new URL('../../example/once_upon_a_time.ndjson', import.meta.url), 'utf8').split(/\r?\n/)[0]
  );
  const graph = buildGraph(capture);
  checkGeometry(graph);

  assert.equal(graph.nodeCount, 1958);
  assert.equal(graph.edgeCount, 19037);
  assert.equal(graph.labels.length, 5);
  assert.ok(graph.regions.length > 0, 'Brain regions must be non-empty');

  // Verify regions vertices all carry edgeIndex -1
  for (let i = 6; i < graph.regions.length; i += 7) {
    assert.equal(graph.regions[i], -1, 'All region vertices must have edgeIndex -1');
  }

  // Exact geometry budget: 19,037 curved edges * 27 vertices * 7 floats
  assert.equal(graph.edges.length, 19037 * 27 * 7, 'Edges buffer must match 19,037 * 27 * 7');

  // Node placement inside world-space areas
  const areas = graph.areas ?? getBrainAreas(graph.scale, capture);
  assert.ok(areas, 'Brain area geometry must be exposed');

  const groupNameMap = new Map(capture.groups.map(g => [g.id, g.name]));
  const nodeGroupMap = new Map(capture.nodes.map(n => [n.id, n.group]));

  // 1. Glomeruli inside AL area
  const glomNodes = capture.nodes.filter(n => groupNameMap.get(n.group) === 'Glomerulus');
  assert.equal(glomNodes.length, 54);
  for (const node of glomNodes) {
    const pos = graph.positions.get(node.id);
    assert.ok(isInsideArea(pos, areas.AL), `Glomerulus ${node.id} must lie inside AL area`);
  }

  // 2. Each KC group inside its calyx sector
  const kcGroups = ['KC_gamma', 'KC_alphabeta', 'KC_alphaprime_betaprime'];
  for (const name of kcGroups) {
    const g = capture.groups.find(gr => gr.name === name);
    const sec = areas.calyx.sectors[name];
    assert.ok(sec, `Calyx sector for ${name} must exist`);
    const nodes = capture.nodes.filter(n => n.group === g.id);
    assert.ok(nodes.length > 0);
    for (const node of nodes) {
      const pos = graph.positions.get(node.id);
      assert.ok(isInsideArea(pos, sec), `KC ${name} node ${node.id} must lie inside sector`);
    }
  }

  // 3. Each MBON inside the lobe of its incoming KC group
  const mbonNodes = capture.nodes.filter(n => groupNameMap.get(n.group) === 'MBON');
  assert.equal(mbonNodes.length, 15);
  for (const node of mbonNodes) {
    const incoming = { KC_gamma: 0, KC_alphabeta: 0, KC_alphaprime_betaprime: 0 };
    for (const [s, d] of capture.edges) {
      if (d === node.id) {
        const sName = groupNameMap.get(nodeGroupMap.get(s));
        if (incoming[sName] !== undefined) incoming[sName]++;
      }
    }
    const max = Math.max(...Object.values(incoming));
    let target = 'shared';
    if (max > 0) {
      const winners = Object.keys(incoming).filter(k => incoming[k] === max);
      if (winners.length === 1) {
        if (winners[0] === 'KC_gamma') target = 'gamma';
        else if (winners[0] === 'KC_alphabeta') target = 'alphabeta';
        else if (winners[0] === 'KC_alphaprime_betaprime') target = 'alphaprime_betaprime';
      }
    }
    const lobeArea = areas.lobes[target];
    const pos = graph.positions.get(node.id);
    assert.ok(isInsideArea(pos, lobeArea), `MBON ${node.id} must lie inside lobe ${target}`);
  }

  // Minimum center distance in every area >= 2.5 * RADIUS (7.5)
  function assertMinDistance(nodesList, label) {
    for (let i = 0; i < nodesList.length; i++) {
      for (let j = i + 1; j < nodesList.length; j++) {
        const d = Math.hypot(nodesList[i].x - nodesList[j].x, nodesList[i].y - nodesList[j].y);
        assert.ok(d >= 2.5 * RADIUS - 0.001, `${label} nodes distance ${d} must be >= 7.5`);
      }
    }
  }
  const allPos = Array.from(graph.positions.values());
  assertMinDistance(allPos.filter(p => p.area === 'AL'), 'AL');
  assertMinDistance(allPos.filter(p => p.area === 'Calyx'), 'Calyx');
  assertMinDistance(allPos.filter(p => p.area === 'Lobe'), 'Lobe');


  // Edge indices in edge order
  for (let i = 0; i < graph.edges.length; i += 7) {
    const edgeIdx = graph.edges[i + 6];
    const expected = Math.floor(i / (27 * 7));
    assert.equal(edgeIdx, expected, `Vertex float ${i} must carry edge index ${expected}`);
  }

  // Arrow tips lie RADIUS from destination centres
  for (let e = 0; e < capture.edges.length; e++) {
    const [, dst] = capture.edges[e];
    const dstPos = graph.positions.get(dst);
    const tipX = graph.edges[(e * 27 + 24) * 7];
    const tipY = graph.edges[(e * 27 + 24) * 7 + 1];
    const d = Math.hypot(tipX - dstPos.x, tipY - dstPos.y);
    assert.ok(Math.abs(d - RADIUS) < 0.001, `Arrow tip distance ${d} must equal RADIUS ${RADIUS}`);
  }

  // Curved tract edges deviate from straight chord
  const tractEdge = capture.edges[0]; // Glomerulus -> KC_gamma
  const pA = graph.positions.get(tractEdge[0]);
  const pB = graph.positions.get(tractEdge[1]);
  const midVertexX = graph.edges[12 * 7];
  const midVertexY = graph.edges[12 * 7 + 1];
  const chordMid = [(pA.x + pB.x) / 2, (pA.y + pB.y) / 2];
  const chordDev = Math.hypot(midVertexX - chordMid[0], midVertexY - chordMid[1]);
  assert.ok(chordDev > 20, `Tract curve deviation ${chordDev} must be > 20 from chord`);

  // Bounds contain all geometry including regions and labels
  for (let i = 0; i < graph.regions.length; i += 7) {
    const rx = graph.regions[i], ry = graph.regions[i + 1];
    assert.ok(rx >= graph.bounds.minX - 0.001 && rx <= graph.bounds.maxX + 0.001);
    assert.ok(ry >= graph.bounds.minY - 0.001 && ry <= graph.bounds.maxY + 0.001);
  }
  // Invariant 1: Every brain node lies inside the central-brain outline and at x < 0
  const cbPoly = getCentralBrainPolygon(1.0);
  for (const [id, pos] of graph.positions.entries()) {
    assert.ok(pos.x < 0, `Node ${id} must lie in viewer's left hemisphere (x < 0), got ${pos.x}`);
    assert.ok(isInsidePolygon(pos, cbPoly), `Node ${id} at (${pos.x}, ${pos.y}) must lie inside central brain outline`);
  }

  // Invariant 2: Placement areas do not overlap
  const circleAreas = [
    { name: 'AL', area: areas.AL },
    { name: 'calyx', area: areas.calyx },
    { name: 'gamma', area: areas.lobes.gamma },
    { name: 'alphabeta', area: areas.lobes.alphabeta },
    { name: 'alphaprime_betaprime', area: areas.lobes.alphaprime_betaprime },
    { name: 'shared', area: areas.lobes.shared },
  ];
  for (let i = 0; i < circleAreas.length; i++) {
    for (let j = i + 1; j < circleAreas.length; j++) {
      const d = Math.hypot(circleAreas[i].area.x - circleAreas[j].area.x, circleAreas[i].area.y - circleAreas[j].area.y);
      const minD = circleAreas[i].area.r + circleAreas[j].area.r;
      assert.ok(d >= minD - 0.001, `Area ${circleAreas[i].name} and ${circleAreas[j].name} must not overlap (dist ${d} >= ${minD})`);
    }
  }

  // No MBON inside the calyx, no KC inside a lobe area
  for (const [id, pos] of graph.positions.entries()) {
    if (pos.area === 'Lobe') {
      assert.ok(!isInsideArea(pos, areas.calyx), `MBON ${id} must not lie inside calyx`);
    }
    if (pos.area === 'Calyx') {
      for (const [lobeName, lobeArea] of Object.entries(areas.lobes)) {
        assert.ok(!isInsideArea(pos, lobeArea), `KC ${id} must not lie inside lobe ${lobeName}`);
      }
    }
  }

  // Invariant 3: Each anatomical group's callout anchor is closer to its own group's node centroid than to any other anatomical group's centroid
  const groupNodes = new Map(capture.groups.map(gr => [gr.name, []]));
  for (const [id, pos] of graph.positions.entries()) {
    const node = capture.nodes.find(n => n.id === id);
    const gr = capture.groups.find(gr => gr.id === node.group);
    if (groupNodes.has(gr.name)) groupNodes.get(gr.name).push(pos);
  }
  const centroids = {};
  for (const [name, nodes] of groupNodes.entries()) {
    const cx = nodes.reduce((s, p) => s + p.x, 0) / nodes.length;
    const cy = nodes.reduce((s, p) => s + p.y, 0) / nodes.length;
    centroids[name] = { x: cx, y: cy };
  }
  for (const label of graph.labels) {
    const dOwn = Math.hypot(label.x - centroids[label.name].x, label.y - centroids[label.name].y);
    for (const [otherName, otherCentroid] of Object.entries(centroids)) {
      if (otherName === label.name) continue;
      const dOther = Math.hypot(label.x - otherCentroid.x, label.y - otherCentroid.y);
      assert.ok(
        dOwn < dOther,
        `Label ${label.name} anchor must be closer to own centroid (${dOwn.toFixed(1)}) than to ${otherName} centroid (${dOther.toFixed(1)})`
      );
    }
  }

  // Invariant 4: Bounds within the size budget
  const bw = graph.bounds.maxX - graph.bounds.minX;
  const bh = graph.bounds.maxY - graph.bounds.minY;
  assert.ok(bw <= 2200, `Bounds width ${bw} must be <= 2200`);
  assert.ok(bh <= 1350, `Bounds height ${bh} must be <= 1350`);

  // Camera fit dot-size requirement (dots >= 2 CSS px)
  const camera = new Camera(900, 580);
  camera.fit(graph.bounds);
  const dotCssPx = camera.scale * 2 * RADIUS;
  assert.ok(dotCssPx >= 2.0, `Dot size ${dotCssPx}px must be >= 2 CSS px`);
});

test('mixed mapping places unmatched groups entirely below the brain and labels them', () => {
  const mixed = {
    groups: [
      { id: 0, name: 'Glomerulus' },
      { id: 10, name: 'Sensory' },
    ],
    nodes: [
      { id: 1, group: 0 },
      { id: 2, group: 10 },
    ],
    edges: [],
  };
  const graph = buildGraph(mixed);
  checkGeometry(graph);
  assert.ok(graph.regions.length > 0, 'Brain regions drawn for mixed mapping');

  const glomPos = graph.positions.get(1);
  const sensoryPos = graph.positions.get(2);
  const sensoryLabel = graph.labels.find(l => l.name === 'Sensory');
  assert.ok(sensoryLabel, 'Unmatched group must have a label');
  assert.ok(sensoryLabel.y > glomPos.y + 40, 'Sensory label must be beneath the brain');
  assert.ok(sensoryPos.y > sensoryLabel.y, 'Sensory nodes must be beneath their label');
});

test('empty networks, empty groups, sparse IDs, isolated nodes, and self loops render with valid bounds', () => {
  const cases = [
    // Grid mode
    { groups: [], nodes: [], edges: [] },
    { groups: [{ id: 1, name: 'Input' }], nodes: [], edges: [] },
    { groups: [{ id: 1, name: 'Input' }], nodes: [{ id: 99999, group: 1 }], edges: [] },
    { groups: [{ id: 1, name: 'Input' }], nodes: [{ id: 99999, group: 1 }], edges: [[99999, 99999]] },
    // Brain mode
    { groups: [{ id: 0, name: 'Glomerulus' }], nodes: [], edges: [] },
    { groups: [{ id: 0, name: 'Glomerulus' }], nodes: [{ id: 50000, group: 0 }], edges: [] },
    { groups: [{ id: 0, name: 'Glomerulus' }], nodes: [{ id: 50000, group: 0 }], edges: [[50000, 50000]] },
    {
      groups: [{ id: 0, name: 'Glomerulus' }, { id: 4, name: 'MBON' }],
      nodes: [{ id: 10, group: 0 }, { id: 20, group: 4 }, { id: 30, group: 0 }],
      edges: [[10, 20]], // 30 is isolated
    },
  ];

  for (const c of cases) {
    const graph = buildGraph(c);
    checkGeometry(graph);
    assert.equal(graph.nodeCount, c.nodes.length);
    assert.equal(graph.edgeCount, c.edges.length);
  }
});

test('buildSelectionGeometry generates valid overlay following curved edges, and handles missing ids', () => {
  const singleEdgeMapping = {
    groups: [
      { id: 0, name: 'Glomerulus' },
      { id: 1, name: 'KC_gamma' },
    ],
    nodes: [
      { id: 10, group: 0 },
      { id: 20, group: 1 },
    ],
    edges: [[10, 20]],
  };
  const graph = buildGraph(singleEdgeMapping);
  const pA = graph.positions.get(10);
  const pB = graph.positions.get(20);
  const tractWp = graph.areas.tracts.alToCalyx;
  const path = computeEdgePath(pA, pB, tractWp, RADIUS);
  const curveMid = path.midPoint;
  const chordMid = [(pA.x + pB.x) / 2, (pA.y + pB.y) / 2];

  const overlay = buildSelectionGeometry(graph, 10);
  assert.ok(overlay instanceof Float32Array);
  assert.ok(overlay.length > 0);
  assert.equal(overlay.length % 21, 0, 'Selection overlay must consist of complete triangles');

  // Verify all overlay vertices have edgeIndex -1
  for (let i = 6; i < overlay.length; i += 7) {
    assert.equal(overlay[i], -1);
  }

  // Find min distance of overlay vertices to curve midpoint vs chord midpoint
  let minDistToCurveMid = Infinity;
  let minDistToChordMid = Infinity;
  for (let i = 0; i < overlay.length; i += 7) {
    const vx = overlay[i], vy = overlay[i + 1];
    const dCurve = Math.hypot(vx - curveMid[0], vy - curveMid[1]);
    const dChord = Math.hypot(vx - chordMid[0], vy - chordMid[1]);
    if (dCurve < minDistToCurveMid) minDistToCurveMid = dCurve;
    if (dChord < minDistToChordMid) minDistToChordMid = dChord;
  }
  assert.ok(minDistToCurveMid < 2.0, `Overlay must pass close to curve midpoint: got ${minDistToCurveMid}`);
  assert.ok(minDistToChordMid > 20, `Overlay must deviate from the straight chord midpoint: got ${minDistToChordMid}`);

  // Missing id / null graph return empty Float32Array
  const missing = buildSelectionGeometry(graph, 999999);
  assert.equal(missing.length, 0);
  const nullGraph = buildSelectionGeometry(null, 10);
  assert.equal(nullGraph.length, 0);
});
