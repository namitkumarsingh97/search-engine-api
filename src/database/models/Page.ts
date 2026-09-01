import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export interface PageDocument extends MongoDocument {
  url: string;
  title: string;
  description: string;
  content: string;
  headings: string;
  links: string[];
  domain: string;
  crawledAt: Date;
}

const pageSchema = new Schema<PageDocument>({
  url: { type: String, required: true, unique: true, index: true },
  title: { type: String, default: "" },
  description: { type: String, default: "" },
  content: { type: String, default: "" },
  headings: { type: String, default: "" },
  links: { type: [String], default: [] },
  domain: { type: String, index: true },
  crawledAt: { type: Date, default: Date.now },
});

export const Page = mongoose.model<PageDocument>("Page", pageSchema);
