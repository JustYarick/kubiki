/**
 * Tiny fuzzy scorer: returns a score (higher is better) for `query` matching `text`
 * or -1 when there is no match. Case-insensitive, subsequence-first strategy.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx; // straight substring, earlier is better
  // subsequence fallback
  let ti = 0;
  let score = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return -1;
    score += found === ti ? 2 : 1; // contiguous matches score higher
    ti = found + 1;
  }
  return score;
}

/** Wrap match highlights as [start, end) index pairs for rendering. */
export function fuzzyRanges(query: string, text: string): Array<[number, number]> | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return null;
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return [[idx, idx + q.length]];
  const ranges: Array<[number, number]> = [];
  let prev = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, prev + 1);
    if (found === -1) return null;
    ranges.push([found, found + 1]);
    prev = found;
  }
  return ranges;
}
