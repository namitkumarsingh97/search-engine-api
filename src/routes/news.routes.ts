import { Router } from "express";
import mongoose from "mongoose";
import { listVisibleApps } from "../apps/registry";
import { AppEntry } from "../database/models/AppEntry";
import { NewsItem, NewsItemDocument } from "../database/models/NewsItem";
import { requireAdmin } from "../middleware/admin";
import { asyncHandler } from "../middleware/asyncHandler";
import { ensureFresh, reindexNews, syncNews } from "../news/sync";

export const newsRouter = Router();

const PAGE_SIZE = 20;

function toDto(item: NewsItemDocument, products: Map<string, ReturnType<typeof listVisibleApps>[number]>) {
  const p = products.get(item.appSlug);
  return {
    id: String(item._id),
    product: p ? { slug: p.slug, name: p.name, tone: p.tone, icon: p.icon, url: p.url } : null,
    message: item.message,
    url: item.url,
    repo: item.repo,
    committedAt: item.committedAt,
  };
}

// GET /api/news?product=slug&page=1  — public: recent changes shipped to the products
newsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    await ensureFresh();

    const visible = listVisibleApps();
    const products = new Map(visible.map((p) => [p.slug, p]));
    const slug = typeof req.query.product === "string" ? req.query.product : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || PAGE_SIZE));

    // Only visible products: hiding a product hides its news too.
    const allowed = slug ? visible.filter((p) => p.slug === slug).map((p) => p.slug) : [...products.keys()];
    const filter = { hidden: false, appSlug: { $in: allowed } };

    const [items, total] = await Promise.all([
      NewsItem.find(filter).sort({ committedAt: -1 }).skip((page - 1) * limit).limit(limit),
      NewsItem.countDocuments(filter),
    ]);
    res.json({
      page,
      pageSize: limit,
      total,
      products: visible.map((p) => ({ slug: p.slug, name: p.name })),
      items: items.map((i) => toDto(i, products)),
    });
  }),
);

// ---- Admin -----------------------------------------------------------------------------

// POST /api/news/sync  — read GitHub now
newsRouter.post(
  "/sync",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await syncNews());
  }),
);

// GET /api/news/all  — everything including hidden items, for moderation
newsRouter.get(
  "/all",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const apps = await AppEntry.find();
    const names = new Map(apps.map((a) => [a.slug, a.name]));
    const [items, total] = await Promise.all([
      NewsItem.find().sort({ committedAt: -1 }).skip((page - 1) * 50).limit(50),
      NewsItem.countDocuments(),
    ]);
    res.json({
      page,
      pageSize: 50,
      total,
      items: items.map((i) => ({
        id: String(i._id),
        product: names.get(i.appSlug) ?? i.appSlug,
        message: i.message,
        url: i.url,
        repo: i.repo,
        committedAt: i.committedAt,
        hidden: i.hidden,
      })),
    });
  }),
);

// PATCH /api/news/:id  { hidden }
newsRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const item = mongoose.isValidObjectId(req.params.id) ? await NewsItem.findById(req.params.id) : null;
    if (!item) return res.status(404).json({ error: "News item not found" });
    if (typeof req.body?.hidden !== "boolean") return res.status(400).json({ error: "'hidden' must be true or false" });
    item.hidden = req.body.hidden;
    await item.save();
    await reindexNews();
    res.json({ id: String(item._id), hidden: item.hidden });
  }),
);
