export type DocType = "web" | "file" | "mail" | "event" | "video" | "news";

export const DOC_TYPES: DocType[] = ["web", "file", "mail", "event", "video", "news"];

export interface Document {
  id: string;
  /** Kind of content. Missing means "web" (crawled pages, sample data). */
  type?: DocType;
  /** Owner of private content. Missing means public (web pages). */
  ownerId?: string;
  title: string;
  url: string;
  content: string;
  headings?: string;
  domain?: string;
  crawledAt?: string;
  /** When the content is "from": sent time, upload time, event start. Drives recency ranking and date sort. */
  date?: string;
  /** Adults-only subject matter (sex education, alcohol, gambling...). Hidden unless the viewer confirmed they are 18+. */
  mature?: boolean;
}

/** Marks around matched words in `snippet` / `titleMarked`. The UI turns them into <mark>. */
export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";

export interface ScoredResult {
  id: string;
  type: DocType;
  title: string;
  /** Title with MARK_OPEN / MARK_CLOSE around matched words. */
  titleMarked: string;
  url: string;
  /** Excerpt with MARK_OPEN / MARK_CLOSE around matched words. */
  snippet: string;
  score: number;
  date?: string;
}

export type SearchFacets = Record<"all" | DocType, number>;

export interface SearchResponse {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  tookMs: number;
  results: ScoredResult[];
  /** Result counts per type for this query (ignoring the type filter), for the tabs. */
  facets: SearchFacets;
  /** "Did you mean" query when a word looked misspelled. */
  suggestion?: string;
  /** True while mature results are being hidden (the default). */
  safeSearch: boolean;
  /** How many mature results were hidden for this query. */
  matureHidden: number;
  /** The search touches adult topics: the UI should ask the visitor to confirm they are 18+. */
  ageCheck: boolean;
}

export type InvertedIndex = Map<string, Set<string>>;
