// A small set of very common English words that add noise, not meaning,
// to search matching. Kept intentionally short — expand as you learn more
// about information retrieval (stemming, lemmatization, etc.).
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "he", "in", "is", "it", "its", "of", "on", "that", "the",
  "to", "was", "were", "will", "with",
]);

/**
 * Turns raw text into a normalized list of tokens:
 * lowercased, punctuation stripped, split on whitespace, stopwords removed.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * Tokenizes a search query the same way documents are tokenized,
 * so query terms and indexed terms line up.
 */
export function tokenizeQuery(query: string): string[] {
  return tokenize(query);
}
