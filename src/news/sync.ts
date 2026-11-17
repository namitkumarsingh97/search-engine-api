import { AppEntry } from "../database/models/AppEntry";
import { Meta } from "../database/models/AppEntry";
import { NewsItem, NewsItemDocument } from "../database/models/NewsItem";
import { searchIndex } from "../search/indexer";

const DAY_MS = 86_400_000;
/** How far back the first sync looks: news is "recent changes", not a full history. */
const BACKFILL_DAYS = 90;
const REFRESH_MS = Number(process.env.NEWS_REFRESH_MINUTES ?? 15) * 60_000;
const MAX_PER_REPO = 30;

interface GithubCommit {
  sha: string;
  html_url: string;
  parents?: unknown[];
  commit: { message: string; author?: { date?: string } | null; committer?: { date?: string } | null };
  author?: { login?: string; type?: string } | null;
}

/** Merge commits, bots and one-word messages say nothing useful to a reader. */
function isNoise(c: GithubCommit): boolean {
  const subject = c.commit.message.split("\n")[0].trim();
  if ((c.parents?.length ?? 0) > 1) return true;
  if (/^merge\b/i.test(subject)) return true;
  if (c.author?.type === "Bot" || c.author?.login?.endsWith("[bot]")) return true;
  if (subject.length < 8) return true;
  return /^(wip|update|updates|fix|fixes|changes|commit|initial commit|test|tests)$/i.test(subject);
}

/** Splits a commit message into the headline and the rest, dropping "Co-Authored-By"-style trailers. */
function splitMessage(raw: string): { message: string; body: string } {
  const [first, ...rest] = raw.split("\n");
  const body = rest
    .filter((l) => !/^\s*(co-authored-by|signed-off-by|generated with)/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { message: first.trim().slice(0, 140), body: body.slice(0, 500) };
}

async function fetchCommits(repo: string, since: Date): Promise<GithubCommit[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "Nexa-News" };
  // Optional. Public repos work without it, but anonymous requests are limited to 60 an hour per IP.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const url = `https://api.github.com/repos/${repo}/commits?per_page=${MAX_PER_REPO}&since=${encodeURIComponent(since.toISOString())}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  // 404 = missing or private repo, 409 = empty repo: nothing to show, not an error worth failing the sync for.
  if (res.status === 404 || res.status === 409) return [];
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}`);
  return (await res.json()) as GithubCommit[];
}

// ---- Search index ------------------------------------------------------------------

const indexedIds = new Set<string>();

function indexItem(item: NewsItemDocument, productName: string): void {
  const id = `news:${item._id}`;
  indexedIds.add(id);
  searchIndex.addDocument({
    id,
    type: "news",
    title: `${productName}: ${item.message}`,
    url: item.url,
    content: [item.message, item.body, productName].filter(Boolean).join(" — "),
    headings: "",
    date: item.committedAt.toISOString(),
  });
}

/** Rebuilds the news part of the search index from the database, for visible products only. */
export async function reindexNews(): Promise<number> {
  for (const id of indexedIds) searchIndex.removeDocument(id);
  indexedIds.clear();

  const apps = await AppEntry.find({ visible: true });
  const names = new Map(apps.map((a) => [a.slug, a.name]));
  const items = await NewsItem.find({ hidden: false, appSlug: { $in: [...names.keys()] } });
  items.forEach((i) => indexItem(i, names.get(i.appSlug)!));
  return items.length;
}

// ---- Sync ----------------------------------------------------------------------------

export interface SyncResult {
  added: number;
  repos: number;
  errors: string[];
}

let running: Promise<SyncResult> | null = null;

/** Reads new commits for every product that has repos, and stores them. One run at a time. */
export function syncNews(): Promise<SyncResult> {
  if (!running) {
    running = doSync().finally(() => {
      running = null;
    });
  }
  return running;
}

async function doSync(): Promise<SyncResult> {
  const result: SyncResult = { added: 0, repos: 0, errors: [] };
  const apps = await AppEntry.find({ visible: true, "repos.0": { $exists: true } });

  for (const app of apps) {
    for (const repo of app.repos) {
      result.repos++;
      try {
        const latest = await NewsItem.findOne({ repo }).sort({ committedAt: -1 });
        // Re-read from just before the newest stored commit, so nothing is missed at the boundary.
        const since = latest ? new Date(latest.committedAt.getTime() - 60_000) : new Date(Date.now() - BACKFILL_DAYS * DAY_MS);

        for (const c of (await fetchCommits(repo, since)).filter((x) => !isNoise(x))) {
          const { message, body } = splitMessage(c.commit.message);
          const when = c.commit.committer?.date ?? c.commit.author?.date;
          if (!message || !when) continue;

          const res = await NewsItem.updateOne(
            { repo, sha: c.sha },
            { $setOnInsert: { appSlug: app.slug, repo, sha: c.sha, message, body, url: c.html_url, committedAt: new Date(when), hidden: false } },
            { upsert: true },
          );
          if (res.upsertedCount > 0) result.added++;
        }
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  await Meta.updateOne({ key: "news_last_sync" }, { $set: { value: String(Date.now()) } }, { upsert: true });
  if (result.added > 0) await reindexNews();
  return result;
}

/**
 * Called on each news request: if the last sync is older than the refresh interval,
 * sync now (waiting at most a few seconds, then answering with what is stored).
 * This keeps the feed automatic without a background job, which serverless hosts don't have.
 */
export async function ensureFresh(): Promise<void> {
  const last = Number((await Meta.findOne({ key: "news_last_sync" }))?.value ?? 0);
  if (Date.now() - last < REFRESH_MS) return;

  const sync = syncNews().catch((err) => console.error("[news] sync failed:", err));
  await Promise.race([sync, new Promise((resolve) => setTimeout(resolve, 6000))]);
}
