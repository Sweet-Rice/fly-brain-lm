const names = ["Glomerulus", "KC_gamma", "KC_alphabeta", "KC_alphaprime_betaprime", "MBON"];

/** Transcribe FlyGraph.refresh. @param {import("./assets.js").Vibe2Manifest} manifest */
export function buildMapping(manifest) {
  const { n_glom: G, n_kc: K, heads_per_lobe: hpl } = manifest.config;
  const cls = new Array(K);
  manifest.lobes.forEach(({ offset, count }, lobe) => cls.fill(lobe, offset, offset + count));
  const nodes = [
    ...Array.from({ length: G }, (_, id) => ({ id, group: 0 })),
    ...Array.from({ length: K }, (_, k) => ({ id: G + k, group: 1 + cls[k] })),
    ...Array.from({ length: 3 * hpl }, (_, h) => ({ id: G + K + h, group: 4 })),
  ];
  const kcPairs = manifest.mapping_mask.map((wired, k) => [
    ...wired.map(g => [g, G + k]),
    ...Array.from({ length: hpl }, (_, h) => [G + k, G + K + cls[k] * hpl + h]),
  ]);
  return {
    message: { type: "mapping", version: 1, groups: names.map((name, id) => ({ id, name })), nodes, edges: kcPairs.flat() },
    kcPairs,
  };
}

/** @param {number[][][]} kcPairs @param {number[]} activeKcs @returns {number[][]} */
export function firePairs(kcPairs, activeKcs) {
  return activeKcs.flatMap(k => kcPairs[k]);
}
