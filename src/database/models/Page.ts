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
  mature: boolean;
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
  /** Adults-only subject matter: hidden from search unless the visitor confirmed they are 18+. */
  mature: { type: Boolean, default: false },
});

export const Page = mongoose.model<PageDocument>("Page", pageSchema);
