import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export interface VideoCommentDocument extends MongoDocument {
  videoId: mongoose.Types.ObjectId;
  userId: string;
  userName: string;
  text: string;
  createdAt: Date;
}

const commentSchema = new Schema<VideoCommentDocument>({
  videoId: { type: Schema.Types.ObjectId, required: true, index: true },
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  text: { type: String, required: true, maxlength: 2000 },
  createdAt: { type: Date, default: Date.now },
});

export const VideoComment = mongoose.model<VideoCommentDocument>("VideoComment", commentSchema);
