import { CrawlQueue } from "../database/models/CrawlQueue";

/**
 * Wraps the CrawlQueue collection so the crawler doesn't recrawl the same
 * URL twice, even across restarts. Visited state lives in Mongo; only the
 * "what's next" ordering is kept in memory for this simple version.
 */
export class UrlQueue {
  private pending: { url: string; depth: number }[] = [];
  private seen = new Set<string>();

  async seed(urls: string[]): Promise<void> {
    for (const url of urls) {
      try {
        await this.add(url, 0);
      } catch (err) {
        console.error(`[crawler] skipping invalid seed URL "${url}":`, err);
      }
    }
  }

  async add(url: string, depth: number): Promise<void> {
    let normalized: string;
    try {
      normalized = normalizeUrl(url);
    } catch (err) {
      console.error(`[crawler] skipping invalid URL "${url}":`, err);
      return;
    }

    if (this.seen.has(normalized)) return;

    this.seen.add(normalized);
    this.pending.push({ url: normalized, depth });

    // Upsert so a restart can resume from what's already queued.
    await CrawlQueue.updateOne(
      { url: normalized },
      { $setOnInsert: { url: normalized, depth, status: "queued" } },
      { upsert: true }
    );
  }

  next(): { url: string; depth: number } | undefined {
    return this.pending.shift();
  }

  get length(): number {
    return this.pending.length;
  }

  async markSuccess(url: string): Promise<void> {
    await CrawlQueue.updateOne(
      { url: normalizeUrl(url) },
      { status: "success", crawledAt: new Date() }
    );
  }

  async markFailed(url: string, error: string): Promise<void> {
    await CrawlQueue.updateOne(
      { url: normalizeUrl(url) },
      { status: "failed", crawledAt: new Date(), error }
    );
  }
}

/** Basic URL normalization so http/https + trailing-slash variants of the
 * same page don't get crawled as if they were different pages. */
export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}
