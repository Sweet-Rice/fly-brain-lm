/** In-place quickselect. @param {Float32Array} values @param {number} target */
function select(values, target) {
  let lo = 0, hi = values.length - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >>> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) { [values[i], values[j]] = [values[j], values[i]]; i++; j--; }
    }
    if (target <= j) hi = j;
    else if (target >= i) lo = i;
    else break;
  }
  return values[target];
}

/**
 * Torch-compatible threshold masking, including all ties at the kth logit.
 * @param {ArrayLike<number>} logits
 * @param {number} temperature
 * @param {number} topK
 * @param {()=>number} random
 * @returns {number}
 */
export function sampleToken(logits, temperature, topK, random = Math.random) {
  let best = 0;
  for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
  if (temperature <= 0) return best;
  const scaled = Float32Array.from(logits, x => x / temperature);
  const kth = topK ? select(scaled.slice(), scaled.length - Math.min(topK, scaled.length)) : -Infinity;
  const max = scaled[best];
  let total = 0;
  for (const value of scaled) if (value >= kth) total += Math.exp(value - max);
  const u = random() * total;
  let running = 0, last = best;
  for (let i = 0; i < scaled.length; i++) {
    if (scaled[i] < kth) continue;
    last = i;
    running += Math.exp(scaled[i] - max);
    if (running > u) return i;
  }
  return last;
}
