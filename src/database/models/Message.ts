import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export interface Address {
  /** Set when the address belongs to a registered user. */
  userId?: string;
  name: string;
  email: string;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
}

/** One email. Each user's view of it (folder, read, starred) lives in a MailItem. */
export interface MessageDocument extends MongoDocument {
  threadId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  /** Plain text only: never rendered as HTML, so there is nothing to sanitize. */
  body: string;
  attachments: Attachment[];
  /** Null while it is still a draft. */
  sentAt: Date | null;
  createdAt: Date;
}

const addressSchema = new Schema<Address>(
  { userId: String, name: { type: String, default: "" }, email: { type: String, required: true } },
  { _id: false },
);

const attachmentSchema = new Schema<Attachment>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    mimeType: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
    storageKey: { type: String, required: true },
  },
  { _id: false },
);

const messageSchema = new Schema<MessageDocument>(
  {
    threadId: { type: String, required: true, index: true },
    from: { type: addressSchema, required: true },
    to: { type: [addressSchema], default: [] },
    cc: { type: [addressSchema], default: [] },
    subject: { type: String, default: "", maxlength: 200 },
    body: { type: String, default: "", maxlength: 100_000 },
    attachments: { type: [attachmentSchema], default: [] },
    sentAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const Message = mongoose.model<MessageDocument>("Message", messageSchema);
