import mongoose, { Schema, Document as MongoDocument } from "mongoose";

/**
 * A one-time sign-in code, handed to the app that asked for the sign-in. It is
 * exchanged for a real token exactly once, within seconds, and only by the same
 * redirect address it was issued for. Only a hash of the code is stored.
 */
export interface AuthCodeDocument extends MongoDocument {
  codeHash: string;
  userId: string;
  /** The exact address the user is sent back to. The exchange must present the same one. */
  redirectUri: string;
  expiresAt: Date;
}

const authCodeSchema = new Schema<AuthCodeDocument>({
  codeHash: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  redirectUri: { type: String, required: true },
  // MongoDB deletes the document shortly after this time; the exchange also checks it itself.
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

export const AuthCode = mongoose.model<AuthCodeDocument>("AuthCode", authCodeSchema);
