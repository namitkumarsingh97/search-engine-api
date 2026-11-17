import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export interface VideoDocument extends MongoDocument {
  ownerId: string;
  ownerName: string;
  title: string;
  description: string;
  /** public: anyone can watch and find it in search. private: owner only. */
  visibility: "public" | "private";
  mimeType: string;
  size: number;
  storageKey: string;
  thumbnailKey?: string;
  /** Seconds; only known when ffmpeg is available. */
  duration?: number;
  views: number;
  likes: string[];
  commentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const videoSchema = new Schema<VideoDocument>(
  {
    ownerId: { type: String, required: true, index: true },
    ownerName: { type: String, required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, default: "", maxlength: 5000 },
    visibility: { type: String, enum: ["public", "private"], default: "public", index: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    storageKey: { type: String, required: true },
    thumbnailKey: { type: String },
    duration: { type: Number },
    views: { type: Number, default: 0 },
    likes: { type: [String], default: [] },
    commentCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

videoSchema.index({ createdAt: -1 });

export const Video = mongoose.model<VideoDocument>("Video", videoSchema);
