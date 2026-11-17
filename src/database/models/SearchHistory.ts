import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export interface SearchHistoryDocument extends MongoDocument {
  query: string;
  resultCount: number;
  /** Set for signed-in users: their personal history. Missing for anonymous searches. */
  userId?: string;
  createdAt: Date;
}

const searchHistorySchema = new Schema<SearchHistoryDocument>({
  query: { type: String, required: true, index: true },
  resultCount: { type: Number, default: 0 },
  userId: { type: String },
  createdAt: { type: Date, default: Date.now, index: true },
});

searchHistorySchema.index({ userId: 1, createdAt: -1 });

export const SearchHistory = mongoose.model<SearchHistoryDocument>(
  "SearchHistory",
  searchHistorySchema
);
