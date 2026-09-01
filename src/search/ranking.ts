import { Document } from "../types";
import { tokenize } from "./tokenizer";

const WEIGHTS = {
  title: 5,
  heading: 3,
  url: 2,
  body: 1,
};

function countMatches(haystackTokens: string[], queryTerms: string[]): number {
  let count = 0;
  for (const term of queryTerms) {
    for (const token of haystackTokens) {
      if (token === term) count++;
    }
  }
  return count;
}

/**
 * Phase 5 scoring: weight matches by where they occur.
 * A hit in the title counts for more than a hit in the body.
 * This is intentionally simple — see scoreTfIdf below for the next step up.
 */
export function scoreSimple(doc: Document, queryTerms: string[]): number {
  const titleTokens = tokenize(doc.title);
  const headingTokens = tokenize(doc.headings ?? "");
  const urlTokens = tokenize(doc.url);
  const bodyTokens = tokenize(doc.content);

  const titleScore = countMatches(titleTokens, queryTerms) * WEIGHTS.title;
  const headingScore = countMatches(headingTokens, queryTerms) * WEIGHTS.heading;
  const urlScore = countMatches(urlTokens, queryTerms) * WEIGHTS.url;
  const bodyScore = countMatches(bodyTokens, queryTerms) * WEIGHTS.body;

  return titleScore + headingScore + urlScore + bodyScore;
}

/**
 * Phase 14, step 2: TF-IDF scoring.
 * termFrequency = how often the term appears in this doc
 * inverseDocFrequency = how rare the term is across the whole corpus
 * (rare terms that match are more informative than common ones)
 *
 * `totalDocs` and `docsContainingTerm` come from the index — see search.ts.
 */
export function scoreTfIdf(
  doc: Document,
  queryTerms: string[],
  totalDocs: number,
  docsContainingTerm: (term: string) => number
): number {
  const bodyTokens = tokenize([doc.title, doc.headings ?? "", doc.content].join(" "));
  let score = 0;

  for (const term of queryTerms) {
    const termFrequency = bodyTokens.filter((t) => t === term).length;
    if (termFrequency === 0) continue;

    const docsWithTerm = docsContainingTerm(term) || 1;
    const inverseDocFrequency = Math.log(totalDocs / docsWithTerm + 1);

    score += termFrequency * inverseDocFrequency;
  }

  return score;
}

/** Builds a short highlighted-ish snippet around the first query match. */
export function buildSnippet(doc: Document, queryTerms: string[], maxLength = 160): string {
  const content = doc.content;
  const lowerContent = content.toLowerCase();

  let matchIndex = -1;
  for (const term of queryTerms) {
    const idx = lowerContent.indexOf(term);
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx;
    }
  }

  if (matchIndex === -1) {
    return content.slice(0, maxLength).trim() + (content.length > maxLength ? "..." : "");
  }

  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(content.length, start + maxLength);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";

  return prefix + content.slice(start, end).trim() + suffix;
}
