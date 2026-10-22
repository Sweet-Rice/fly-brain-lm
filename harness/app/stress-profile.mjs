// Run from the repository root: node harness/app/stress-profile.mjs [saved-app-directory].
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const directory = process.argv[2] ?? 'harness/app';
const load = name => import(pathToFileURL(resolve(directory, name)));
const [{ ProtocolReceiver }, { buildGraph }, { EdgeActivity }] = await Promise.all([
  load('protocol.js'), load('layout.js'), load('activity.js'),
]);
const lines = readFileSync(new URL('../example/once_upon_a_time.ndjson', import.meta.url), 'utf8').trim().split('\n');
const mapping = JSON.parse(lines[0]);
const fires = lines.slice(1).map(JSON.parse);
function measure(iterations, action) {
  const samples = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    action(index);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { p50_ms: samples[Math.floor(samples.length / 2)], p95_ms: samples[Math.floor(samples.length * .95)] };
}
let graph;
const receiver = new ProtocolReceiver();
receiver.process(lines[0]);
const activity = new EdgeActivity(mapping.edges, mapping.nodes);
const rawFires = Array.from({ length: 2000 }, (_, t) => JSON.stringify({ ...fires[t % fires.length], t }));
const results = {
  modules: resolve(directory), nodes: mapping.nodes.length, edges: mapping.edges.length,
  parse_mapping: measure(30, () => JSON.parse(lines[0])),
  parse_and_validate_mapping: measure(30, () => receiver.process(lines[0])),
  layout: measure(15, () => { graph = buildGraph(mapping); }),
  parse_fire: measure(rawFires.length, i => JSON.parse(rawFires[i])),
  parse_and_validate_fire: measure(rawFires.length, i => receiver.process(rawFires[i])),
  cpu_activity: measure(2000, i => activity.fire(fires[i % fires.length].pairs, i)),
  geometry_bytes: graph.nodes.byteLength + graph.edges.byteLength,
  activity_bytes: activity.starts.byteLength,
  note: 'Protocol timings include JSON.parse; layout does not include GPU upload. Captured fires use the real model topology.',
};
console.log(JSON.stringify(results, null, 2));
