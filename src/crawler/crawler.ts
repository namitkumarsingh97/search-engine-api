import { Page } from "../database/models/Page";
import { searchIndex } from "../search/indexer";
import { parseHtml } from "./parser";
import { isAllowedByRobots } from "./robots";
import { normalizeUrl, UrlQueue } from "./urlQueue";

const MAX_PAGES = Number(process.env.MAX_PAGES ?? 100);
const MAX_DEPTH = Number(process.env.MAX_DEPTH ?? 2);
const CRAWL_DELAY_MS = Number(process.env.CRAWL_DELAY_MS ?? 1000);
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "NexaBot/0.1 (+https://example.com/bot)";

export interface CrawlerStatus {
  running: boolean;
  queued: number;
  crawled: number;
  failed: number;
  currentUrl?: string;
}

class Crawler {
  private queue = new UrlQueue();
  private status: CrawlerStatus = {
    running: false,
    queued: 0,
    crawled: 0,
    failed: 0,
  };
  private stopRequested = false;

  getStatus(): CrawlerStatus {
    return { ...this.status, queued: this.queue.length };
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  async start(seedUrls: string[]): Promise<void> {
    if (this.status.running) return;

    this.stopRequested = false;
    this.status = { running: true, queued: 0, crawled: 0, failed: 0 };

    await this.queue.seed(seedUrls);

    // Deliberately not awaited by the caller — this runs in the background
    // while the HTTP request that triggered it returns immediately.
    this.runLoop().catch((err) => {
      console.error("[crawler] fatal error:", err);
      this.status.running = false;
    });
  }

  private async runLoop(): Promise<void> {
    while (
      this.status.crawled < MAX_PAGES &&
      this.queue.length > 0 &&
      !this.stopRequested
    ) {
      const next = this.queue.next();
      if (!next) break;

      const { url, depth } = next;
      this.status.currentUrl = url;

      await this.crawlOne(url, depth);
      await delay(CRAWL_DELAY_MS);
    }

    this.status.running = false;
    this.status.currentUrl = undefined;
  }

  private async crawlOne(url: string, depth: number): Promise<void> {
    try {
      const allowed = await isAllowedByRobots(url);
      if (!allowed) {
        await this.queue.markFailed(url, "disallowed by robots.txt");
        this.status.failed++;
        return;
      }

      const html = await fetchWithTimeout(url);
      const parsed = parseHtml(html, url);
      const domain = new URL(url).hostname;

      const page = await Page.findOneAndUpdate(
        { url },
        {
          url,
          title: parsed.title,
          description: parsed.content.slice(0, 200),
          content: parsed.content,
          headings: parsed.headings,
          links: parsed.links,
          domain,
          crawledAt: new Date(),
        },
        { upsert: true, new: true },
      );

      searchIndex.addDocument({
        id: (page._id as { toString(): string }).toString(),
        title: parsed.title || url,
        url,
        content: parsed.content,
        headings: parsed.headings,
        domain,
      });

      await this.queue.markSuccess(url);
      this.status.crawled++;

      if (depth < MAX_DEPTH) {
        for (const link of parsed.links) {
          await this.queue.add(link, depth + 1);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      await this.queue.markFailed(url, message);
      this.status.failed++;
    }
  }
}

async function fetchWithTimeout(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { normalizeUrl };
export const crawler = new Crawler();
