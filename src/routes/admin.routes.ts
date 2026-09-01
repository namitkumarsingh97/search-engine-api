import { Router } from "express";
import { CrawlQueue } from "../database/models/CrawlQueue";
import { SearchHistory } from "../database/models/SearchHistory";
import { searchIndex } from "../search/indexer";

export const adminRouter = Router();

// GET /api/stats
adminRouter.get("/stats", async (_req, res) => {
  const domains = new Set(searchIndex.getAllDocuments().map((d) => d.domain).filter(Boolean));
  const crawlQueue = await CrawlQueue.countDocuments({ status: "queued" });

  res.json({
    indexedPages: searchIndex.size,
    domains: domains.size,
    searchTerms: searchIndex.termCount,
    crawlQueue,
  });
});

// GET /api/stats/top-queries — used by the analytics page later
adminRouter.get("/stats/top-queries", async (_req, res) => {
  const topQueries = await SearchHistory.aggregate([
    { $group: { _id: "$query", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);

  res.json(topQueries.map((q) => ({ query: q._id, count: q.count })));
});
