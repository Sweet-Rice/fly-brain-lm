const COLORS = [
  [0.35, 0.79, 1], [0.56, 0.88, 0.56], [1, 0.72, 0.35],
  [0.82, 0.57, 1], [1, 0.49, 0.62], [0.35, 0.87, 0.79],
];
const SPACING = 20;
export const RADIUS = 3;
const CIRCLE_SEGMENTS = 12;

export function buildGraph(mapping) {
  const grouped = new Map(mapping.groups.map(group => [group.id, []]));
  for (const node of mapping.nodes) grouped.get(node.group).push(node);
  const positions = new Map();
  const labels = [];
  const nodes = [];
  const edges = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let left = 0;
  let tallest = 0;

  function include(x, y) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }

  function triangle(target, a, b, c, color, alpha, edgeIndex = -1) {
    for (const [x, y] of [a, b, c]) {
      target.push(x, y, ...color, alpha, edgeIndex);
      include(x, y);
    }
  }

  function segment(a, b, color, edgeIndex) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / length * 0.35;
    const ny = (b[0] - a[0]) / length * 0.35;
    const p = [a[0] + nx, a[1] + ny];
    const q = [a[0] - nx, a[1] - ny];
    const r = [b[0] + nx, b[1] + ny];
    const s = [b[0] - nx, b[1] - ny];
    triangle(edges, p, q, r, color, 0.12, edgeIndex);
    triangle(edges, r, q, s, color, 0.12, edgeIndex);
  }

  function arrow(tip, direction, color, edgeIndex) {
    const length = Math.hypot(...direction);
    const ux = direction[0] / length;
    const uy = direction[1] / length;
    triangle(edges, tip,
      [tip[0] - ux * 5 - uy * 2.3, tip[1] - uy * 5 + ux * 2.3],
      [tip[0] - ux * 5 + uy * 2.3, tip[1] - uy * 5 - ux * 2.3], color, 0.65, edgeIndex);
  }

  mapping.groups.forEach((group, index) => {
    const members = grouped.get(group.id).sort((a, b) => a.id - b.id);
    const columns = Math.max(1, Math.ceil(Math.sqrt(members.length / 2)));
    const rows = Math.ceil(members.length / columns);
    const width = Math.max(140, columns * SPACING + 40);
    const height = Math.max(0, rows - 1) * SPACING;
    const center = left + width / 2;
    const color = COLORS[index % COLORS.length];
    tallest = Math.max(tallest, height);
    labels.push({ id: group.id, name: group.name, x: center, y: 0, width, color });
    include(left, -height / 2);
    include(left + width, height / 2);
    members.forEach((node, i) => {
      const x = center + (i % columns - (columns - 1) / 2) * SPACING;
      const y = Math.floor(i / columns) * SPACING - height / 2;
      positions.set(node.id, { x, y, color });
      for (let j = 0; j < CIRCLE_SEGMENTS; j++) {
        const a = j * 2 * Math.PI / CIRCLE_SEGMENTS;
        const b = (j + 1) * 2 * Math.PI / CIRCLE_SEGMENTS;
        triangle(nodes, [x, y], [x + Math.cos(a) * RADIUS, y + Math.sin(a) * RADIUS],
          [x + Math.cos(b) * RADIUS, y + Math.sin(b) * RADIUS], color, 1);
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
    if (source === destination) {
      let previous = [a.x - 2, a.y - 2];
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        const point = [
          u ** 3 * (a.x - 2) + 3 * u * u * t * (a.x - 20)
            + 3 * u * t * t * (a.x + 20) + t ** 3 * (a.x + 2),
          u ** 3 * (a.y - 2) + 3 * u * u * t * (a.y - 24)
            + 3 * u * t * t * (a.y - 24) + t ** 3 * (a.y - 2),
        ];
        segment(previous, point, a.color, edgeIndex);
        if (i === 16) arrow(point, [point[0] - previous[0], point[1] - previous[1]], a.color, edgeIndex);
        previous = point;
      }
    } else {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      const start = [a.x + dx / length * RADIUS, a.y + dy / length * RADIUS];
      const end = [b.x - dx / length * RADIUS, b.y - dy / length * RADIUS];
      segment(start, end, a.color, edgeIndex);
      arrow(end, [dx, dy], a.color, edgeIndex);
    }
  }

  if (mapping.groups.length === 0) Object.assign(bounds, { minX: -1, minY: -1, maxX: 1, maxY: 1 });
  return {
    nodes: new Float32Array(nodes), edges: new Float32Array(edges), labels, bounds,
    nodeCount: mapping.nodes.length, edgeCount: mapping.edges.length, edgePairs: mapping.edges,
    positions,
  };
}

export function buildSelectionGeometry(graph, selectedId) {
  if (!graph?.positions?.has(selectedId)) return new Float32Array(0);
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

  function arrow(target, tip, direction, color, alpha, scale = 1.3) {
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
      const a = j * 2 * Math.PI / segments;
      const b = (j + 1) * 2 * Math.PI / segments;
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
  const outgoingColor = [1, 0.85, 0.35];
  const incomingColor = [0.35, 0.85, 1];
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

    if (source === destination) {
      let previous = [a.x - 2, a.y - 2];
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        const point = [
          u ** 3 * (a.x - 2) + 3 * u * u * t * (a.x - 20)
            + 3 * u * t * t * (a.x + 20) + t ** 3 * (a.x + 2),
          u ** 3 * (a.y - 2) + 3 * u * u * t * (a.y - 24)
            + 3 * u * t * t * (a.y - 24) + t ** 3 * (a.y - 2),
        ];
        segment(vertices, previous, point, selfColor, 0.95, 1.4);
        if (i === 16) arrow(vertices, point, [point[0] - previous[0], point[1] - previous[1]], selfColor, 0.95, 1.4);
        previous = point;
      }
    } else {
      const color = isOut ? outgoingColor : incomingColor;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const start = [a.x + dx / length * RADIUS, a.y + dy / length * RADIUS];
        const end = [b.x - dx / length * RADIUS, b.y - dy / length * RADIUS];
        segment(vertices, start, end, color, 0.9, 1.4);
        arrow(vertices, end, [dx, dy], color, 0.9, 1.4);
      }
    }
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
