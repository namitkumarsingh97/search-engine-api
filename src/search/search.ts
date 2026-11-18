import { DocType, Document, ScoredResult, SearchFacets, SearchResponse } from "../types";
import { findFuzzy } from "./fuzzy";
import { SearchIndex } from "./indexer";
import { parseQuery, rebuildQuery } from "./query";
import { bm25Term, buildSnippet, highlight, idf, recencyBoost } from "./ranking";
import { tokenize } from "./tokenizer";

export interface SearchOptions {
  /** Restrict results to one type; omit for all types. */
  type?: DocType;
  /** The signed-in user, if any. Decides which private documents are visible. */
  viewerId?: string;
  page?: number;
  pageSize?: number;
  /** "relevance" (default) or "date" (newest first; undated documents last). */
  sort?: "relevance" | "date";
  /** The visitor confirmed they are 18+: show mature results. Off by default (SafeSearch). */
  showMature?: boolean;
}

/**
 * Words that mean the visitor is after explicit material. Nexa doesn't index it; the point is the age
 * signal: without a confirmation the search is not run at all and the UI asks for the confirmation.
 */
const EXPLICIT_TERMS = new Set([
  "porn", "porno", "pornography", "pornhub", "xvideos", "xnxx", "xhamster", "xxx", "nsfw", "nude", "nudes", "naked",
  "hentai", "erotic", "erotica", "onlyfans", "milf", "fetish", "camgirl", "camgirls", "escort", "escorts", "stripper",
  "blowjob", "orgasm", "bdsm", "hardcore", "sexcam", "sexting",
]);

/** True when the query itself asks for adult material. */
export function isAdultQuery(terms: string[]): boolean {
  return terms.some((t) => EXPLICIT_TERMS.has(t));
}

/** Public docs (no owner) are visible to everyone; private docs only to their owner. */
export function isVisible(doc: Document, viewerId?: string): boolean {
  return !doc.ownerId || doc.ownerId === viewerId;
}

const emptyFacets = (): SearchFacets => ({ all: 0, web: 0, file: 0, mail: 0, event: 0, video: 0, news: 0 });

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** True when `phrase` appears as consecutive tokens in the document's text. */
function containsPhrase(doc: Document, phrase: string[]): boolean {
  const tokens = tokenize(`${doc.title} ${doc.headings ?? ""} ${doc.content}`);
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((w, k) => tokens[i + k] === w)) return true;
  }
  return false;
}

/**
 * Runs a query against the index:
 *  1. parse operators ("phrases", -exclude, site:, type:)
 *  2. rescue unknown words with typo-tolerant matches
 *  3. gather candidates, drop anything the viewer can't see or that fails a filter
 *  4. rank with BM25 (+ title, coverage, recency and ownership boosts)
 *  5. count results per type for the tabs, then page and highlight the winners
 */
