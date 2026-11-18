import "dotenv/config";
import fs from "fs";
import path from "path";
import { parseHtml } from "../crawler/parser";
import { isAllowedByRobots } from "../crawler/robots";
import { normalizeUrl } from "../crawler/urlQueue";
import { connectDatabase, disconnectDatabase } from "../database/connection";
import { Page } from "../database/models/Page";

/**
 * Fills the web index with a wide range of pages in one go:  npm run crawl:bulk
 *
 *   --max=N        stop after N new pages (default 1500)
 *   --group=text   only groups whose name contains this text
 *   --dry          list what would be crawled, fetch nothing
 *
 * Seeds come from data/seeds.json. For each seed it fetches the page plus other pages of the SAME site
 * (Wikipedia: other articles; docs sites: pages under the same path), up to the group's `pages` limit.
 * Pages already stored are not fetched again, so it is safe to run repeatedly. It is polite: robots.txt is
 * honoured and each site gets at most one request per second (Wikipedia a little faster).
 *
 * Run it on your own computer (it needs minutes, which Vercel doesn't allow). It writes to the database in
 * MONGODB_URI; the live API picks the pages up the next time it starts.
 */

const USER_AGENT = "NexaBot/0.1 (personal search engine project)";
const FETCH_TIMEOUT_MS = 12_000;
const MAX_CONTENT_CHARS = 12_000; // keeps the in-memory index and the database small
const MIN_CONTENT_CHARS = 200;
const CONCURRENCY = 4;
const HOST_DELAY_MS: Record<string, number> = { "en.wikipedia.org": 350 };
const DEFAULT_HOST_DELAY_MS = 1000;

interface Group {
  name: string;
  pages: number;
  wikipedia?: string[];
  seeds?: string[];
}

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const MAX_NEW = Number(arg("max") ?? 1500);
const GROUP_FILTER = (arg("group") ?? "").toLowerCase();
const DRY = process.argv.includes("--dry");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- one request per site per delay, shared by all workers -------------------------------
const nextSlot = new Map<string, number>();
async function waitForHost(host: string) {
  const gap = HOST_DELAY_MS[host] ?? DEFAULT_HOST_DELAY_MS;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + gap);
  if (slot > now) await sleep(slot - now);
}

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: controller.signal });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- which links are worth following ----------------------------------------------------
const SKIP_EXT = /\.(pdf|png|jpe?g|gif|svg|webp|ico|zip|gz|tar|mp[34]|webm|css|js|json|xml|txt)$/i;

function allowedLink(link: string, host: string, prefix: string): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  if (u.hostname !== host || u.search || SKIP_EXT.test(u.pathname)) return false;
  if (!u.pathname.startsWith(prefix)) return false;
  if (host.endsWith("wikipedia.org")) {
    const title = u.pathname.slice("/wiki/".length);
    if (!title || title.includes(":") || title === "Main_Page") return false; // Special:, File:, Help:, ...
  }
  return true;
}

/** The part of the site we stay inside: "/wiki/" for Wikipedia, the seed's own folder for docs sites. */
function prefixOf(seed: URL): string {
  if (seed.hostname.endsWith("wikipedia.org")) return "/wiki/";
  const dir = seed.pathname.endsWith("/") ? seed.pathname : seed.pathname.slice(0, seed.pathname.lastIndexOf("/") + 1);
  return dir || "/";
}

// ---- crawling ------------------------------------------------------------------------------
let newPages = 0;
let failed = 0;
let skipped = 0;

async function crawlSeed(seedUrl: string, limit: number, label: string): Promise<void> {
  const seed = new URL(seedUrl);
  const prefix = prefixOf(seed);
  const queue: string[] = [normalizeUrl(seedUrl)];
  const seen = new Set(queue);
  let counted = 0;

  while (queue.length > 0 && counted < limit && newPages < MAX_NEW) {
    const url = queue.shift()!;

    let links: string[] | null = null;
    const stored = await Page.findOne({ url }).select("links").lean();
    if (stored) {
      links = stored.links ?? [];
      skipped++;
    } else {
      await waitForHost(seed.hostname);
      if (!(await isAllowedByRobots(url))) continue;
      const html = await fetchHtml(url);
      if (!html) {
        failed++;
        continue;
      }
      const parsed = parseHtml(html, url);
      if (parsed.content.length < MIN_CONTENT_CHARS) continue;

      const content = parsed.content.slice(0, MAX_CONTENT_CHARS);
      await Page.findOneAndUpdate(
        { url },
        {
          url,
          title: parsed.title,
          description: content.slice(0, 200),
          content,
          headings: parsed.headings.slice(0, 2000),
          links: parsed.links.slice(0, 150),
          domain: seed.hostname,
          crawledAt: new Date(),
        },
        { upsert: true },
      );
      links = parsed.links;
      newPages++;
      if (newPages % 25 === 0) console.log(`[bulk] ${newPages} new pages so far (${failed} failed)`);
    }
    counted++;

    for (const link of links) {
      let n: string;
      try {
        n = normalizeUrl(link);
      } catch {
        continue;
      }
      if (!seen.has(n) && allowedLink(n, seed.hostname, prefix)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  console.log(`[bulk] ${label}: ${counted} pages`);
}

async function main() {
  const file = path.join(__dirname, "..", "..", "data", "seeds.json");
  const groups: Group[] = (JSON.parse(fs.readFileSync(file, "utf-8")).groups ?? []).filter((g: Group) => g.name.toLowerCase().includes(GROUP_FILTER));

  const jobs: { url: string; limit: number; label: string }[] = [];
  for (const g of groups) {
    for (const title of g.wikipedia ?? []) jobs.push({ url: `https://en.wikipedia.org/wiki/${title}`, limit: g.pages, label: `${g.name} / ${title}` });
    for (const url of g.seeds ?? []) jobs.push({ url, limit: g.pages, label: `${g.name} / ${url}` });
  }
  console.log(`[bulk] ${jobs.length} seeds in ${groups.length} groups, up to ${MAX_NEW} new pages${DRY ? " (dry run)" : ""}`);
  if (DRY) {
    jobs.forEach((j) => console.log(`  ${j.limit} pages from ${j.url}`));
    return;
  }

  await connectDatabase();
  const before = await Page.countDocuments();

  // A small pool of workers; each takes the next seed. The per-site delay keeps them polite.
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length && newPages < MAX_NEW) {
      const job = jobs[cursor++];
      try {
        await crawlSeed(job.url, job.limit, job.label);
      } catch (err) {
        console.error(`[bulk] ${job.label} failed:`, err instanceof Error ? err.message : err);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const after = await Page.countDocuments();
  console.log(`[bulk] done: ${newPages} new pages, ${skipped} already stored, ${failed} failed. Web pages in the database: ${before} -> ${after}`);
  console.log("[bulk] Restart the API so it loads them into its search index.");
}

main()
  .catch((err) => {
    console.error("[bulk] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase().catch(() => undefined);
    process.exit();
  });
