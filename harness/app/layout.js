import {
  COLORS,
  groupStyle,
  getBrainAreas,
  isInsideArea,
  buildBrainRegions,
  BASE_AREAS,
  computeCalyxSectors,
} from './brain-atlas.js';

const SPACING = 20;
export const RADIUS = 3;
const CIRCLE_SEGMENTS = 12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
export const NODE_IDLE_ALPHA = 0.12;
export const EDGE_IDLE_ALPHA = 0.008;
export const ARROW_IDLE_ALPHA = 0.06;

export function computeEdgePath(a, b, tractWaypoint = null, radius = RADIUS) {
  if (a.x === b.x && a.y === b.y) {
    const segments = [];
    let previous = [a.x - 2, a.y - 2];
    let lastDir = [0, 0];
    for (let i = 1; i <= 16; i++) {
      const t = i / 16;
      const u = 1 - t;
      const point = [
        u ** 3 * (a.x - 2) + 3 * u * u * t * (a.x - 20)
          + 3 * u * t * t * (a.x + 20) + t ** 3 * (a.x + 2),
        u ** 3 * (a.y - 2) + 3 * u * u * t * (a.y - 24)
          + 3 * u * t * t * (a.y - 24) + t ** 3 * (a.y - 2),
      ];
      segments.push({ a: previous, b: point });
      if (i === 16) lastDir = [point[0] - previous[0], point[1] - previous[1]];
      previous = point;
    }
    return {
      type: 'loop',
      segments,
      arrow: { tip: previous, direction: lastDir },
      midPoint: [a.x, a.y - 24],
    };
  }

  if (tractWaypoint) {
    const p0 = [a.x, a.y];
    const p1 = [tractWaypoint.x, tractWaypoint.y];
    const p2 = [b.x, b.y];

    const d0 = [p1[0] - p0[0], p1[1] - p0[1]];
    const len0 = Math.hypot(...d0);
    const t0 = len0 > 0 ? [d0[0] / len0, d0[1] / len0] : [1, 0];
    const q0 = [p0[0] + t0[0] * radius, p0[1] + t0[1] * radius];

    const d1 = [p2[0] - p1[0], p2[1] - p1[1]];
    const len1 = Math.hypot(...d1);
    const t1 = len1 > 0 ? [d1[0] / len1, d1[1] / len1] : [1, 0];
    const tip = [p2[0] - t1[0] * radius, p2[1] - t1[1] * radius];

    const bezierPoint = (t) => {
      const u = 1 - t;
      return [
        u * u * q0[0] + 2 * u * t * p1[0] + t * t * tip[0],
        u * u * q0[1] + 2 * u * t * p1[1] + t * t * tip[1],
      ];
    };

    const pts = [q0, bezierPoint(0.25), bezierPoint(0.5), bezierPoint(0.75), tip];
    const segments = [
      { a: pts[0], b: pts[1] },
      { a: pts[1], b: pts[2] },
      { a: pts[2], b: pts[3] },
      { a: pts[3], b: pts[4] },
    ];
    return {
      type: 'curve',
      segments,
      arrow: { tip, direction: t1 },
      midPoint: pts[2],
    };
  }

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const dir = length > 0 ? [dx / length, dy / length] : [1, 0];
  const start = [a.x + dir[0] * radius, a.y + dir[1] * radius];
  const tip = [b.x - dir[0] * radius, b.y - dir[1] * radius];
  return {
    type: 'straight',
    segments: [{ a: start, b: tip }],
    arrow: { tip, direction: [dx, dy] },
    midPoint: [(start[0] + tip[0]) / 2, (start[1] + tip[1]) / 2],
  };
}

