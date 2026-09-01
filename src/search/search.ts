import { SearchIndex } from "./indexer";
import { buildSnippet, scoreSimple } from "./ranking";
import { tokenizeQuery } from "./tokenizer";
import { ScoredResult, SearchResponse } from "../types";

/**
 * Runs a query against the given index:
 * 1. tokenize the query
 * 2. find candidate docs (any doc containing at least one query term)
 * 3. score every candidate
 * 4. sort by score, descending
 */
export function runSearch(index: SearchIndex, rawQuery: string): SearchResponse {
  const startedAt = Date.now();
  const queryTerms = tokenizeQuery(rawQuery);

  if (queryTerms.length === 0) {
    return { query: rawQuery, total: 0, tookMs: Date.now() - startedAt, results: [] };
  }

  // Union of postings across all query terms — OR semantics.
  // (Phase 13 adds exact-phrase / AND-style matching on top of this.)
  const candidateIds = new Set<string>();
  for (const term of queryTerms) {
    for (const id of index.getPostings(term)) {
      candidateIds.add(id);
    }
  }

  const scored: ScoredResult[] = [];

  for (const id of candidateIds) {
    const doc = index.getDocument(id);
    if (!doc) continue;

    const score = scoreSimple(doc, queryTerms);
    if (score <= 0) continue;

    scored.push({
      id: doc.id,
      title: doc.title,
      url: doc.url,
      snippet: buildSnippet(doc, queryTerms),
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    query: rawQuery,
    total: scored.length,
    tookMs: Date.now() - startedAt,
    results: scored,
  };
}

/** Simple prefix-based autocomplete over indexed terms — Phase 13. */
export function autocomplete(index: SearchIndex, prefix: string, limit = 8): string[] {
  const lowerPrefix = prefix.toLowerCase().trim();
  if (!lowerPrefix) return [];

  const matches: string[] = [];
  for (const term of index.getAllTerms()) {
    if (term.startsWith(lowerPrefix)) matches.push(term);
    if (matches.length >= limit) break;
  }
  return matches;
}
