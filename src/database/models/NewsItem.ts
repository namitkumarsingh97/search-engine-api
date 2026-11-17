import mongoose, { Schema, Document as MongoDocument } from "mongoose";

/** One change shipped to a product, taken from a commit in its public GitHub repo. */
export interface NewsItemDocument extends MongoDocument {
  /** Slug of the product (AppEntry) this belongs to. */
  appSlug: string;
  /** "owner/name" of the GitHub repo. */
  repo: string;
  sha: string;
  /** First line of the commit message: what changed. */
  message: string;
  /** Rest of the commit message, kept for search only. */
  body: string;
  /** Link to the commit on GitHub. */
  url: string;
  committedAt: Date;
  /** Admin can hide an item; hidden items never show or get searched. */
  hidden: boolean;
}

const newsItemSchema = new Schema<NewsItemDocument>({
  appSlug: { type: String, required: true, index: true },
  repo: { type: String, required: true },
  sha: { type: String, required: true },
  message: { type: String, required: true, maxlength: 200 },
  body: { type: String, default: "", maxlength: 1000 },
  url: { type: String, required: true },
  committedAt: { type: Date, required: true, index: true },
  hidden: { type: Boolean, default: false },
});

// The same commit is never stored twice, however often a sync re-reads it.
newsItemSchema.index({ repo: 1, sha: 1 }, { unique: true });

export const NewsItem = mongoose.model<NewsItemDocument>("NewsItem", newsItemSchema);
