/** All parameters and intermediates remain f32; no quantization or model substitutions. */
export function createShaders(config, lobes) {
  const { d_model: d, n_glom: G, n_kc: K, top_k: topK, heads_per_lobe: hpl, d_head: P } = config;
  const H = 3 * hpl, C = H * P;
  const prefix = `
const D: u32 = ${d}u; const G: u32 = ${G}u; const K: u32 = ${K}u;
const TOP: u32 = ${topK}u; const HPL: u32 = ${hpl}u; const P: u32 = ${P}u; const C: u32 = ${C}u;
const OFF = array<u32, 3>(${lobes.map(l => `${l.offset}u`).join(",")});
const COUNT = array<u32, 3>(${lobes.map(l => `${l.count}u`).join(",")});
fn silu(a: f32) -> f32 { return a / (1.0 + exp(-a)); }
`;
  const storage = (binding, name, access = "read") => `@group(0) @binding(${binding}) var<storage, ${access}> ${name}: array<f32>;`;
  const kernel = body => prefix + body;
  const norm = (N, mix) => kernel(`
${storage(0, "input")} ${storage(1, "weight")} ${storage(2, "output", "read_write")}
${mix ? storage(3, "gate") : ""}
var<workgroup> sums: array<f32, 256>;
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) t: u32) {
  var sum = 0.0;
  for (var i = t; i < ${N}u; i += 256u) {
    var v = input[i]; ${mix ? "v *= silu(gate[i]);" : ""} sum += v * v;
  }
  sums[t] = sum; workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride /= 2u) {
    if (t < stride) { sums[t] += sums[t + stride]; } workgroupBarrier();
  }
  let scale = inverseSqrt(sums[0] / ${N}.0 + 0.00001);
  for (var i = t; i < ${N}u; i += 256u) {
    var v = input[i]; ${mix ? "v *= silu(gate[i]);" : ""} output[i] = v * scale * weight[i];
  }
}`);
  return {
    embed: kernel(`
${storage(0, "weight")} ${storage(1, "output", "read_write")}
struct Params { token: u32, } @group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < D) { output[id.x] = weight[params.token * D + id.x]; }
}`),
    norm: norm(d, false), finalNorm: norm(d, false), mixNorm: norm(C, true),
    gemv: kernel(`
${storage(0, "weight")} ${storage(1, "input")} ${storage(2, "bias")} ${storage(3, "cap")}
${storage(4, "output", "read_write")}
struct Params { rows: u32, cols: u32, mode: u32, } @group(0) @binding(5) var<uniform> params: Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let row = id.x; if (row >= params.rows) { return; }
  var acc = 0.0;
  if (params.cols % 4u == 0u) {
    for (var i = 0u; i < params.cols; i += 4u) {
      let at = row * params.cols + i;
      acc += dot(vec4<f32>(weight[at], weight[at+1u], weight[at+2u], weight[at+3u]),
                 vec4<f32>(input[i], input[i+1u], input[i+2u], input[i+3u]));
    }
  } else {
    for (var i = 0u; i < params.cols; i++) { acc += weight[row * params.cols + i] * input[i]; }
  }
  switch params.mode {
    case 1u: { let a = acc + bias[row]; if (a > 20.0) { acc = a; } else { acc = log(1.0 + exp(a)); } }
    case 2u: { acc = cap[row] * (1.0 / (1.0 + exp(-(acc + bias[row])))); }
    case 3u: { acc += output[row]; }
    default: {}
  }
  output[row] = acc;
}`),
    glom: kernel(`
${storage(0, "r")} ${storage(1, "scale")} ${storage(2, "gbar", "read_write")}
var<workgroup> sums: array<f32, 64>; var<workgroup> mean: f32;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) t: u32) {
  var v = 0.0; if (t < G) { v = r[t]; } sums[t] = v; workgroupBarrier();
  for (var s = 32u; s > 0u; s /= 2u) { if (t < s) { sums[t] += sums[t+s]; } workgroupBarrier(); }
  if (t == 0u) { mean = sums[0] / f32(G); } workgroupBarrier();
  if (t < G) { v = v / (scale[0] + scale[1] * mean); } else { v = 0.0; }
  sums[t] = v; workgroupBarrier();
  for (var s = 32u; s > 0u; s /= 2u) { if (t < s) { sums[t] += sums[t+s]; } workgroupBarrier(); }
  if (t < G) { gbar[t] = v - sums[0] / f32(G); }
}`),
    kcDrive: kernel(`
${storage(0, "wiring")} ${storage(1, "gbar")} ${storage(2, "kc", "read_write")}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= K) { return; } var sum = 0.0;
  for (var g = 0u; g < G; g++) { sum += wiring[id.x * G + g] * gbar[g]; }
  kc[id.x] = max(0.0, sum);
}`),
    topk: kernel(`
${storage(0, "kc")} ${storage(1, "code", "read_write")} ${storage(2, "key", "read_write")} ${storage(3, "lobeSum", "read_write")}
var<workgroup> count: atomic<u32>; var<workgroup> maximum: atomic<u32>;
var<workgroup> prefix: u32; var<workgroup> sums: array<f32, 768>;
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) t: u32) {
  if (t == 0u) { prefix = 0u; atomicStore(&maximum, 0u); } workgroupBarrier();
  for (var i = t; i < K; i += 256u) { atomicMax(&maximum, bitcast<u32>(kc[i])); }
  workgroupBarrier();
  for (var bit = 31i; bit >= 0i; bit--) {
    if (t == 0u) { atomicStore(&count, 0u); } workgroupBarrier();
    let candidate = prefix | (1u << u32(bit));
    var n = 0u;
    for (var i = t; i < K; i += 256u) { if (bitcast<u32>(kc[i]) >= candidate) { n++; } }
    atomicAdd(&count, n); workgroupBarrier();
    if (t == 0u && atomicLoad(&count) >= TOP) { prefix = candidate; } workgroupBarrier();
  }
  if (t == 0u) { atomicStore(&count, 0u); } workgroupBarrier();
  var n = 0u;
  for (var i = t; i < K; i += 256u) {
    if (bitcast<u32>(kc[i]) > prefix) { code[i] = kc[i]; n++; } else { code[i] = 0.0; }
  }
  atomicAdd(&count, n); storageBarrier(); workgroupBarrier();
  if (t == 0u && prefix != 0u) {
    var remaining = TOP - atomicLoad(&count);
    for (var i = 0u; i < K && remaining > 0u; i++) {
      if (bitcast<u32>(kc[i]) == prefix) { code[i] = kc[i]; remaining--; }
    }
  }
  storageBarrier(); workgroupBarrier();
  let mx = bitcast<f32>(atomicLoad(&maximum)) + 0.000001;
  var partial = vec3<f32>(0.0);
  for (var i = t; i < K; i += 256u) {
    let value = code[i] / mx; key[i] = value;
    if (i < OFF[1]) { partial.x += value; } else if (i < OFF[2]) { partial.y += value; } else { partial.z += value; }
  }
  sums[t] = partial.x; sums[256u+t] = partial.y; sums[512u+t] = partial.z; workgroupBarrier();
  for (var s = 128u; s > 0u; s /= 2u) {
    if (t < s) { for (var l = 0u; l < 3u; l++) { sums[l*256u+t] += sums[l*256u+t+s]; } } workgroupBarrier();
  }
  if (t < 3u) { lobeSum[t] = sums[t*256u]; }
}`),
    conv: kernel(`
${storage(0, "weight")} ${storage(1, "bias")} ${storage(2, "v")} ${storage(3, "state", "read_write")} ${storage(4, "x", "read_write")}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let c = id.x; if (c >= C) { return; }
  let a = state[3u*c]; let b = state[3u*c+1u]; let old = state[3u*c+2u]; let fresh = v[c];
  let value = ((a*weight[4u*c] + b*weight[4u*c+1u]) + old*weight[4u*c+2u]) + fresh*weight[4u*c+3u] + bias[c];
  x[c] = silu(value); state[3u*c] = b; state[3u*c+1u] = old; state[3u*c+2u] = fresh;
}`),
    memRead: kernel(`
${storage(0, "state")} ${storage(1, "key")} ${storage(2, "lobeSum")} ${storage(3, "x")} ${storage(4, "skip")} ${storage(5, "y", "read_write")}
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) p: u32) {
  if (p >= P) { return; } let head = group.x; let l = head / HPL; let h = head % HPL;
  let base = OFF[l] * HPL * P + h * COUNT[l] * P;
  var sum = 0.0;
  for (var j = 0u; j < COUNT[l]; j++) { sum += (key[OFF[l]+j] / (lobeSum[l] + 0.000001)) * state[base+j*P+p]; }
  y[head*P+p] = sum + skip[head] * x[head*P+p];
}`),
    memWrite: kernel(`
${storage(0, "state", "read_write")} ${storage(1, "key")} ${storage(2, "dopamine")} ${storage(3, "recovery")} ${storage(4, "x")}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let at = id.x; if (at >= K*HPL*P) { return; }
  var l = 0u; if (at >= OFF[2]*HPL*P) { l = 2u; } else if (at >= OFF[1]*HPL*P) { l = 1u; }
  let local = at - OFF[l]*HPL*P; let h = local / (COUNT[l]*P); let j = (local/P) % COUNT[l]; let p = local % P;
  let head = l*HPL+h; let old = state[at];
  let dk = dopamine[head] * key[OFF[l]+j];
  state[at] = recovery[head] * (old + dk * (x[head*P+p] - old));
}`),
  };
}