function getTractWaypoint(graph, sourceId, destId) {
  const tracts = graph?.areas?.tracts ?? graph?.tracts;
  if (!tracts) return null;
  const a = graph.positions.get(sourceId);
  const b = graph.positions.get(destId);
  if (!a || !b) return null;
  if (a.area === 'AL' && b.area === 'Calyx') return tracts.alToCalyx;
  if (a.area === 'Calyx' && b.area === 'Lobe') return tracts.calyxToLobe;
  return null;
}

export function buildGraph(mapping) {
  const nodeIndexMap = new Map();
  const nodeIds = [];
  if (mapping?.nodes) {
    for (const node of mapping.nodes) {
      const id = typeof node === 'object' && node !== null ? node.id : node;
      if (typeof id === 'number' && !nodeIndexMap.has(id)) {
        nodeIndexMap.set(id, nodeIds.length);
        nodeIds.push(id);
      }
    }
  }

  const grouped = new Map(mapping.groups.map(group => [group.id, []]));
  for (const node of mapping.nodes) {
    if (grouped.has(node.group)) {
      grouped.get(node.group).push(node);
    }
  }

  const groupStyleMap = new Map(mapping.groups.map((g, i) => [g.id, groupStyle(g, i)]));
  const isBrain = mapping.groups.some(g => groupStyleMap.get(g.id).anatomical);

  if (!isBrain) {
    return buildGridLayout(mapping, grouped, groupStyleMap, nodeIndexMap, nodeIds);
  }

  return buildBrainLayout(mapping, grouped, groupStyleMap, nodeIndexMap, nodeIds);
}

function buildGridLayout(mapping, grouped, groupStyleMap, nodeIndexMap = new Map(), nodeIds = []) {
  const positions = new Map();
  const labels = [];
  const nodes = [];
  const edges = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let left = 0;
  let tallest = 0;
  const base = mapping.edges.length;

  function include(x, y) {
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
  }

  function triangle(target, a, b, c, color, alpha, activityIndex = -1) {
    for (const [x, y] of [a, b, c]) {
      target.push(x, y, ...color, alpha, activityIndex);
      include(x, y);
    }
  }

  function segment(a, b, color, edgeIndex) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) return;
    const nx = -(b[1] - a[1]) / length * 0.35;
    const ny = (b[0] - a[0]) / length * 0.35;
    const p = [a[0] + nx, a[1] + ny];
    const q = [a[0] - nx, a[1] - ny];
    const r = [b[0] + nx, b[1] + ny];
    const s = [b[0] - nx, b[1] - ny];
    triangle(edges, p, q, r, color, EDGE_IDLE_ALPHA, edgeIndex);
    triangle(edges, r, q, s, color, EDGE_IDLE_ALPHA, edgeIndex);
  }

  function arrow(tip, direction, color, edgeIndex) {
    const length = Math.hypot(...direction);
    if (length === 0) return;
    const ux = direction[0] / length;
    const uy = direction[1] / length;
    triangle(edges, tip,
      [tip[0] - ux * 5 - uy * 2.3, tip[1] - uy * 5 + ux * 2.3],
      [tip[0] - ux * 5 + uy * 2.3, tip[1] - uy * 5 - ux * 2.3], color, ARROW_IDLE_ALPHA, edgeIndex);
  }

  mapping.groups.forEach((group) => {
    const members = (grouped.get(group.id) ?? []).slice().sort((a, b) => a.id - b.id);
    const columns = Math.max(1, Math.ceil(Math.sqrt(members.length / 2)));
    const rows = Math.ceil(members.length / columns);
    const width = Math.max(140, columns * SPACING + 40);
    const height = Math.max(0, rows - 1) * SPACING;
    const center = left + width / 2;
    const color = groupStyleMap.get(group.id).color;
    tallest = Math.max(tallest, height);
    labels.push({ id: group.id, name: group.name, x: center, y: 0, width, color });
    include(left, -height / 2);
    include(left + width, height / 2);
    members.forEach((node, i) => {
      const x = center + (i % columns - (columns - 1) / 2) * SPACING;
      const y = Math.floor(i / columns) * SPACING - height / 2;
      positions.set(node.id, { x, y, color });
      const slot = nodeIndexMap.get(node.id);
      const activityIndex = slot !== undefined ? base + slot : -1;
      for (let j = 0; j < CIRCLE_SEGMENTS; j++) {
        const a = (j * 2 * Math.PI) / CIRCLE_SEGMENTS;
        const b = ((j + 1) * 2 * Math.PI) / CIRCLE_SEGMENTS;
        triangle(nodes, [x, y], [x + Math.cos(a) * RADIUS, y + Math.sin(a) * RADIUS],
          [x + Math.cos(b) * RADIUS, y + Math.sin(b) * RADIUS], color, NODE_IDLE_ALPHA, activityIndex);
      }
    });
    left += width + 60;
  });

  for (const label of labels) {
    label.y = -tallest / 2 - 32;
    const halfWidth = Math.max(40, label.name.length * 4);
    include(label.x - halfWidth, label.y - 14);
    include(label.x + halfWidth, label.y + 8);
  }

  for (const [edgeIndex, [source, destination]] of mapping.edges.entries()) {
    const a = positions.get(source);
    const b = positions.get(destination);
    if (!a || !b) continue;
    const path = computeEdgePath(a, b, null, RADIUS);
    for (const seg of path.segments) {
      segment(seg.a, seg.b, a.color, edgeIndex);
    }
    arrow(path.arrow.tip, path.arrow.direction, a.color, edgeIndex);
  }

  if (mapping.groups.length === 0) Object.assign(bounds, { minX: -1, minY: -1, maxX: 1, maxY: 1 });
  return {
    nodes: new Float32Array(nodes),
    edges: new Float32Array(edges),
    regions: new Float32Array(0),
    labels,
    bounds,
    nodeCount: mapping.nodes.length,
    edgeCount: mapping.edges.length,
    edgePairs: mapping.edges,
    positions,
    areas: null,
    nodeIndexMap,
    nodeIds,
  };
}

