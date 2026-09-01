import { Document, InvertedIndex } from "../types";
import { tokenize } from "./tokenizer";

/**
 * Holds the inverted index plus the document store it was built from,
 * so search/ranking can look documents back up by id.
 */
export class SearchIndex {
  private index: InvertedIndex = new Map();
  private documents: Map<string, Document> = new Map();

  get size(): number {
    return this.documents.size;
  }

  get termCount(): number {
    return this.index.size;
  }

  getDocument(id: string): Document | undefined {
    return this.documents.get(id);
  }

  getAllDocuments(): Document[] {
    return Array.from(this.documents.values());
  }

  getPostings(term: string): Set<string> {
    return this.index.get(term) ?? new Set();
  }

  getAllTerms(): string[] {
    return Array.from(this.index.keys());
  }

  docsContainingTerm(term: string): number {
    return this.index.get(term)?.size ?? 0;
  }

  /** Adds or replaces a single document in the index. Safe to call repeatedly
   * as the crawler discovers pages one at a time. */
  addDocument(doc: Document): void {
    // If this doc was already indexed (recrawl), remove its old postings first.
    if (this.documents.has(doc.id)) {
      this.removeDocument(doc.id);
    }

    this.documents.set(doc.id, doc);

    const combinedText = [doc.title, doc.headings ?? "", doc.content].join(" ");
    const terms = tokenize(combinedText);

    for (const term of terms) {
      if (!this.index.has(term)) {
        this.index.set(term, new Set());
      }
      this.index.get(term)!.add(doc.id);
    }
  }

  addDocuments(docs: Document[]): void {
    for (const doc of docs) {
      this.addDocument(doc);
    }
  }

  removeDocument(id: string): void {
    if (!this.documents.has(id)) return;
    this.documents.delete(id);

    for (const [term, postings] of this.index) {
      postings.delete(id);
      if (postings.size === 0) {
        this.index.delete(term);
      }
    }
  }

  clear(): void {
    this.index.clear();
    this.documents.clear();
  }
}

// A single shared index instance for the whole process — the crawler writes
// to it, the search routes read from it. Swap this out for something
// persisted (or rebuilt from Mongo on boot) once the in-memory approach
// stops being enough.
export const searchIndex = new SearchIndex();
