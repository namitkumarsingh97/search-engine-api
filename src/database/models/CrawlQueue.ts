import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export type CrawlStatus = "queued" | "success" | "failed";

export interface CrawlQueueDocument extends MongoDocument {
  url: string;
  status: CrawlStatus;
  depth: number;
  createdAt: Date;
  crawledAt?: Date;
  error?: string;
}

const crawlQueueSchema = new Schema<CrawlQueueDocument>({
  url: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ["queued", "success", "failed"], default: "queued" },
  depth: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  crawledAt: { type: Date },
  error: { type: String },
});

export const CrawlQueue = mongoose.model<CrawlQueueDocument>(
  "CrawlQueue",
  crawlQueueSchema
);
