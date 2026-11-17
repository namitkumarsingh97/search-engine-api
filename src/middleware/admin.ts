import { NextFunction, Response } from "express";
import { User, UserDocument } from "../database/models/User";
import { AuthedRequest, requireAuth } from "./auth";

/**
 * Who is an admin:
 *  - if ADMIN_EMAILS is set (comma separated), exactly those accounts;
 *  - otherwise the oldest account in the database (the person who set this up).
 */
export async function isAdminUser(user: Pick<UserDocument, "_id" | "email">): Promise<boolean> {
  const configured = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (configured.length > 0) return configured.includes(user.email.toLowerCase());

  const oldest = await User.findOne().sort({ _id: 1 }).select("_id");
  return Boolean(oldest) && String(oldest!._id) === String(user._id);
}

/** 401 without a valid token, 403 for signed-in users who are not admins. */
export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, async () => {
    try {
      const user = await User.findById(req.userId);
      if (!user || !(await isAdminUser(user))) return res.status(403).json({ error: "Admin access required" });
      next();
    } catch (err) {
      next(err);
    }
  });
}
