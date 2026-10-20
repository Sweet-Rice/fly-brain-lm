const COLORS = [
  [0.35, 0.79, 1], [0.56, 0.88, 0.56], [1, 0.72, 0.35],
  [0.82, 0.57, 1], [1, 0.49, 0.62], [0.35, 0.87, 0.79],
];
const SPACING = 20;
const RADIUS = 3;
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

  function triangle(target, a, b, c, color, alpha) {
    for (const [x, y] of [a, b, c]) {
      target.push(x, y, ...color, alpha);
      include(x, y);
    }
  }

  function segment(a, b, color) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / length * 0.35;
    const ny = (b[0] - a[0]) / length * 0.35;
    const p = [a[0] + nx, a[1] + ny];
    const q = [a[0] - nx, a[1] - ny];
    const r = [b[0] + nx, b[1] + ny];
    const s = [b[0] - nx, b[1] - ny];
    triangle(edges, p, q, r, color, 0.12);
    triangle(edges, r, q, s, color, 0.12);
  }

  function arrow(tip, direction, color) {
    const length = Math.hypot(...direction);
    const ux = direction[0] / length;
    const uy = direction[1] / length;
    triangle(edges, tip,
      [tip[0] - ux * 5 - uy * 2.3, tip[1] - uy * 5 + ux * 2.3],
      [tip[0] - ux * 5 + uy * 2.3, tip[1] - uy * 5 - ux * 2.3], color, 0.65);
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

  for (const [source, destination] of mapping.edges) {
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
        segment(previous, point, a.color);
        if (i === 16) arrow(point, [point[0] - previous[0], point[1] - previous[1]], a.color);
        previous = point;
      }
    } else {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      const start = [a.x + dx / length * RADIUS, a.y + dy / length * RADIUS];
      const end = [b.x - dx / length * RADIUS, b.y - dy / length * RADIUS];
      segment(start, end, a.color);
      arrow(end, [dx, dy], a.color);
    }
  }

  if (mapping.groups.length === 0) Object.assign(bounds, { minX: -1, minY: -1, maxX: 1, maxY: 1 });
  return {
    nodes: new Float32Array(nodes), edges: new Float32Array(edges), labels, bounds,
    nodeCount: mapping.nodes.length, edgeCount: mapping.edges.length,
  };
}
