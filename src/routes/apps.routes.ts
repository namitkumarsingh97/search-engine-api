import { Router } from "express";
import mongoose from "mongoose";
import { isSafeUrl, listVisibleApps, refreshAppCache, toPublicApp } from "../apps/registry";
import { reindexNews } from "../news/sync";
import { AppEntry, AppEntryDocument } from "../database/models/AppEntry";
import { requireAdmin } from "../middleware/admin";
import { asyncHandler } from "../middleware/asyncHandler";

export const appsRouter = Router();

const TONES = ["mustard", "orange", "charcoal", "paper"];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Full record for the admin editor, including hidden apps. */
const adminDto = (a: AppEntryDocument) => ({
  ...toPublicApp(a),
  keywords: a.keywords,
  repos: a.repos,
  visible: a.visible,
  order: a.order,
});

function readFields(body: Record<string, unknown>, partial: boolean): { error: string } | { fields: Partial<AppEntryDocument> } {
  const f: Partial<AppEntryDocument> = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 40) return { error: "Name is required (max 40 characters)" };
    f.name = name;
  }
  if (!partial || body.url !== undefined) {
    if (!isSafeUrl(body.url)) return { error: "URL must start with http:// or https://" };
    f.url = String(body.url).trim();
  }
  if (body.tagline !== undefined) f.tagline = String(body.tagline).trim().slice(0, 90);
  if (body.description !== undefined) f.description = String(body.description).trim().slice(0, 400);
  if (body.icon !== undefined) f.icon = String(body.icon).slice(0, 30);
  if (body.tone !== undefined) {
    if (!TONES.includes(String(body.tone))) return { error: `Tone must be one of: ${TONES.join(", ")}` };
    f.tone = String(body.tone);
  }
  if (body.keywords !== undefined) {
    const list = Array.isArray(body.keywords) ? body.keywords : String(body.keywords).split(",");
    f.keywords = [...new Set(list.map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  }
  if (body.repos !== undefined) {
    const list = Array.isArray(body.repos) ? body.repos : String(body.repos).split(/[,\s]+/);
    const repos = [...new Set(list.map((r) => String(r).trim()).filter(Boolean))];
    if (repos.length > 5) return { error: "At most 5 repos per product" };
    if (repos.some((r) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r))) {
      return { error: 'Repos must look like "owner/name"' };
    }
    f.repos = repos;
  }
  if (body.openInNewTab !== undefined) f.openInNewTab = Boolean(body.openInNewTab);
  if (body.visible !== undefined) f.visible = Boolean(body.visible);
  if (body.order !== undefined) {
    const n = Number(body.order);
    if (!Number.isFinite(n)) return { error: "Order must be a number" };
    f.order = Math.round(n);
  }
  return { fields: f };
}

// GET /api/apps  — public: what shows in the Apps menu and on the home page
appsRouter.get("/", (_req, res) => {
  res.json(listVisibleApps());
});

// GET /api/apps/all  — admin: everything, including hidden apps
appsRouter.get(
  "/all",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const apps = await AppEntry.find().sort({ order: 1, name: 1 });
    res.json(apps.map(adminDto));
  }),
);

// POST /api/apps  — admin
appsRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = readFields(req.body ?? {}, false);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });

    const slug = slugify(String(req.body?.slug ?? parsed.fields.name));
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Couldn't make a valid slug from that name" });
    if (await AppEntry.exists({ slug })) return res.status(409).json({ error: `An app called "${slug}" already exists` });

    const app = await AppEntry.create({ ...parsed.fields, slug });
    await refreshAppCache();
    await reindexNews();
    res.status(201).json(adminDto(app));
  }),
);

// PATCH /api/apps/:id  — admin
appsRouter.patch(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const app = mongoose.isValidObjectId(req.params.id) ? await AppEntry.findById(req.params.id) : null;
    if (!app) return res.status(404).json({ error: "App not found" });

    const parsed = readFields(req.body ?? {}, true);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });

    app.set(parsed.fields);
    await app.save();
    await refreshAppCache();
    await reindexNews();
    res.json(adminDto(app));
  }),
);

// DELETE /api/apps/:id  — admin
appsRouter.delete(
  "/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const app = mongoose.isValidObjectId(req.params.id) ? await AppEntry.findById(req.params.id) : null;
    if (!app) return res.status(404).json({ error: "App not found" });
    await app.deleteOne();
    await refreshAppCache();
    await reindexNews();
    res.json({ deleted: true });
  }),
);
