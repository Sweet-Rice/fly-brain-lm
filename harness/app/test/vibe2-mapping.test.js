import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildMapping, firePairs } from "../vibe2/mapping.js";
import { ProtocolReceiver } from "../protocol.js";
const manifest = JSON.parse(await readFile(new URL("../../../frontend/public/models/vibe2-tinystories/manifest.json", import.meta.url), "utf8"));
test("trained graph matches Python topology and edge order", () => {
  const { message, kcPairs } = buildMapping(manifest);
  assert.equal(message.nodes.length, 1959);
  assert.equal(message.edges.length, 19037);
  assert.deepEqual(message.groups.map(g => g.name), ["Glomerulus", "KC_gamma", "KC_alphabeta", "KC_alphaprime_betaprime", "MBON"]);
  const { n_glom: G, n_kc: K, heads_per_lobe: H } = manifest.config;
  for (let k = 0; k < K; k++) {
    const l = manifest.lobes.findIndex(l => k >= l.offset && k < l.offset + l.count);
    assert.deepEqual(kcPairs[k], [...manifest.mapping_mask[k].map(g => [g, G + k]), ...Array.from({ length: H }, (_, h) => [G + k, G + K + l * H + h])]);
  }
  assert.deepEqual(firePairs(kcPairs, [4, 0]), [...kcPairs[4], ...kcPairs[0]]);
  assert.equal(new ProtocolReceiver().process(JSON.stringify(message)).action, "replace_mapping");
});
