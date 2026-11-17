import mongoose, { Schema, Document as MongoDocument } from "mongoose";

/**
 * A "Nexa app": one of the owner's own projects, presented as a feature of
 * Nexa (like Drive or Calendar) that routes to its deployed URL on click.
 */
export interface AppEntryDocument extends MongoDocument {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  /** Where clicking the app goes. Always http(s). */
  url: string;
  /** Name from the UI's icon set, e.g. "briefcase". */
  icon: string;
  /** Flat color block: mustard | orange | charcoal | paper. */
  tone: string;
  /** Extra words that should find this app in search. */
  keywords: string[];
  openInNewTab: boolean;
  visible: boolean;
  order: number;
}

const appEntrySchema = new Schema<AppEntryDocument>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    tagline: { type: String, default: "", trim: true, maxlength: 90 },
    description: { type: String, default: "", trim: true, maxlength: 400 },
    url: { type: String, required: true, trim: true, maxlength: 500 },
    icon: { type: String, default: "layout-grid" },
    tone: { type: String, enum: ["mustard", "orange", "charcoal", "paper"], default: "mustard" },
    keywords: { type: [String], default: [] },
    openInNewTab: { type: Boolean, default: false },
    visible: { type: Boolean, default: true },
    order: { type: Number, default: 100 },
  },
  { timestamps: true },
);

export const AppEntry = mongoose.model<AppEntryDocument>("AppEntry", appEntrySchema);

/** Tiny key/value store for one-off flags such as "default apps already seeded". */
const metaSchema = new Schema({ key: { type: String, required: true, unique: true }, value: String });
export const Meta = mongoose.model("Meta", metaSchema);
