export type Vec3 = [number, number, number];
export interface Mapping {
  groups: { id: number; name: string }[];
  nodes: { id: number; group: number }[];
  edges: [number, number][];
}
export interface Region {
  center: Vec3;
  min: Vec3;
  max: Vec3;
  color: Vec3;
  samples: Vec3[];
}
export interface Atlas {
  regions: Record<string, Region>;
}
export interface BrainNode {
  id: number;
  group: string;
  position: Vec3;
  color: Vec3;
}
export interface BrainEdge {
  source: number;
  target: number;
  points: [Vec3, Vec3, Vec3, Vec3];
}
export interface BrainGraph {
  nodes: BrainNode[];
  edges: BrainEdge[];
  slots: Map<number, number>;
  edgeSlots: Map<string, number>;
}
const colors: Record<string, Vec3> = {
  Glomerulus: [0.45, 0.85, 0.45],
  KC_gamma: [0.3, 0.88, 0.97],
  KC_alphabeta: [0.25, 0.78, 0.68],
  KC_alphaprime_betaprime: [0.42, 0.58, 1],
  MBON: [1, 0.72, 0.28],
};
function hash(n: number) {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}
export function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}
export function curvePoint(p: BrainEdge['points'], t: number): Vec3 {
  return mix(
    mix(mix(p[0], p[1], t), mix(p[1], p[2], t), t),
    mix(mix(p[1], p[2], t), mix(p[2], p[3], t), t),
    t,
  );
}
export function buildBrainGraph(mapping: Mapping, atlas: Atlas): BrainGraph {
  const groups = new Map(mapping.groups.map((g) => [g.id, g.name]));
  const counters = new Map<string, number>();
  // The model has no spatial registration or hemisphere metadata. Use one explicit,
  // illustrative hemisphere; do not duplicate neurons or fabricate bilateral edges.
  const nodes: BrainNode[] = mapping.nodes.map((n) => {
    const group = groups.get(n.group) ?? 'Other';
    const regionName =
      group === 'Glomerulus'
        ? 'AL_R'
        : group.startsWith('KC_')
          ? 'MB_CA_R'
          : group === 'MBON'
            ? n.id % 2
              ? 'MB_VL_R'
              : 'MB_ML_R'
            : 'SMP_R';
    const region = atlas.regions[regionName];
    if (!region) throw new Error(`Anatomical region ${regionName} is missing`);
    const order = counters.get(regionName) ?? 0;
    counters.set(regionName, order + 1);
    let position: Vec3;
    if (region.samples.length) {
      const sample = region.samples[hash(n.id + 31) % region.samples.length]!;
      // Keep repeated samples distinct, contracting towards the region's center slightly.
      position = mix(
        sample,
        region.center,
        0.02 + (0.08 * (hash(order) % 100)) / 100,
      );
    } else {
      position = region.center.map(
        (v, axis) =>
          v +
          ((hash(n.id * 3 + axis) % 1000) / 1000 - 0.5) *
            (region.max[axis]! - region.min[axis]!) *
            0.35,
      ) as Vec3;
    }
    return {
      id: n.id,
      group,
      position,
      color: colors[group] ?? [0.7, 0.57, 0.9],
    };
  });
  const slots = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: BrainEdge[] = [];
  const edgeSlots = new Map<string, number>();
  for (const [source, target] of mapping.edges) {
    const si = slots.get(source),
      ti = slots.get(target);
    if (
      si === undefined ||
      ti === undefined ||
      edgeSlots.has(`${source},${target}`)
    )
      continue;
    const a = nodes[si]!,
      b = nodes[ti]!;
    let c1 = mix(a.position, b.position, 0.33),
      c2 = mix(a.position, b.position, 0.67);
    if (a.group.startsWith('KC_') && b.group === 'MBON') {
      const ped = atlas.regions.MB_PED_R!.center;
      c1 = mix(a.position, ped, 0.85);
      c2 = mix(ped, b.position, 0.35);
    } else if (a.group === 'Glomerulus' && b.group.startsWith('KC_')) {
      c1 = [
        a.position[0] - 0.15,
        b.position[1] * 0.5 + a.position[1] * 0.5,
        a.position[2] - 0.25,
      ];
      c2 = [b.position[0] - 0.12, b.position[1] - 0.1, b.position[2] - 0.1];
    }
    edgeSlots.set(`${source},${target}`, edges.length);
    edges.push({ source, target, points: [a.position, c1, c2, b.position] });
  }
  return { nodes, edges, slots, edgeSlots };
}

export const PULSE_SECONDS = 0.9;
export class BrainActivity {
  graph: BrainGraph;
  edges: Float32Array;
  nodes: Float32Array;
  deadline = -Infinity;
  constructor(graph: BrainGraph) {
    this.graph = graph;
    this.edges = new Float32Array(graph.edges.length).fill(-100);
    this.nodes = new Float32Array(graph.nodes.length).fill(-100);
  }
  fire(pairs: [number, number][], seconds: number) {
    let changed = false;
    for (const [src, dst] of pairs) {
      const slot = this.graph.edgeSlots.get(`${src},${dst}`);
      if (slot === undefined) continue;
      this.edges[slot] = seconds;
      this.nodes[this.graph.slots.get(src)!] = seconds;
      this.nodes[this.graph.slots.get(dst)!] = seconds;
      changed = true;
    }
    if (changed) this.deadline = seconds + PULSE_SECONDS;
    return changed;
  }
}
