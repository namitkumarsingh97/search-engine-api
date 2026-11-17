import { Router } from "express";
import { SearchHistory } from "../database/models/SearchHistory";
import { asyncHandler } from "../middleware/asyncHandler";
import { AuthedRequest, optionalAuth, requireAuth } from "../middleware/auth";
import { matchApps } from "../apps/registry";
import { refreshNewsIndexIfChanged } from "../news/sync";
import { parseQuery } from "../search/query";
import { searchIndex } from "../search/indexer";
import { autocomplete, runSearch } from "../search/search";
import { DOC_TYPES, DocType } from "../types";

export const searchRouter = Router();

const MAX_QUERY_LENGTH = 200;

/** A signed-in user's most recent distinct queries, newest first. */
async function recentQueries(userId: string, limit: number): Promise<string[]> {
  const rows = await SearchHistory.aggregate<{ _id: string }>([
    { $match: { userId } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$query", last: { $first: "$createdAt" } } },
    { $sort: { last: -1 } },
    { $limit: limit },
  ]);
  return rows.map((r) => r._id);
}

// ---- Personal search history (signed-in only) ----------------------------------

// GET /api/search/history
searchRouter.get(
  "/history",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    res.json(await recentQueries(req.userId!, 15));
  }),
);

// DELETE /api/search/history           — clear everything
// DELETE /api/search/history?q=python  — forget one query
searchRouter.delete(
  "/history",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const filter: Record<string, unknown> = { userId: req.userId! };
    if (typeof req.query.q === "string") filter.query = req.query.q;
    const result = await SearchHistory.deleteMany(filter);
    res.json({ deleted: result.deletedCount });
  }),
);

// ---- Search ---------------------------------------------------------------------

// Token is optional below: anonymous users still get public web results.
searchRouter.use(optionalAuth);

/**
 * GET /api/search?q=...&type=all|web|file|mail|event|video&page=1&pageSize=10&sort=relevance|date
 * Query syntax: "exact phrase"  -exclude  site:example.com  type:video
 */
searchRouter.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.status(400).json({ error: "Query param 'q' is required" });
    if (q.length > MAX_QUERY_LENGTH) return res.status(400).json({ error: `Query is limited to ${MAX_QUERY_LENGTH} characters` });

    const rawType = String(req.query.type ?? "all");
    if (rawType !== "all" && !DOC_TYPES.includes(rawType as DocType)) {
      return res.status(400).json({ error: `Unknown type '${rawType}'` });
    }
    const sort = req.query.sort === "date" ? "date" : "relevance";

    // Pick up news the processor stored since we last looked (throttled; a hiccup here must not break search).
    await refreshNewsIndexIfChanged().catch(() => undefined);

    const response = runSearch(searchIndex, q, {
      type: rawType === "all" ? undefined : (rawType as DocType),
      viewerId: req.userId,
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 10,
      sort,
    });

    // Log the main search only (not tab switches or page turns), for history and analytics.
    if (rawType === "all" && response.page === 1) {
      SearchHistory.create({ query: q, resultCount: response.total, userId: req.userId }).catch((err) =>
        console.error("[search] failed to log query:", err),
      );
    }

    // Nexa apps (the owner's own projects) that match the words typed, shown as a shelf above results.
    const apps = response.page === 1 && rawType === "all" ? matchApps(parseQuery(q).terms) : [];

    res.json({ ...response, apps });
  }),
);

// GET /api/search/autocomplete?q=pyth  — recent searches first (signed in), then common words
searchRouter.get(
  "/autocomplete",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, MAX_QUERY_LENGTH);
    const recent = req.userId && q ? await recentQueries(req.userId, 30) : [];
    res.json(autocomplete(searchIndex, q, req.userId, 8, recent));
  }),
);
