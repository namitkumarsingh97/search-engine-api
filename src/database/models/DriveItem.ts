import mongoose, { Schema, Document as MongoDocument, Types } from "mongoose";

export interface DriveItemDocument extends MongoDocument {
  ownerId: string;
  parentId: Types.ObjectId | null;
  kind: "file" | "folder";
  name: string;
  mimeType: string;
  size: number;
  /** Where the bytes live in FileStorage (files only). */
  storageKey?: string;
  /** Extracted text, capped; this is what makes file contents searchable. */
  content: string;
  /** Non-null while the item is in the trash. */
  trashedAt: Date | null;
  /** Set while a public share link is active (files only). */
  shareToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

const driveItemSchema = new Schema<DriveItemDocument>(
  {
    ownerId: { type: String, required: true, index: true },
    parentId: { type: Schema.Types.ObjectId, default: null, index: true },
    kind: { type: String, enum: ["file", "folder"], required: true },
    name: { type: String, required: true, trim: true },
    mimeType: { type: String, default: "" },
    size: { type: Number, default: 0 },
    storageKey: { type: String },
    content: { type: String, default: "" },
    trashedAt: { type: Date, default: null },
    shareToken: { type: String, index: true, sparse: true, unique: true },
  },
  { timestamps: true },
);

export const DriveItem = mongoose.model<DriveItemDocument>("DriveItem", driveItemSchema);
