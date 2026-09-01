export interface Document {
  id: string;
  title: string;
  url: string;
  content: string;
  headings?: string;
  domain?: string;
  crawledAt?: string;
}

export interface ScoredResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score: number;
}

export interface SearchResponse {
  query: string;
  total: number;
  tookMs: number;
  results: ScoredResult[];
}

export type InvertedIndex = Map<string, Set<string>>;
