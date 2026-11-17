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

/** The owner's products. Added to a brand-new database once; after that, manage them in /admin/apps. */
const DEFAULT_PRODUCTS = [
  {
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
  {
    slug: "ecotrack-india",
    name: "EcoTrack India",
    tagline: "ESG reporting for Indian SMBs",
    description: "Track sustainability metrics, calculate ESG scores and generate compliance-ready reports.",
    url: "https://ecotrack-india.vercel.app",
    icon: "leaf",
    tone: "mustard",
    keywords: ["ecotrack", "esg", "sustainability", "brsr"],
    openInNewTab: false,
    visible: true,
    order: 20,
  },
  {
    slug: "namit-singh",
    name: "Namit Singh",
    tagline: "Full-stack developer portfolio",
    description: "Full-Stack Developer & Digital Solutions Architect: React, Next.js, TypeScript and more.",
    url: "https://namit-singh-portfolio.vercel.app",
    icon: "globe",
    tone: "charcoal",
    keywords: ["namit", "portfolio", "developer", "full-stack", "react", "nextjs"],
    openInNewTab: false,
    visible: true,
    order: 30,
  },
  {
    slug: "kumari-pooja",
    name: "Kumari Pooja",
    tagline: "SEO & digital marketing portfolio",
    description: "Junior SEO & Digital Marketing Executive: on-page, off-page and content systems.",
    url: "https://pooja-seo-portfolio.vercel.app",
    icon: "bar-chart",
    tone: "paper",
    keywords: ["pooja", "portfolio", "seo", "digital marketing", "content"],
    openInNewTab: false,
    visible: true,
    order: 40,
  },
];

/** Adds the default products once, ever. Deleting one later keeps it deleted. */
export async function seedDefaultApps(): Promise<void> {
  if (await Meta.findOne({ key: "apps_seeded" })) return;

  for (const product of DEFAULT_PRODUCTS) {
    await AppEntry.updateOne({ slug: product.slug }, { $setOnInsert: product }, { upsert: true });
  }
  await Meta.create({ key: "apps_seeded", value: new Date().toISOString() });
}
