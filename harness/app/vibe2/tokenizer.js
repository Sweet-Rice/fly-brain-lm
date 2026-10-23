const pieces = /'(?:[sdmt]|ll|ve|re)| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
const latin1 = bytes => String.fromCharCode(...bytes);

/**
 * Create the ordinary (no special-token recognition) GPT-2 byte BPE tokenizer.
 * @param {{format:string,version:number,eot:number,tokens:string[]}} json
 * @returns {{encodeOrdinary(text:string):number[],tokenBytes(id:number):Uint8Array,eot:number}}
 */
export function createTokenizer(json) {
  if (json.format !== "gpt2-bpe" || json.version !== 1 || json.tokens?.length !== 50256) {
    throw new Error("Unsupported tokenizer file");
  }
  const bytes = json.tokens.map(token => Uint8Array.from(atob(token), c => c.charCodeAt(0)));
  const ranks = new Map(bytes.map((token, id) => [latin1(token), id]));
  const cache = new Map();
  const encoder = new TextEncoder();
  return {
    eot: json.eot,
    tokenBytes(id) {
      return id === json.eot ? encoder.encode("<|endoftext|>") : bytes[id];
    },
    encodeOrdinary(text) {
      const ids = [];
      for (const [piece] of text.matchAll(pieces)) {
        if (!cache.has(piece)) {
          const parts = Array.from(encoder.encode(piece), byte => String.fromCharCode(byte));
          while (parts.length > 1) {
            let best = Infinity, at = -1;
            for (let i = 0; i + 1 < parts.length; i++) {
              const rank = ranks.get(parts[i] + parts[i + 1]);
              if (rank !== undefined && rank < best) { best = rank; at = i; }
            }
            if (at < 0) break;
            parts.splice(at, 2, parts[at] + parts[at + 1]);
          }
          cache.set(piece, parts.map(part => ranks.get(part)));
        }
        ids.push(...cache.get(piece));
      }
      return ids;
    },
  };
}
