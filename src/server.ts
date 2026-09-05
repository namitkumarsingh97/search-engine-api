import cors from "cors";
import "dotenv/config";
import express from "express";
import { connectDatabase } from "./database/connection";
import { Page } from "./database/models/Page";
import { adminRouter } from "./routes/admin.routes";
import { crawlerRouter } from "./routes/crawler.routes";
import { searchRouter } from "./routes/search.routes";
import { searchIndex } from "./search/indexer";

const PORT = Number(process.env.PORT ?? 4000);

/** Rebuilds the in-memory search index from whatever is already in Mongo —
 * runs once on boot, so pages from the crawler or a seed script are
 * searchable immediately without waiting for a fresh crawl. */
async function loadIndexFromDatabase(): Promise<void> {
  const pages = await Page.find().lean();

  searchIndex.addDocuments(
    pages.map((page) => ({
      id: page._id.toString(),
      title: page.title || page.url,
      url: page.url,
      content: page.content,
      headings: page.headings,
      domain: page.domain,
    })),
  );

  console.log(
    `[server] loaded ${pages.length} pages from MongoDB into the search index`,
  );
}

async function main() {
  await connectDatabase();
  await loadIndexFromDatabase();

  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN ?? "http://localhost:3000" }));
  app.use(express.json());

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/search", searchRouter);
  app.use("/api/crawler", crawlerRouter);
  app.use("/api", adminRouter);

  // Catches errors thrown or rejected inside any route handler above and
  // returns a normal 500 instead of letting them crash the process.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("[server] unhandled route error:", err);
      res.status(500).json({ error: "Internal server error" });
    },
  );

  app.listen(PORT, () => {
    console.log(`[server] Nexa API listening on http://localhost:${PORT}`);
  });
}

// Last-resort safety net: log and keep running instead of crashing on a
// stray unhandled rejection anywhere in the process (e.g. inside the
// crawler's background loop, which isn't part of any request).
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection:", reason);
});

main().catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});
