import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export interface UserDocument extends MongoDocument {
  email: string;
  name: string;
  /** The part before @nexa.com in the user's Nexa mail address. Unique. */
  handle?: string;
  passwordHash: string;
  createdAt: Date;
}

const userSchema = new Schema<UserDocument>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  handle: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const User = mongoose.model<UserDocument>("User", userSchema);
