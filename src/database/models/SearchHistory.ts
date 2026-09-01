import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export interface SearchHistoryDocument extends MongoDocument {
  query: string;
  resultCount: number;
  createdAt: Date;
}

const searchHistorySchema = new Schema<SearchHistoryDocument>({
  query: { type: String, required: true, index: true },
  resultCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

export const SearchHistory = mongoose.model<SearchHistoryDocument>(
  "SearchHistory",
  searchHistorySchema
);
