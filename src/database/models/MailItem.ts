import mongoose, { Schema, Document as MongoDocument, Types } from "mongoose";

export type MailFolder = "inbox" | "sent" | "draft" | "trash";

/** One user's copy/view of a Message: which folder it is in, read and starred state. */
export interface MailItemDocument extends MongoDocument {
  userId: string;
  messageId: Types.ObjectId;
  threadId: string;
  folder: MailFolder;
  /** Where to put it back when restored from the trash. */
  prevFolder?: MailFolder;
  read: boolean;
  starred: boolean;
  /** Sort key: sent time, or last edit time for drafts. */
  date: Date;
}

const mailItemSchema = new Schema<MailItemDocument>({
  userId: { type: String, required: true },
  messageId: { type: Schema.Types.ObjectId, required: true, index: true },
  threadId: { type: String, required: true },
  folder: { type: String, enum: ["inbox", "sent", "draft", "trash"], required: true },
  prevFolder: { type: String, enum: ["inbox", "sent", "draft"] },
  read: { type: Boolean, default: false },
  starred: { type: Boolean, default: false },
  date: { type: Date, default: Date.now },
});

mailItemSchema.index({ userId: 1, folder: 1, date: -1 });
mailItemSchema.index({ userId: 1, threadId: 1 });

export const MailItem = mongoose.model<MailItemDocument>("MailItem", mailItemSchema);
