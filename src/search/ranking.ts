import { DocType, MARK_CLOSE, MARK_OPEN } from "../types";

// ---- BM25 -------------------------------------------------------------------
// The standard probabilistic ranking function. A term counts for more when it
// is rare across the index (idf) and frequent in the document, with
// diminishing returns (k1) and a penalty for very long documents (b).
const K1 = 1.2;
const B = 0.75;

export function idf(totalDocs: number, docsWithTerm: number): number {
  return Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
}

export function bm25Term(weightedTf: number, docLength: number, avgDocLength: number): number {
  const norm = 1 - B + B * (docLength / (avgDocLength || 1));
  return (weightedTf * (K1 + 1)) / (weightedTf + K1 * norm);
}

// ---- Recency ----------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Personal content is usually wanted fresh: newer mail, uploads and videos get a
 * small boost, and events near today beat events years away. Web pages have no
 * meaningful date, so they are untouched.
 */
export function recencyBoost(type: DocType, dateIso: string | undefined, now = Date.now()): number {
  if (!dateIso || type === "web") return 1;
  const t = Date.parse(dateIso);
  if (Number.isNaN(t)) return 1;

  if (type === "event") {
    const distanceDays = Math.abs(t - now) / DAY_MS;
    return 1 + 0.35 * Math.exp(-distanceDays / 30);
  }
  const ageDays = Math.max(0, (now - t) / DAY_MS);
  return 1 + 0.35 * Math.exp(-ageDays / 120);
}

// ---- Snippets with highlights -----------------------------------------------

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches whole words only, so "art" doesn't light up inside "party". */
function termRegex(terms: string[]): RegExp | null {
  const alternatives = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRegex);
  if (alternatives.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

// Marker characters are control codes: strip any that appear in the source text.
const stripMarks = (s: string) => s.replace(/[\u0001\u0002]/g, "");

export function highlight(text: string, terms: string[]): string {
  const clean = stripMarks(text);
  const re = termRegex(terms);
  return re ? clean.replace(re, (m) => `${MARK_OPEN}${m}${MARK_CLOSE}`) : clean;
}

/** An excerpt around the densest cluster of matches, with the matched words marked. */
export function buildSnippet(content: string, terms: string[], maxLength = 220): string {
  const text = stripMarks(content.slice(0, 60_000)).replace(/\s+/g, " ").trim();
  if (!text) return "";

  const re = termRegex(terms);
  const matches: number[] = [];
  if (re) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && matches.length < 500) matches.push(m.index);
  }

  if (matches.length === 0) {
    return text.length <= maxLength ? text : `${text.slice(0, maxLength).replace(/\s+\S*$/, "")}…`;
  }

  // Pick the window (starting a little before a match) that contains the most matches.
  let bestStart = 0;
  let bestCount = -1;
  for (const idx of matches) {
    const start = Math.max(0, idx - 40);
    const count = matches.filter((p) => p >= start && p < start + maxLength).length;
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }

  let start = bestStart;
  let end = Math.min(text.length, start + maxLength);
  // Don't cut words in half at either edge.
  if (start > 0) {
    const nextSpace = text.indexOf(" ", start);
    if (nextSpace !== -1 && nextSpace < start + 25) start = nextSpace + 1;
  }
  if (end < text.length) {
    const lastSpace = text.lastIndexOf(" ", end);
    if (lastSpace > start + maxLength / 2) end = lastSpace;
  }

  const slice = highlight(text.slice(start, end), terms);
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}