export function runSearch(index: SearchIndex, rawQuery: string, options: SearchOptions = {}): SearchResponse {
  const startedAt = Date.now();
  const parsed = parseQuery(rawQuery);
  const pageSize = Math.min(50, Math.max(1, Math.floor(options.pageSize ?? 10)));
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const typeFilter = options.type ?? parsed.type;
  const filterOnly = parsed.terms.length === 0 && Boolean(parsed.site || parsed.type);

  const empty = (suggestion?: string): SearchResponse => ({
    query: rawQuery,
    total: 0,
    page,
    pageSize,
    tookMs: Date.now() - startedAt,
    results: [],
    facets: emptyFacets(),
    suggestion,
    safeSearch: !options.showMature,
    matureHidden: 0,
    ageCheck: false,
  });

  if (parsed.terms.length === 0 && !filterOnly) return empty();

  // Explicit searches need the age confirmation first: nothing is searched until the visitor gives it.
  const adultTerms = [...parsed.terms, ...parsed.phrases.flat()];
  if (isAdultQuery(adultTerms) && !options.showMature) return { ...empty(), ageCheck: true };
  let matureHidden = 0;

  // Which terms to score by, and how much each counts for (1 = exact, lower = typo match).
  const weights = new Map<string, number>();
  const replacements = new Map<string, string>();
  const phraseWords = new Set(parsed.phrases.flat());
  let vocabulary: string[] | null = null;

  for (const term of parsed.terms) {
    if (index.docsContainingTerm(term) > 0) {
      weights.set(term, 1);
    } else if (term.length >= 4 && !phraseWords.has(term) && /^\p{L}+$/u.test(term)) {
      vocabulary ??= index.getAllTerms();
      const matches = findFuzzy(term, vocabulary, (t) => index.docsContainingTerm(t), term.length >= 8 ? 2 : 1);
      if (matches.length > 0) {
        replacements.set(term, matches[0]);
        for (const m of matches) weights.set(m, Math.max(weights.get(m) ?? 0, 0.6));
      }
    }
  }
  const suggestion = replacements.size > 0 ? rebuildQuery(parsed, replacements) : undefined;

  // Candidates: anything containing at least one scoring term (or everything, for site:/type: only).
  const candidates = new Set<string>();
  if (filterOnly) {
    for (const d of index.getAllDocuments()) candidates.add(d.id);
  } else {
    for (const term of weights.keys()) for (const id of index.getPostings(term)) candidates.add(id);
  }
  if (candidates.size === 0) return empty(suggestion);

  const totalDocs = index.size;
  const avgLen = index.avgDocLength;
  const now = Date.now();
  const facets = emptyFacets();
  const scored: { doc: Document; score: number; dateMs: number }[] = [];

  for (const id of candidates) {
    const entry = index.getIndexed(id);
    if (!entry) continue;
    const doc = entry.doc;
    const type = doc.type ?? "web";

    if (!isVisible(doc, options.viewerId)) continue;
    if (doc.mature && !options.showMature) {
      matureHidden++;
      continue;
    }
    if (parsed.excluded.some((t) => entry.tf.has(t))) continue;
    if (parsed.site) {
      const host = type === "web" ? (doc.domain ?? hostOf(doc.url)).replace(/^www\./, "") : "";
      if (!(host === parsed.site || host.endsWith(`.${parsed.site}`))) continue;
    }
    if (parsed.phrases.length > 0) {
      const ok = parsed.phrases.every((p) => p.every((w) => entry.tf.has(w)) && containsPhrase(doc, p));
      if (!ok) continue;
    }

    let score = 1;
    if (!filterOnly) {
      score = 0;
      let exactMatched = 0;
      for (const [term, weight] of weights) {
        const tf = entry.tf.get(term);
        if (!tf) continue;
        if (weight === 1) exactMatched++;
        score += weight * idf(totalDocs, index.docsContainingTerm(term)) * bm25Term(tf, entry.length, avgLen);
      }
      if (score <= 0) continue;

      // Matching more of the query's words beats matching one word many times.
      const coverage = exactMatched / parsed.terms.length;
      score *= 0.6 + 0.4 * coverage;
      if (parsed.terms.length > 1 && exactMatched === parsed.terms.length) score *= 1.25;
      // Every query word in the title is a strong signal.
      if (parsed.terms.every((t) => entry.titleTerms.has(t))) score *= 1.4;
    }

    score *= recencyBoost(type, doc.date, now);
    // Your own stuff shouldn't be drowned out by the whole web.
    if (doc.ownerId && doc.ownerId === options.viewerId) score *= 1.15;

    facets[type]++;
    facets.all++;
    if (typeFilter && type !== typeFilter) continue;
    scored.push({ doc, score, dateMs: doc.date ? Date.parse(doc.date) || 0 : 0 });
  }

  if (options.sort === "date") scored.sort((a, b) => b.dateMs - a.dateMs || b.score - a.score);
  else scored.sort((a, b) => b.score - a.score || b.dateMs - a.dateMs);

  // Highlight with every word that actually scored (including typo matches).
  const markTerms = [...weights.keys(), ...parsed.phrases.flat()];
  const results: ScoredResult[] = scored.slice((page - 1) * pageSize, page * pageSize).map(({ doc, score }) => ({
    id: doc.id,
    type: doc.type ?? "web",
    title: doc.title,
    titleMarked: highlight(doc.title, markTerms),
    url: doc.url,
    snippet: buildSnippet(doc.content, markTerms),
    score: Math.round(score * 1000) / 1000,
    date: doc.date,
  }));

  return {
    query: rawQuery,
    total: scored.length,
    page,
    pageSize,
    tookMs: Date.now() - startedAt,
    results,
    facets,
    suggestion,
    safeSearch: !options.showMature,
    matureHidden,
    ageCheck: matureHidden > 0 || isAdultQuery(adultTerms),
  };
}

/**
 * Suggestions for what the user is typing: their own recent searches that
 * match first, then the most common indexed words starting with the prefix.
 */
export function autocomplete(
  index: SearchIndex,
  prefix: string,
  viewerId?: string,
  limit = 8,
  recentQueries: string[] = [],
): string[] {
  const full = prefix.toLowerCase().trim();
  if (!full) return [];

  // Complete the word being typed; everything before it is kept as typed ("python we" -> "python web").
  const words = full.split(/\s+/);
  const lowerPrefix = words.pop() ?? "";
  const head = words.length > 0 ? `${words.join(" ")} ` : "";

  const out: string[] = [];
  for (const q of recentQueries) {
    if (q.toLowerCase().startsWith(full) && q.toLowerCase() !== full && !out.includes(q)) out.push(q);
    if (out.length >= 3) break;
  }

  const matches: { term: string; df: number }[] = [];
  for (const term of index.getAllTerms()) {
    if (!lowerPrefix || !term.startsWith(lowerPrefix) || term === lowerPrefix) continue;
    // Don't leak words that only appear in other users' private documents.
    const visible = [...index.getPostings(term)].some((id) => {
      const doc = index.getDocument(id);
      return doc && isVisible(doc, viewerId);
    });
    if (visible) matches.push({ term, df: index.docsContainingTerm(term) });
  }
  matches.sort((a, b) => b.df - a.df || a.term.localeCompare(b.term));

  for (const { term } of matches) {
    if (out.length >= limit) break;
    const suggestion = head + term;
    if (!out.includes(suggestion)) out.push(suggestion);
  }
  return out;
}
