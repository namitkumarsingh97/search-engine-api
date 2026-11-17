import { User } from "../database/models/User";

/** Everything after the @ in a Nexa address. A label inside Nexa: nothing is ever sent to this domain on the internet. */
export const MAIL_DOMAIN = (process.env.MAIL_DOMAIN ?? "nexa.com").toLowerCase();

// 3-30 characters: lowercase letters, digits, dot, dash, underscore. Starts and ends with a letter or digit.
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$/;

/** Names nobody may take: they look official or are used by the system itself. */
const RESERVED = new Set([
  "admin", "administrator", "root", "postmaster", "hostmaster", "webmaster", "abuse", "security", "support", "help",
  "info", "contact", "mail", "email", "noreply", "no-reply", "mailer-daemon", "welcome", "system", "nexa", "team",
  "staff", "billing", "privacy", "legal", "news", "notifications", "accounts", "account", "api", "www",
]);

/** "Ada@Nexa.com" and " ada " both become "ada". */
export function normalizeHandle(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(new RegExp(`@${MAIL_DOMAIN.replace(/\./g, "\\.")}$`), "");
}

/** A human-readable problem with the handle, or null if it is acceptable (format only, not uniqueness). */
export function handleProblem(handle: string): string | null {
  if (handle.includes("@")) return `Use just the name before @${MAIL_DOMAIN}.`;
  if (!HANDLE_RE.test(handle) || /[._-]{2}/.test(handle)) {
    return "Use 3 to 30 letters, digits, dots, dashes or underscores, starting and ending with a letter or digit, with no doubled symbols.";
  }
  if (RESERVED.has(handle)) return "That name is reserved.";
  return null;
}

export const addressOf = (handle: string) => `${handle}@${MAIL_DOMAIN}`;

/** A free handle based on the person's name (or their email's first part), adding a number if needed. */
export async function generateHandle(name: string, email: string): Promise<string> {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // drop accents: "é" -> "e"
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "");

  let base = clean(name).slice(0, 24) || clean(email.split("@")[0]).slice(0, 24) || "user";
  while (base.length < 3) base += "0";
  if (handleProblem(base)) base = `user.${base}`.slice(0, 24).replace(/[._-]+$/, "0");

  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? base : `${base}${n + 1}`;
    if (!handleProblem(candidate) && !(await User.exists({ handle: candidate }))) return candidate;
  }
  // Practically unreachable: fall back to something random.
  return `user${Math.random().toString(36).slice(2, 10)}`;
}

/** Gives a handle to every account that doesn't have one yet (accounts created before addresses existed). */
export async function backfillHandles(): Promise<number> {
  const users = await User.find({ $or: [{ handle: { $exists: false } }, { handle: null }] });
  let done = 0;
  for (const user of users) {
    try {
      const handle = await generateHandle(user.name, user.email);
      // Set only the handle (no full save), so an old account with other quirks can't block it.
      const result = await User.updateOne({ _id: user._id, $or: [{ handle: { $exists: false } }, { handle: null }] }, { $set: { handle } });
      if (result.modifiedCount > 0) done++;
    } catch {
      // Another server instance got there first (unique index): fine, skip.
    }
  }
  return done;
}
