/**
 * @typedef {{vocab_size:number,d_model:number,n_layer:number,n_glom:number,n_kc:number,
 * top_k:number,heads_per_lobe:number,d_head:number,conv_k:number,ctx:number,eot:number}} Vibe2Config
 * @typedef {{format:string,version:number,impl:string,model_id:string,note:string,
 * checkpoint:{name:string,sha256:string},config:Vibe2Config,lobes:{offset:number,count:number}[],
 * weights:{file:string,bytes:number,sha256:string},
 * tensors:{name:string,offset:number,shape:number[]}[],mapping_mask:number[][]}} Vibe2Manifest
 */
const urlFor = (base, file) => `${base.replace(/\/?$/, "/")}${file}`;
const positiveInt = value => Number.isSafeInteger(value) && value > 0;

/**
 * Validate dimensions and every bound tensor before allocating GPU resources.
 * @param {string} baseUrl
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Vibe2Manifest>}
 */
export async function loadManifest(baseUrl, fetchImpl) {
  const response = await fetchImpl(urlFor(baseUrl, "manifest.json"));
  if (!response.ok) throw new Error(`Model manifest not found at ${urlFor(baseUrl, "manifest.json")}`);
  const m = await response.json();
  const check = (ok, field) => { if (!ok) throw new Error(`Model manifest is invalid: ${field}`); };
  check(m.format === "flybrain-vibe2-webgpu", "format");
  check(m.version === 1, "version");
  check(m.impl === "vibe2", "impl");
  const c = m.config;
  check(c && typeof c === "object", "config");
  for (const field of ["vocab_size", "d_model", "n_layer", "n_glom", "n_kc", "top_k", "heads_per_lobe", "d_head", "conv_k", "ctx", "eot"]) {
    check(positiveInt(c[field]), `config.${field}`);
  }
  check(c.n_kc <= 2048, "config.n_kc");
  check(c.top_k < c.n_kc, "config.top_k");
  check(c.conv_k === 4, "config.conv_k");
  check(c.vocab_size === 50257 && c.eot === 50256, "config.vocab_size");
  check(c.n_glom <= 64 && c.d_head <= 64, "config.workgroup_dimensions");
  check(typeof m.model_id === "string" && typeof m.note === "string", "model_id/note");
  check(typeof m.checkpoint?.name === "string" && /^[a-f0-9]{64}$/.test(m.checkpoint?.sha256), "checkpoint");
  check(m.weights?.file === "weights.bin" && positiveInt(m.weights.bytes) && /^[a-f0-9]{64}$/.test(m.weights.sha256), "weights");
  check(Array.isArray(m.lobes) && m.lobes.length === 3, "lobes");
  let offset = 0;
  for (const lobe of m.lobes) {
    check(lobe.offset === offset && positiveInt(lobe.count), "lobes");
    offset += lobe.count;
  }
  check(offset === c.n_kc, "lobes");
  check(Array.isArray(m.mapping_mask) && m.mapping_mask.length === c.n_kc, "mapping_mask");
  check(m.mapping_mask.every(row => Array.isArray(row) && row.length > 0 && row.every((g, i) => Number.isInteger(g) && g >= 0 && g < c.n_glom && (i === 0 || row[i - 1] < g))), "mapping_mask");
  const H = 3 * c.heads_per_lobe, C = H * c.d_head, d = c.d_model;
  const expected = [["embed.weight", [c.vocab_size, d]], ["norm_f.weight", [d]]];
  for (let b = 0; b < c.n_layer; b++) {
    for (const [name, shape] of [
      ["norm.weight", [d]], ["mixer.W_v.weight", [C, d]], ["mixer.W_z.weight", [C, d]],
      ["mixer.conv.weight", [C, 4]], ["mixer.conv.bias", [C]],
      ["mixer.addr.receptors.weight", [c.n_glom, d]], ["mixer.addr.receptors.bias", [c.n_glom]],
      ["mixer.addr.glom_scale", [2]], ["mixer.addr.wiring", [c.n_kc, c.n_glom]],
      ["mixer.dopamine.linear.weight", [H, d]], ["mixer.dopamine.linear.bias", [H]],
      ["mixer.cap", [H]], ["mixer.recovery", [H]], ["mixer.D", [H]],
      ["mixer.out_norm.weight", [C]], ["mixer.out_proj.weight", [d, C]],
    ]) expected.push([`blocks.${b}.${name}`, shape]);
  }
  check(Array.isArray(m.tensors) && m.tensors.length === expected.length, "tensors");
  let end = 0;
  expected.forEach(([name, shape], i) => {
    const t = m.tensors[i];
    check(t?.name === name && JSON.stringify(t.shape) === JSON.stringify(shape), `tensors.${name}`);
    check(Number.isSafeInteger(t.offset) && t.offset >= end && t.offset % 256 === 0, `tensors.${name}.offset`);
    end = t.offset + shape.reduce((a, b) => a * b, 4);
    check(end <= m.weights.bytes, `tensors.${name}.size`);
  });
  return m;
}

/** @param {string} baseUrl @param {typeof fetch} fetchImpl */
export async function loadTokenizerFile(baseUrl, fetchImpl) {
  const response = await fetchImpl(urlFor(baseUrl, "tokenizer.json"));
  if (!response.ok) throw new Error(`Tokenizer not found at ${urlFor(baseUrl, "tokenizer.json")}`);
  return response.json();
}

/**
 * Download directly into the final upload allocation; reject unhydrated LFS checkouts.
 * @param {string} baseUrl
 * @param {Vibe2Manifest} manifest
 * @param {typeof fetch} fetchImpl
 * @param {(progress:number)=>void} onProgress
 * @returns {Promise<Uint8Array>}
 */
export async function loadWeights(baseUrl, manifest, fetchImpl, onProgress = () => {}) {
  const url = urlFor(baseUrl, manifest.weights.file);
  const response = await fetchImpl(url);
  if (response.status === 404) throw new Error(`Model weights not found at ${url}`);
  if (!response.ok) throw new Error(`Model weights download failed: HTTP ${response.status}`);
  const data = new Uint8Array(manifest.weights.bytes);
  const reader = response.body.getReader();
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > data.length) throw new Error("weights.bin size mismatch");
      data.set(value, loaded);
      loaded += value.length;
      if (loaded >= 23 && new TextDecoder().decode(data.subarray(0, 23)).startsWith("version https://git-lfs")) {
        throw new Error("weights.bin is a Git LFS pointer; run git lfs pull");
      }
      onProgress(loaded / data.length);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  if (loaded !== data.length) throw new Error("weights.bin size mismatch");
  return data;
}
