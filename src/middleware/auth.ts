import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set — add it to .env");
}

export interface AuthedRequest extends Request {
  userId?: string;
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET as string, { expiresIn: "7d" });
}

function readUserId(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET as string);
    return typeof payload === "object" && typeof payload.sub === "string"
      ? payload.sub
      : undefined;
  } catch {
    return undefined;
  }
}

/** Sets req.userId when a valid token is present; never rejects. */
export function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  req.userId = readUserId(req);
  next();
}

/** Rejects with 401 unless a valid token is present. */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const userId = readUserId(req);
  if (!userId) return res.status(401).json({ error: "Authentication required" });
  req.userId = userId;
  next();
}
