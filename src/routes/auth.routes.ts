import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { Request, Response, Router } from "express";
import { addressOf, generateHandle, handleProblem, normalizeHandle } from "../auth/handle";
import { AuthCode } from "../database/models/AuthCode";
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
  return {
    id: String(u._id),
    email: u.email,
    name: u.name,
    handle: u.handle ?? null,
    address: u.handle ? addressOf(u.handle) : null,
    isAdmin: await isAdminUser(u),
  };
}

// ---- Sign-in through a separate accounts app ------------------------------------------
// The login/sign-up pages can live in their own project (search-engine-auth). After a
// successful sign-in it must send the user back to the app they came from, without ever
// putting a token in a URL. So: login/register accept a `redirectUri`, and instead of a
// token they return a one-time `code`; the app swaps that code for a token via /exchange.

const CODE_TTL_MS = 60_000;

/** Origins that may receive a sign-in: the apps that use the accounts app. Falls back to CORS_ORIGIN. */
function allowedRedirectOrigins(): string[] {
  const raw = process.env.AUTH_ALLOWED_ORIGINS ?? process.env.CORS_ORIGIN ?? "http://localhost:3000";
  return raw.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
}

/** The normalised redirect address, or null if it isn't an http(s) address on an allowed origin. */
function checkRedirect(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null; // https://allowed.com@evil.com style tricks
    return allowedRedirectOrigins().includes(u.origin) ? u.toString() : null;
  } catch {
    return null;
  }
}

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

/** Reads an optional redirectUri from the body. Replies 400 (and returns false) if it is present but not allowed. */
function readRedirect(req: Request, res: Response): { ok: boolean; uri?: string } {
  if (req.body?.redirectUri === undefined) return { ok: true };
  const uri = checkRedirect(req.body.redirectUri);
  if (!uri) {
    res.status(400).json({ error: "That return address isn't allowed." });
    return { ok: false };
  }
  return { ok: true, uri };
}

/** Sends either a normal session (token) or, when a redirect was asked for, a one-time code. */
async function respondSignedIn(res: Response, user: UserDocument, status: number, redirectUri?: string) {
  if (!redirectUri) {
    return res.status(status).json({ token: signToken(String(user._id)), user: await publicUser(user) });
  }
  const code = randomBytes(32).toString("base64url");
  await AuthCode.create({ codeHash: hashCode(code), userId: String(user._id), redirectUri, expiresAt: new Date(Date.now() + CODE_TTL_MS) });
  return res.status(status).json({ code, expiresIn: CODE_TTL_MS / 1000 });
}

// POST /api/auth/register  { email, name, password }
authRouter.post("/register", authLimiter, asyncHandler(async (req, res) => {
  const redirect = readRedirect(req, res);
  if (!redirect.ok) return;

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

  // The person's Nexa mail address: the one they asked for, or one made from their name.
  let handle: string;
  if (req.body?.handle !== undefined && String(req.body.handle).trim() !== "") {
    handle = normalizeHandle(req.body.handle);
    const problem = handleProblem(handle);
    if (problem) return res.status(400).json({ error: problem });
    if (await User.exists({ handle })) return res.status(409).json({ error: "That Nexa address is already taken" });
  } else {
    handle = await generateHandle(name, email);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let user: UserDocument;
  try {
    user = await User.create({ email, name, handle, passwordHash });
  } catch (err) {
    // Lost a race for the same handle between the check above and the insert.
    if ((err as { code?: number }).code === 11000) return res.status(409).json({ error: "That Nexa address is already taken" });
    throw err;
  }

  await respondSignedIn(res, user, 201, redirect.uri);
}));

// POST /api/auth/login  { email, password }
authRouter.post("/login", authLimiter, asyncHandler(async (req, res) => {
  const redirect = readRedirect(req, res);
  if (!redirect.ok) return;

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  const user = await User.findOne({ email });
  // Same message for unknown email and wrong password, so accounts can't be enumerated.
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  await respondSignedIn(res, user, 200, redirect.uri);
}));

// POST /api/auth/exchange  { code, redirectUri }  ->  { token, user }
// Single use: the code is deleted the moment it is looked up, and only works for the redirect it was issued for.
authRouter.post("/exchange", authLimiter, asyncHandler(async (req, res) => {
  const code = String(req.body?.code ?? "");
  const redirectUri = checkRedirect(req.body?.redirectUri);
  if (!code || !redirectUri) return res.status(400).json({ error: "Invalid or expired sign-in code." });

  const record = await AuthCode.findOneAndDelete({ codeHash: hashCode(code), redirectUri });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: "Invalid or expired sign-in code." });
  }

  const user = await User.findById(record.userId);
  if (!user) return res.status(400).json({ error: "Invalid or expired sign-in code." });
  res.json({ token: signToken(String(user._id)), user: await publicUser(user) });
}));

// GET /api/auth/handle-available?handle=ada  — for the sign-up form (public, rate limited)
const handleCheckLimiter = rateLimit({ windowMs: 60_000, max: 60, message: "Too many checks. Wait a moment." });
authRouter.get("/handle-available", handleCheckLimiter, asyncHandler(async (req, res) => {
  const handle = normalizeHandle(req.query.handle);
  if (!handle) return res.json({ available: false, error: "Choose a name for your address." });
  const problem = handleProblem(handle);
  if (problem) return res.json({ available: false, error: problem });
  const taken = await User.exists({ handle });
  res.json({ available: !taken, address: addressOf(handle), error: taken ? "That address is already taken." : null });
}));

// GET /api/auth/me
authRouter.get("/me", requireAuth, asyncHandler<AuthedRequest>(async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(401).json({ error: "Account no longer exists" });
  res.json({ user: await publicUser(user) });
}));
