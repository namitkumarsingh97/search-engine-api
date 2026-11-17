import { Document, InvertedIndex } from "../types";
import { tokenize } from "./tokenizer";

/** How much a match in each part of a document counts for. */
export const FIELD_WEIGHTS = { title: 5, headings: 3, url: 2, body: 1 } as const;

/** What the index remembers about one document, so queries never re-tokenize text. */
export interface IndexedDoc {
  doc: Document;
  /** Field-weighted term frequencies: title hits count 5x, headings 3x, url 2x, body 1x. */
  tf: Map<string, number>;
  /** Field-weighted length, the BM25 "document length". */
  length: number;
  titleTerms: Set<string>;
}

/** "https://www.example.com/a/b" -> "example com a b" tokens, without noise like "https" and "www". */
function urlTokens(url: string): string[] {
  return tokenize(url.replace(/^https?:\/\/(www\.)?/i, ""));
}

/**
 * Inverted index plus the per-document statistics BM25 ranking needs.
 * Documents of every type (web, file, mail, event, video) live here; access
 * control is applied at query time (see search.ts).
 */
export class SearchIndex {
  private postings: InvertedIndex = new Map();
  private docs: Map<string, IndexedDoc> = new Map();
  private totalLength = 0;

  get size(): number {
    return this.docs.size;
  }

  get termCount(): number {
    return this.postings.size;
  }

  get avgDocLength(): number {
    return this.docs.size === 0 ? 0 : this.totalLength / this.docs.size;
  }

  getDocument(id: string): Document | undefined {
    return this.docs.get(id)?.doc;
  }

  getIndexed(id: string): IndexedDoc | undefined {
    return this.docs.get(id);
  }

  getAllDocuments(): Document[] {
    return Array.from(this.docs.values(), (d) => d.doc);
  }

  getPostings(term: string): Set<string> {
    return this.postings.get(term) ?? new Set();
  }

  getAllTerms(): string[] {
    return Array.from(this.postings.keys());
  }

  docsContainingTerm(term: string): number {
    return this.postings.get(term)?.size ?? 0;
  }

  /** Adds or replaces a single document. Safe to call repeatedly as content changes. */
  addDocument(doc: Document): void {
    if (this.docs.has(doc.id)) this.removeDocument(doc.id);

    const type = doc.type ?? "web";
    const title = tokenize(doc.title);
    const headings = tokenize(doc.headings ?? "");
    // Only web URLs carry meaning; internal links like /drive?open=<id> would match every Drive file on "drive".
    const url = type === "web" ? urlTokens(doc.url) : [];
    const body = tokenize(doc.content);

    const tf = new Map<string, number>();
    const add = (tokens: string[], weight: number) => {
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
    };
    add(title, FIELD_WEIGHTS.title);
    add(headings, FIELD_WEIGHTS.headings);
    add(url, FIELD_WEIGHTS.url);
    add(body, FIELD_WEIGHTS.body);

    const length =
      title.length * FIELD_WEIGHTS.title +
      headings.length * FIELD_WEIGHTS.headings +
      url.length * FIELD_WEIGHTS.url +
      body.length * FIELD_WEIGHTS.body;

    this.docs.set(doc.id, { doc, tf, length, titleTerms: new Set(title) });
    this.totalLength += length;

    for (const term of tf.keys()) {
      let set = this.postings.get(term);
      if (!set) this.postings.set(term, (set = new Set()));
      set.add(doc.id);
    }
  }

  addDocuments(docs: Document[]): void {
    for (const doc of docs) this.addDocument(doc);
  }

  removeDocument(id: string): void {
    const entry = this.docs.get(id);
    if (!entry) return;
    this.docs.delete(id);
    this.totalLength -= entry.length;

    // Only this document's own terms need touching (not the whole vocabulary).
    for (const term of entry.tf.keys()) {
      const set = this.postings.get(term);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.postings.delete(term);
    }
  }

  clear(): void {
    this.postings.clear();
    this.docs.clear();
    this.totalLength = 0;
  }
}

// A single shared index instance for the whole process: the crawler and the
// Drive/Video/Calendar/Mail modules write to it, the search routes read from it.
// It is rebuilt from MongoDB on boot (see server.ts).
export const searchIndex = new SearchIndex();
