import { Router } from "express";
import { SearchHistory } from "../database/models/SearchHistory";
import { searchIndex } from "../search/indexer";
import { autocomplete, runSearch } from "../search/search";

export const searchRouter = Router();

// GET /api/search?q=python+programming
searchRouter.get("/", async (req, res) => {
  const q = String(req.query.q ?? "").trim();

  if (!q) {
    return res.status(400).json({ error: "Query param 'q' is required" });
  }

  const response = runSearch(searchIndex, q);

  // Fire-and-forget logging for the analytics page — don't block the response on it.
  SearchHistory.create({ query: q, resultCount: response.total }).catch((err) =>
    console.error("[search] failed to log query:", err)
  );

  res.json(response);
});

// GET /api/search/autocomplete?q=pyth
searchRouter.get("/autocomplete", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  res.json(autocomplete(searchIndex, q));
});
