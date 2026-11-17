import { Router } from "express";
import { SearchHistory } from "../database/models/SearchHistory";
import { asyncHandler } from "../middleware/asyncHandler";
import { AuthedRequest, optionalAuth, requireAuth } from "../middleware/auth";
import { matchApps } from "../apps/registry";
import { refreshNewsIndexIfChanged } from "../news/sync";
import { parseQuery } from "../search/query";
import { searchIndex } from "../search/indexer";
import { autocomplete, runSearch } from "../search/search";
import { DOC_TYPES, DocType, ScoredResult } from "../types";

export const searchRouter = Router();

const MAX_QUERY_LENGTH = 200;

/**
 * Mail lives in its own service (search-engine-mail). Searching it means asking that service,
 * passing along the user's own login token, so it can only ever return that user's mail.
 * Any problem (not configured, slow, down) just means no mail results: it never breaks search.
 */
async function searchMail(authorization: string | undefined, words: string, page: number, pageSize: number) {
  const base = process.env.MAIL_SERVICE_URL?.replace(/\/$/, "");
  if (!base || !authorization || !words.trim()) return null;
  try {
    const params = new URLSearchParams({ q: words, page: String(page), pageSize: String(pageSize) });
    const res = await fetch(`${base}/search?${params.toString()}`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return (await res.json()) as { total: number; page: number; pageSize: number; items: ScoredResult[] };
  } catch {
    return null;
  }
}

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

    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 10;
    const parsed = parseQuery(q);
    const effectiveType = rawType === "all" ? parsed.type : (rawType as DocType);

    const response = runSearch(searchIndex, q, {
      type: rawType === "all" ? undefined : (rawType as DocType),
      viewerId: req.userId,
      page,
      pageSize,
      sort,
    });

    // The signed-in person's own mail. On the Mail tab it IS the result list; elsewhere only the
    // top few (shown as a shelf on All) and the count (for the tab badge) are needed.
    const wantsMailList = effectiveType === "mail";
    const mailHits = await searchMail(req.headers.authorization, parsed.terms.join(" "), wantsMailList ? page : 1, wantsMailList ? pageSize : 3);
    let mail: ScoredResult[] = [];
    if (mailHits) {
      response.facets.mail = mailHits.total;
      if (wantsMailList) {
        response.results = mailHits.items;
        response.total = mailHits.total;
        response.page = mailHits.page;
        response.pageSize = mailHits.pageSize;
      } else if (!effectiveType && page === 1) {
        mail = mailHits.items;
      }
    }

    // Log the main search only (not tab switches or page turns), for history and analytics.
    if (rawType === "all" && response.page === 1) {
      SearchHistory.create({ query: q, resultCount: response.total, userId: req.userId }).catch((err) =>
        console.error("[search] failed to log query:", err),
      );
    }

    // Nexa apps (the owner's own projects) that match the words typed, shown as a shelf above results.
    const apps = response.page === 1 && rawType === "all" ? matchApps(parseQuery(q).terms) : [];

    res.json({ ...response, apps, mail });
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
