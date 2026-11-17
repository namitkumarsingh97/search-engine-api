import cors from "cors";
import "dotenv/config";
import express from "express";
import { connectDatabase } from "./database/connection";
import { Page } from "./database/models/Page";
import { driveRouter } from "./routes/drive.routes";
import { loadDriveIntoIndex } from "./drive/indexing";
import { videoRouter } from "./routes/video.routes";
import { loadVideosIntoIndex } from "./video/indexing";
import { calendarRouter } from "./routes/calendar.routes";
import { loadEventsIntoIndex } from "./calendar/indexing";
import { mailRouter } from "./routes/mail.routes";
import { loadMailIntoIndex } from "./mail/indexing";
import { appsRouter } from "./routes/apps.routes";
import { refreshAppCache, seedDefaultApps } from "./apps/registry";
import { authRouter } from "./routes/auth.routes";
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
      type: "web" as const,
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
  console.log(`[server] loaded ${await loadDriveIntoIndex()} drive items into the search index`);
  console.log(`[server] loaded ${await loadVideosIntoIndex()} videos into the search index`);
  console.log(`[server] loaded ${await loadEventsIntoIndex()} calendar events into the search index`);
  console.log(`[server] loaded ${await loadMailIntoIndex()} mail items into the search index`);
  await seedDefaultApps();
  await refreshAppCache();

  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN ?? "http://localhost:3000" }));
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    // Uploaded content is always served as a download or media, never as a page.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json());

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api/drive", driveRouter);
  app.use("/api/videos", videoRouter);
  app.use("/api/calendar", calendarRouter);
  app.use("/api/mail", mailRouter);
  app.use("/api/apps", appsRouter);
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
