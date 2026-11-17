/**
 * Edit distance between a and b (insert, delete, substitute, or swap two
 * neighbouring letters = 1 edit). Gives up and returns maxEdits + 1 as soon as
 * the answer must exceed maxEdits, which keeps scanning a vocabulary cheap.
 */
export function editDistance(a: string, b: string, maxEdits: number): number {
  if (Math.abs(a.length - b.length) > maxEdits) return maxEdits + 1;
  if (a === b) return 0;

  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prevPrev[j - 2] + 1);
      }
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > maxEdits) return maxEdits + 1;
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Vocabulary words within `maxEdits` of `term`, closest first, then most common.
 * Used to rescue misspelled queries ("pyhton" -> "python").
 */
export function findFuzzy(
  term: string,
  vocabulary: Iterable<string>,
  docFrequency: (t: string) => number,
  maxEdits: number,
  limit = 3,
): string[] {
  const found: { word: string; dist: number; df: number }[] = [];
  for (const word of vocabulary) {
    if (word === term) continue;
    // Cheap pre-filter: a typo rarely changes both of the first two letters.
    if (word[0] !== term[0] && word[1] !== term[1]) continue;
    const dist = editDistance(term, word, maxEdits);
    if (dist <= maxEdits) found.push({ word, dist, df: docFrequency(word) });
  }
  found.sort((x, y) => x.dist - y.dist || y.df - x.df || x.word.localeCompare(y.word));
  return found.slice(0, limit).map((f) => f.word);
}
