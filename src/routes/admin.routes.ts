import { Router } from "express";
import { CrawlQueue } from "../database/models/CrawlQueue";
import { SearchHistory } from "../database/models/SearchHistory";
import { requireAdmin } from "../middleware/admin";
import { asyncHandler } from "../middleware/asyncHandler";
import { searchIndex } from "../search/indexer";

export const adminRouter = Router();

// GET /api/stats
// Admin only. Counts only: never document contents, and private documents are
// only counted by type, never listed.
adminRouter.get(
  "/stats",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const docs = searchIndex.getAllDocuments();
    const documentsByType: Record<string, number> = { web: 0, file: 0, mail: 0, event: 0, video: 0 };
    const domains = new Set<string>();
    for (const d of docs) {
      const type = d.type ?? "web";
      documentsByType[type] = (documentsByType[type] ?? 0) + 1;
      if (type === "web" && d.domain) domains.add(d.domain);
    }
    const crawlQueue = await CrawlQueue.countDocuments({ status: "queued" });

    res.json({
      indexedPages: documentsByType.web,
      documentsByType,
      domains: domains.size,
      searchTerms: searchIndex.termCount,
      crawlQueue,
    });
  }),
);

// GET /api/stats/top-queries — used by the analytics page later
adminRouter.get(
  "/stats/top-queries",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const topQueries = await SearchHistory.aggregate([
      // Anonymous searches only: what signed-in users search for stays private to them.
      { $match: { userId: null } },
      { $group: { _id: "$query", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    res.json(topQueries.map((q) => ({ query: q._id, count: q.count })));
  }),
);

// GET /api/analytics  — search behaviour. Query text is only shown for anonymous
// searches; signed-in users' searches are counted but their text is never exposed.
adminRouter.get(
  "/analytics",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const DAY = 86_400_000;
    const since = new Date(Date.now() - 14 * DAY);

    const [total, signedIn, zeroResultSearches, perDayRaw, topQueries, zeroResultQueries, avgRow] = await Promise.all([
      SearchHistory.countDocuments(),
      SearchHistory.countDocuments({ userId: { $ne: null } }),
      SearchHistory.countDocuments({ resultCount: 0 }),
      SearchHistory.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
      ]),
      SearchHistory.aggregate([
        { $match: { userId: null } },
        { $group: { _id: "$query", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      SearchHistory.aggregate([
        { $match: { userId: null, resultCount: 0 } },
        { $group: { _id: "$query", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      SearchHistory.aggregate<{ avg: number }>([{ $group: { _id: null, avg: { $avg: "$resultCount" } } }]),
    ]);

    // Fill in days with no searches so the chart has no gaps.
    const counts = new Map(perDayRaw.map((d) => [d._id, d.count]));
    const perDay = Array.from({ length: 14 }, (_, i) => {
      const date = new Date(Date.now() - (13 - i) * DAY).toISOString().slice(0, 10);
      return { date, count: counts.get(date) ?? 0 };
    });

    res.json({
      totalSearches: total,
      signedInSearches: signedIn,
      zeroResultSearches,
      averageResults: Math.round((avgRow[0]?.avg ?? 0) * 10) / 10,
      perDay,
      topQueries: topQueries.map((q) => ({ query: q._id, count: q.count })),
      zeroResultQueries: zeroResultQueries.map((q) => ({ query: q._id, count: q.count })),
    });
  }),
);
