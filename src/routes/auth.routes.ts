import bcrypt from "bcryptjs";
import { Router } from "express";
import { User, UserDocument } from "../database/models/User";
import { asyncHandler } from "../middleware/asyncHandler";
import { isAdminUser } from "../middleware/admin";
import { AuthedRequest, requireAuth, signToken } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Slows down password guessing and mass sign-ups from one address.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Too many attempts. Try again in a few minutes.",
});

async function publicUser(u: UserDocument) {
  return { id: String(u._id), email: u.email, name: u.name, isAdmin: await isAdminUser(u) };
}

// POST /api/auth/register  { email, name, password }
authRouter.post("/register", authLimiter, asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const name = String(req.body?.name ?? "").trim();
  const password = String(req.body?.password ?? "");

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Valid email is required" });
  if (!name) return res.status(400).json({ error: "Name is required" });
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  if (await User.exists({ email })) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, name, passwordHash });

  res.status(201).json({ token: signToken(String(user._id)), user: await publicUser(user) });
}));

// POST /api/auth/login  { email, password }
authRouter.post("/login", authLimiter, asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  const user = await User.findOne({ email });
  // Same message for unknown email and wrong password, so accounts can't be enumerated.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  res.json({ token: signToken(String(user._id)), user: await publicUser(user) });
}));

// GET /api/auth/me
authRouter.get("/me", requireAuth, asyncHandler<AuthedRequest>(async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(401).json({ error: "Account no longer exists" });
  res.json({ user: await publicUser(user) });
}));