function buildBrainLayout(mapping, grouped, groupStyleMap, nodeIndexMap = new Map(), nodeIds = []) {
  const positions = new Map();
  const labels = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  function include(x, y) {
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
  }

  const groupNameMap = new Map(mapping.groups.map(g => [g.id, g.name]));
  const nodeGroupMap = new Map(mapping.nodes.map(n => [n.id, n.group]));

  // 1. Calyx sector allocations
  const calyxSectorAngles = computeCalyxSectors(mapping);
  const kcGroups = ['KC_gamma', 'KC_alphabeta', 'KC_alphaprime_betaprime'];
  let totalKCs = 0;
  for (const name of kcGroups) {
    totalKCs += calyxSectorAngles[name].count;
  }

  // 2. Uniform template scale
  const glomGroup = mapping.groups.find(g => g.name === 'Glomerulus');
  const glomCount = glomGroup ? (grouped.get(glomGroup.id)?.length ?? 0) : 0;
  const S_AL = (7.5 * Math.sqrt(Math.max(1, glomCount))) / (1.546 * 50);
  const S_calyx = (7.5 * Math.sqrt(Math.max(1, totalKCs))) / (1.546 * 216);
  const scale = Math.max(1.0, S_AL, S_calyx);

  const areas = getBrainAreas(scale, calyxSectorAngles);

  // 3. Node placement: AL (Glomerulus)
  if (glomGroup) {
    const members = (grouped.get(glomGroup.id) ?? []).slice().sort((a, b) => a.id - b.id);
    const N = members.length;
    const alArea = areas.AL;
    const color = groupStyleMap.get(glomGroup.id).color;
    members.forEach((node, i) => {
      const r = N === 1 ? 0 : alArea.r * 0.94 * Math.sqrt((i + 0.5) / N);
      const theta = i * GOLDEN_ANGLE;
      positions.set(node.id, {
        x: alArea.x + r * Math.cos(theta),
        y: alArea.y + r * Math.sin(theta),
        color,
        area: 'AL',
        group: glomGroup.id,
      });
    });
  }

  // 4. Node placement: Calyx (KC groups)
  const calyxArea = areas.calyx;
  for (const name of kcGroups) {
    const g = mapping.groups.find(gr => gr.name === name);
    if (!g) continue;
    const members = (grouped.get(g.id) ?? []).slice().sort((a, b) => a.id - b.id);
    const sec = calyxSectorAngles[name];
    const color = groupStyleMap.get(g.id).color;
    let count = 0;
    let k = 0;
    while (count < members.length) {
      const theta = (k * GOLDEN_ANGLE) % (2 * Math.PI);
      let normTheta = theta;
      while (normTheta < sec.theta0) normTheta += 2 * Math.PI;
      while (normTheta >= sec.theta0 + 2 * Math.PI) normTheta -= 2 * Math.PI;
      if (normTheta >= sec.theta0 && normTheta < sec.theta1) {
        const r = calyxArea.r * 0.98 * Math.sqrt((k + 0.5) / Math.max(1, totalKCs));
        const node = members[count];
        positions.set(node.id, {
          x: calyxArea.x + r * Math.cos(normTheta),
          y: calyxArea.y + r * Math.sin(normTheta),
          color,
          area: 'Calyx',
          group: g.id,
        });
        count++;
      }
      k++;
    }
  }

  // 5. Node placement: MBON (Lobes)
  const mbonGroup = mapping.groups.find(g => g.name === 'MBON');
  if (mbonGroup) {
    const members = (grouped.get(mbonGroup.id) ?? []).slice().sort((a, b) => a.id - b.id);
    const mbonLobeNodes = { gamma: [], alphabeta: [], alphaprime_betaprime: [], shared: [] };
    for (const node of members) {
      const incoming = { KC_gamma: 0, KC_alphabeta: 0, KC_alphaprime_betaprime: 0 };
      for (const [src, dst] of mapping.edges) {
        if (dst === node.id) {
          const sName = groupNameMap.get(nodeGroupMap.get(src));
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
      mbonLobeNodes[target].push(node);
    }

    const color = groupStyleMap.get(mbonGroup.id).color;
    for (const [target, nodes] of Object.entries(mbonLobeNodes)) {
      const lobeArea = areas.lobes[target];
      const M = nodes.length;
      nodes.forEach((node, i) => {
        const r = M === 1 ? 0 : lobeArea.r * 0.85 * Math.sqrt((i + 0.5) / M);
        const theta = i * GOLDEN_ANGLE;
        positions.set(node.id, {
          x: lobeArea.x + r * Math.cos(theta),
          y: lobeArea.y + r * Math.sin(theta),
          color,
          area: 'Lobe',
          group: mbonGroup.id,
        });
      });
    }
  }

  // 6. Callout labels and leader lines
  const calloutLines = [];
  const brainCalloutDefs = {
    Glomerulus: {
      anchor: { x: -150 * scale, y: 340 * scale },
      width: 180 * scale,
      from: { x: -150 * scale, y: 320 * scale },
      to: { x: -150 * scale, y: 240 * scale },
    },
    KC_gamma: {
      anchor: { x: -170 * scale, y: -450 * scale },
      width: 160 * scale,
      from: { x: -170 * scale, y: -430 * scale },
      to: { x: -295 * scale, y: -275 * scale },
    },
    KC_alphabeta: {
      anchor: { x: -500 * scale, y: 80 * scale },
      width: 220 * scale,
      from: { x: -500 * scale, y: 60 * scale },
      to: { x: -405 * scale, y: -107 * scale },
    },
    KC_alphaprime_betaprime: {
      anchor: { x: -590 * scale, y: -450 * scale },
      width: 420 * scale,
      from: { x: -590 * scale, y: -430 * scale },
      to: { x: -480 * scale, y: -288 * scale },
    },
    MBON: {
      anchor: { x: 60 * scale, y: -70 * scale },
      width: 100 * scale,
      from: { x: 40 * scale, y: -60 * scale },
      to: { x: -20 * scale, y: 35 * scale },
    },
  };

  // Add labels for anatomical groups
  for (const group of mapping.groups) {
    const style = groupStyleMap.get(group.id);
    if (!style.anatomical) continue;
    const def = brainCalloutDefs[group.name];
    if (def) {
      labels.push({
        id: group.id,
        name: group.name,
        x: def.anchor.x,
        y: def.anchor.y,
        width: def.width,
        color: style.color,
      });
      calloutLines.push({
        from: def.from,
        to: def.to,
        color: style.color,
      });
    }
  }

  // 7. Build regions geometry
  const regions = buildBrainRegions(scale, calyxSectorAngles, calloutLines);
  for (let i = 0; i < regions.length; i += 7) {
    include(regions[i], regions[i + 1]);
  }

  // 8. Mixed mapping: unmatched groups placed below the brain
  const unmatchedGroups = mapping.groups.filter(g => !groupStyleMap.get(g.id).anatomical);
  if (unmatchedGroups.length > 0) {
    const brainBottom = Math.max(bounds.maxY, 290 * scale);
    const startY = brainBottom + 80;
    let gridLeft = -200;
    unmatchedGroups.forEach((group) => {
      const members = (grouped.get(group.id) ?? []).slice().sort((a, b) => a.id - b.id);
      const columns = Math.max(1, Math.ceil(Math.sqrt(members.length / 2)));
      const rows = Math.ceil(members.length / columns);
      const width = Math.max(140, columns * SPACING + 40);
      const height = Math.max(0, rows - 1) * SPACING;
      const center = gridLeft + width / 2;
      const color = groupStyleMap.get(group.id).color;
      labels.push({
        id: group.id,
        name: group.name,
        x: center,
        y: startY,
        width,
        color,
      });
      members.forEach((node, i) => {
        const x = center + (i % columns - (columns - 1) / 2) * SPACING;
        const y = startY + 36 + Math.floor(i / columns) * SPACING;
        positions.set(node.id, { x, y, color, area: 'Grid', group: group.id });
      });
      gridLeft += width + 60;
    });
  }

  // 9. Include label extents in bounds
  for (const label of labels) {
    const halfWidth = Math.max(40, label.width / 2);
    include(label.x - halfWidth, label.y - 20 / scale - 10);
    include(label.x + halfWidth, label.y + 10);
  }

  // 10. Preallocate and write nodes geometry
  const nodes = new Float32Array(mapping.nodes.length * CIRCLE_SEGMENTS * 3 * 7);
  let nodeOffset = 0;
  const base = mapping.edges.length;
  for (const group of mapping.groups) {
    const members = (grouped.get(group.id) ?? []).slice().sort((a, b) => a.id - b.id);
    for (const node of members) {
      const pos = positions.get(node.id);
      if (!pos) continue;
      const { x, y, color } = pos;
      const slot = nodeIndexMap.get(node.id);
      const activityIndex = slot !== undefined ? base + slot : -1;
      include(x - RADIUS, y - RADIUS);
      include(x + RADIUS, y + RADIUS);
      for (let j = 0; j < CIRCLE_SEGMENTS; j++) {
        const a = (j * 2 * Math.PI) / CIRCLE_SEGMENTS;
        const b = ((j + 1) * 2 * Math.PI) / CIRCLE_SEGMENTS;
        const p1 = [x, y];
        const p2 = [x + Math.cos(a) * RADIUS, y + Math.sin(a) * RADIUS];
        const p3 = [x + Math.cos(b) * RADIUS, y + Math.sin(b) * RADIUS];
        for (const [vx, vy] of [p1, p2, p3]) {
          nodes[nodeOffset++] = vx;
          nodes[nodeOffset++] = vy;
          nodes[nodeOffset++] = color[0];
          nodes[nodeOffset++] = color[1];
          nodes[nodeOffset++] = color[2];
          nodes[nodeOffset++] = NODE_IDLE_ALPHA;
          nodes[nodeOffset++] = activityIndex;
        }
      }
    }
  }

  // 11. Precalculate edge buffer size and preallocate
  let totalEdgeFloats = 0;
  const edgePaths = [];
  for (const [source, destination] of mapping.edges) {
    const a = positions.get(source);
    const b = positions.get(destination);
    if (!a || !b) {
      edgePaths.push(null);
      continue;
    }
    const tractWaypoint = getTractWaypoint({ positions, areas }, source, destination);
    const path = computeEdgePath(a, b, tractWaypoint, RADIUS);
    edgePaths.push(path);
    // each segment = 2 triangles = 6 vertices = 42 floats
    // arrow = 1 triangle = 3 vertices = 21 floats
    totalEdgeFloats += path.segments.length * 42 + 21;
  }

  const edges = new Float32Array(totalEdgeFloats);
  let edgeOffset = 0;

  function triangle(target, a, b, c, color, alpha, edgeIndex) {
    for (const [x, y] of [a, b, c]) {
      target[edgeOffset++] = x;
      target[edgeOffset++] = y;
      target[edgeOffset++] = color[0];
      target[edgeOffset++] = color[1];
      target[edgeOffset++] = color[2];
      target[edgeOffset++] = alpha;
      target[edgeOffset++] = edgeIndex;
      include(x, y);
    }
  }

  function segment(a, b, color, edgeIndex, alpha = EDGE_IDLE_ALPHA) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) return;
    const nx = -(b[1] - a[1]) / length * 0.35;
    const ny = (b[0] - a[0]) / length * 0.35;
    const p = [a[0] + nx, a[1] + ny];
    const q = [a[0] - nx, a[1] - ny];
    const r = [b[0] + nx, b[1] + ny];
    const s = [b[0] - nx, b[1] - ny];
    triangle(edges, p, q, r, color, alpha, edgeIndex);
    triangle(edges, r, q, s, color, alpha, edgeIndex);
  }

  function arrow(tip, direction, color, edgeIndex, alpha = ARROW_IDLE_ALPHA) {
    const length = Math.hypot(...direction);
    if (length === 0) return;
    const ux = direction[0] / length;
    const uy = direction[1] / length;
    triangle(edges, tip,
      [tip[0] - ux * 5 - uy * 2.3, tip[1] - uy * 5 + ux * 2.3],
      [tip[0] - ux * 5 + uy * 2.3, tip[1] - uy * 5 - ux * 2.3], color, alpha, edgeIndex);
  }

  for (let edgeIndex = 0; edgeIndex < mapping.edges.length; edgeIndex++) {
    const path = edgePaths[edgeIndex];
    if (!path) continue;
    const [source] = mapping.edges[edgeIndex];
    const a = positions.get(source);
    for (const seg of path.segments) {
      segment(seg.a, seg.b, a.color, edgeIndex, EDGE_IDLE_ALPHA);
    }
    arrow(path.arrow.tip, path.arrow.direction, a.color, edgeIndex, ARROW_IDLE_ALPHA);
  }

  return {
    nodes: nodeOffset === nodes.length ? nodes : nodes.subarray(0, nodeOffset),
    edges,
    regions,
    labels,
    bounds,
    nodeCount: mapping.nodes.length,
    edgeCount: mapping.edges.length,
    edgePairs: mapping.edges,
    positions,
    areas,
    nodeIndexMap,
    nodeIds,
  };
}

