import { AppEntry, AppEntryDocument, Meta } from "../database/models/AppEntry";
import { tokenize } from "../search/tokenizer";

export interface PublicApp {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  url: string;
  icon: string;
  tone: string;
  openInNewTab: boolean;
}

export function toPublicApp(a: AppEntryDocument): PublicApp {
  return {
    id: String(a._id),
    slug: a.slug,
    name: a.name,
    tagline: a.tagline,
    description: a.description,
    url: a.url,
    icon: a.icon,
    tone: a.tone,
    openInNewTab: a.openInNewTab,
  };
}

/** Only real web links: blocks javascript:, data: and other schemes that could run code. */
export function isSafeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ---- In-memory copy, so search can match apps without a database hit ----------

let cache: { app: PublicApp; tokens: Set<string>; nameTokens: string[] }[] = [];

export async function refreshAppCache(): Promise<void> {
  const apps = await AppEntry.find({ visible: true }).sort({ order: 1, name: 1 });
  cache = apps.map((a) => ({
    app: toPublicApp(a),
    nameTokens: tokenize(a.name),
    tokens: new Set(tokenize([a.name, a.tagline, a.slug.replace(/-/g, " "), ...a.keywords].join(" "))),
  }));
}

export const listVisibleApps = (): PublicApp[] => cache.map((c) => c.app);

/**
 * Apps whose name or keywords match the query, for the "Apps" shelf above
 * search results. Every query word must match the start of one of the app's
 * words ("wf" and "wfms" both find WFMS); a query equal to the name ranks first.
 */
export function matchApps(queryTerms: string[], limit = 3): PublicApp[] {
  if (queryTerms.length === 0) return [];
  const hits: { app: PublicApp; rank: number }[] = [];

  for (const c of cache) {
    const all = [...c.tokens];
    const matches = queryTerms.every((q) => all.some((t) => t === q || (q.length >= 2 && t.startsWith(q))));
    if (!matches) continue;
    const exactName = queryTerms.length === c.nameTokens.length && queryTerms.every((q, i) => c.nameTokens[i] === q);
    hits.push({ app: c.app, rank: exactName ? 0 : c.nameTokens.some((t) => queryTerms.includes(t)) ? 1 : 2 });
  }
  return hits.sort((a, b) => a.rank - b.rank).slice(0, limit).map((h) => h.app);
}

// ---- First-run content -----------------------------------------------------------

/** Adds the default apps once, ever. Deleting one later keeps it deleted. */
export async function seedDefaultApps(): Promise<void> {
  if (await Meta.findOne({ key: "apps_seeded" })) return;

  await AppEntry.updateOne(
    { slug: "wfms" },
    {
      $setOnInsert: {
        slug: "wfms",
        name: "WFMS",
        tagline: "Open the WFMS workspace",
        description: "WFMS, built into Nexa.",
        url: "https://pa-wfms.vercel.app",
        icon: "briefcase",
        tone: "orange",
        keywords: ["wfms"],
        openInNewTab: false,
        visible: true,
        order: 10,
      },
    },
    { upsert: true },
  );
  await Meta.create({ key: "apps_seeded", value: new Date().toISOString() });
}
