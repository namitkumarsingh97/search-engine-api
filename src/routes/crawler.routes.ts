import { Router } from "express";
import { crawler } from "../crawler/crawler";
import { CrawlQueue } from "../database/models/CrawlQueue";

export const crawlerRouter = Router();

// POST /api/crawler/start  { seedUrls: string[] }
crawlerRouter.post("/start", async (req, res) => {
  const seedUrls = req.body?.seedUrls;

  if (!Array.isArray(seedUrls) || seedUrls.length === 0) {
    return res.status(400).json({ error: "seedUrls must be a non-empty array" });
  }

  const invalidUrls = seedUrls.filter((url) => !isValidHttpUrl(url));
  if (invalidUrls.length > 0) {
    return res.status(400).json({
      error: "Every seed URL must be a full http(s) URL, e.g. https://example.com",
      invalidUrls,
    });
  }

  await crawler.start(seedUrls);
  res.json({ started: true });
});

function isValidHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// POST /api/crawler/stop
crawlerRouter.post("/stop", (_req, res) => {
  crawler.requestStop();
  res.json({ stopped: true });
});

// GET /api/crawler/status
crawlerRouter.get("/status", (_req, res) => {
  res.json(crawler.getStatus());
});

// GET /api/crawler/recent
crawlerRouter.get("/recent", async (_req, res) => {
  const recent = await CrawlQueue.find({ status: { $ne: "queued" } })
    .sort({ crawledAt: -1 })
    .limit(20)
    .lean();

  res.json(
    recent.map((r) => ({
      url: r.url,
      status: r.status,
      crawledAt: r.crawledAt,
    }))
  );
});
