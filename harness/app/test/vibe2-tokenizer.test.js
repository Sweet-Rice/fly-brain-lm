import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTokenizer } from "../vibe2/tokenizer.js";
const base = new URL("../../../frontend/public/models/vibe2-tinystories/", import.meta.url);
const tokenizer = createTokenizer(JSON.parse(await readFile(new URL("tokenizer.json", base), "utf8")));
const golden = JSON.parse(await readFile(new URL("golden.json", base), "utf8"));
for (const { text, ids } of golden.tokenizer_cases) {
  test(`GPT-2 ordinary encoding: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(tokenizer.encodeOrdinary(text), ids);
    assert.equal(new TextDecoder().decode(Uint8Array.from(ids.flatMap(id => [...tokenizer.tokenBytes(id)]))), text);
  });
}