export function buildSelectionGeometry(graph, selectedId) {
  if (!graph?.positions?.has?.(selectedId)) return new Float32Array(0);
  const node = graph.positions.get(selectedId);
  const vertices = [];

  function triangle(target, a, b, c, color, alpha) {
    for (const [x, y] of [a, b, c]) {
      target.push(x, y, ...color, alpha, -1);
    }
  }

  function segment(target, a, b, color, alpha, width = 1.4) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) return;
    const ux = -dy / length * width;
    const uy = dx / length * width;
    triangle(target, [a[0] - ux, a[1] - uy], [a[0] + ux, a[1] + uy], [b[0] + ux, b[1] + uy], color, alpha);
    triangle(target, [a[0] - ux, a[1] - uy], [b[0] + ux, b[1] + uy], [b[0] - ux, b[1] - uy], color, alpha);
  }

  function arrow(target, tip, direction, color, alpha, scale = 1.4) {
    const length = Math.hypot(...direction);
    if (length === 0) return;
    const ux = direction[0] / length;
    const uy = direction[1] / length;
    triangle(target, tip,
      [tip[0] - (ux * 5 + uy * 2.3) * scale, tip[1] - (uy * 5 - ux * 2.3) * scale],
      [tip[0] - (ux * 5 - uy * 2.3) * scale, tip[1] - (uy * 5 + ux * 2.3) * scale],
      color, alpha);
  }

  function ring(target, center, innerR, outerR, color, alpha, segments = 24) {
    for (let j = 0; j < segments; j++) {
      const a = (j * 2 * Math.PI) / segments;
      const b = ((j + 1) * 2 * Math.PI) / segments;
      const cosA = Math.cos(a), sinA = Math.sin(a);
      const cosB = Math.cos(b), sinB = Math.sin(b);
      const p1 = [center.x + cosA * innerR, center.y + sinA * innerR];
      const p2 = [center.x + cosA * outerR, center.y + sinA * outerR];
      const p3 = [center.x + cosB * outerR, center.y + sinB * outerR];
      const p4 = [center.x + cosB * innerR, center.y + sinB * innerR];
      triangle(target, p1, p2, p3, color, alpha);
      triangle(target, p1, p3, p4, color, alpha);
    }
  }

  // 1. Ring around selected node
  ring(vertices, node, RADIUS + 1.2, RADIUS + 3.8, [1, 1, 1], 0.95, 24);

  // 2. Incident edges and neighbor nodes
  const edgePairs = graph.edgePairs ?? [];
  const neighbors = new Set();
  const outgoingColor = [1, 0.48, 0.35]; // coral
  const incomingColor = [0.91, 0.47, 0.98]; // fuchsia
  const selfColor = [1, 0.95, 0.5];

  for (const [source, destination] of edgePairs) {
    const isOut = (source === selectedId);
    const isIn = (destination === selectedId);
    if (!isOut && !isIn) continue;

    const a = graph.positions.get(source);
    const b = graph.positions.get(destination);
    if (!a || !b) continue;

    if (isOut && destination !== selectedId) neighbors.add(destination);
    if (isIn && source !== selectedId) neighbors.add(source);

    const tractWaypoint = getTractWaypoint(graph, source, destination);
    const path = computeEdgePath(a, b, tractWaypoint, RADIUS);

    const color = source === destination ? selfColor : (isOut ? outgoingColor : incomingColor);
    for (const seg of path.segments) {
      segment(vertices, seg.a, seg.b, color, 0.9, 1.4);
    }
    arrow(vertices, path.arrow.tip, path.arrow.direction, color, 0.9, 1.4);
  }

  // 3. Highlight neighbor nodes
  for (const neighborId of neighbors) {
    const neighborPos = graph.positions.get(neighborId);
    if (neighborPos) {
      ring(vertices, neighborPos, RADIUS + 0.6, RADIUS + 2.0, [0.9, 0.9, 0.9], 0.7, 16);
    }
  }

  return new Float32Array(vertices);
}
