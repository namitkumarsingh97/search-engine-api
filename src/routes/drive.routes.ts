import crypto from "crypto";
import { NextFunction, Response, Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { DriveItem, DriveItemDocument } from "../database/models/DriveItem";
import { extractText } from "../drive/extract";
import { indexDriveItem, unindexDriveItem } from "../drive/indexing";
import { asyncHandler } from "../middleware/asyncHandler";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { fileStorage } from "../storage/localStorage";

export const driveRouter = Router();

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 100);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, fileStorage.uploadDir((req as AuthedRequest).userId!)),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20 },
});

/** Browsers send multipart filenames as latin1-decoded UTF-8; undo that. */
function decodeName(raw: string): string {
  return Buffer.from(raw, "latin1").toString("utf8");
}

function cleanName(raw: unknown): string | null {
  const name = String(raw ?? "").trim();
  if (!name || name.length > 255 || /[\\/]/.test(name) || name === "." || name === "..") return null;
  return name;
}

function toDto(item: DriveItemDocument) {
  return {
    id: String(item._id),
    parentId: item.parentId ? String(item.parentId) : null,
    kind: item.kind,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    trashedAt: item.trashedAt,
    shareToken: item.shareToken ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function findOwned(id: string, ownerId: string): Promise<DriveItemDocument | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  return DriveItem.findOne({ _id: id, ownerId });
}

/** Returns the folder if `id` is null (root) or an owned, non-trashed folder; undefined otherwise. */
async function resolveParent(id: unknown, ownerId: string): Promise<DriveItemDocument | null | undefined> {
  if (id === undefined || id === null || id === "" || id === "root") return null;
  const folder = await findOwned(String(id), ownerId);
  return folder && folder.kind === "folder" && !folder.trashedAt ? folder : undefined;
}

/** All descendants of a folder (breadth-first). */
async function descendantsOf(folderId: unknown, ownerId: string): Promise<DriveItemDocument[]> {
  const out: DriveItemDocument[] = [];
  let frontier = [folderId];
  while (frontier.length) {
    const children = await DriveItem.find({ ownerId, parentId: { $in: frontier } });
    out.push(...children);
    frontier = children.filter((c) => c.kind === "folder").map((c) => c._id);
  }
  return out;
}

// ---- Public: download via share link (no auth) ----------------------------

driveRouter.get(
  "/shared/:token",
  asyncHandler(async (req, res) => {
    const item = await DriveItem.findOne({ shareToken: req.params.token, kind: "file", trashedAt: null });
    if (!item || !item.storageKey || !fileStorage.exists(item.storageKey)) {
      return res.status(404).json({ error: "Link not found" });
    }
    res.type(item.mimeType || "application/octet-stream");
    res.attachment(item.name);
    fileStorage.createReadStream(item.storageKey).pipe(res);
  }),
);

// ---- Everything below needs a signed-in user -------------------------------

driveRouter.use(requireAuth);

// GET /api/drive?parent=<id|root>&trash=1
driveRouter.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const ownerId = req.userId!;

    if (req.query.trash === "1") {
      // Only top-level trashed items: children of a trashed folder come back with it.
      const items = await DriveItem.find({ ownerId, trashedAt: { $ne: null } }).sort({ trashedAt: -1 });
      const trashedFolderIds = new Set(items.filter((i) => i.kind === "folder").map((i) => String(i._id)));
      const top = items.filter((i) => !i.parentId || !trashedFolderIds.has(String(i.parentId)));
      return res.json({ folder: null, breadcrumbs: [], items: top.map(toDto) });
    }

    const parent = await resolveParent(req.query.parent, ownerId);
    if (parent === undefined) return res.status(404).json({ error: "Folder not found" });

    const items = await DriveItem.find({ ownerId, parentId: parent?._id ?? null, trashedAt: null }).sort({ name: 1 });
    // Folders first, then files, each alphabetical.
    items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));

    const breadcrumbs: { id: string; name: string }[] = [];
    let cursor = parent;
    while (cursor) {
      breadcrumbs.unshift({ id: String(cursor._id), name: cursor.name });
      cursor = cursor.parentId ? await DriveItem.findOne({ _id: cursor.parentId, ownerId }) : null;
    }

    res.json({ folder: parent ? toDto(parent) : null, breadcrumbs, items: items.map(toDto) });
  }),
);

// GET /api/drive/:id  — metadata for one item (used to open search hits in their folder)
driveRouter.get(
  "/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const item = await findOwned(req.params.id, req.userId!);
    if (!item || item.trashedAt) return res.status(404).json({ error: "Item not found" });
    res.json(toDto(item));
  }),
);

// POST /api/drive/folders  { name, parentId? }
driveRouter.post(
  "/folders",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: "Invalid folder name" });

    const parent = await resolveParent(req.body?.parentId, req.userId!);
    if (parent === undefined) return res.status(404).json({ error: "Parent folder not found" });

    const folder = await DriveItem.create({
      ownerId: req.userId!,
      parentId: parent?._id ?? null,
      kind: "folder",
      name,
    });
    indexDriveItem(folder);
    res.status(201).json(toDto(folder));
  }),
);

// POST /api/drive/upload  multipart: files[] + parentId
driveRouter.post("/upload", (req: AuthedRequest, res: Response, next: NextFunction) => {
  upload.array("files")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res
        .status(tooBig ? 413 : 400)
        .json({ error: tooBig ? `File exceeds the ${MAX_UPLOAD_MB} MB limit` : err.message });
    }
    if (err) return next(err);

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const ownerId = req.userId!;

    (async () => {
      const discard = () => Promise.all(files.map((f) => fileStorage.remove(fileStorage.keyFor(ownerId, f.filename))));

      if (files.length === 0) return res.status(400).json({ error: "No files uploaded" });

      const parent = await resolveParent(req.body?.parentId, ownerId);
      if (parent === undefined) {
        await discard();
        return res.status(404).json({ error: "Parent folder not found" });
      }

      const created: DriveItemDocument[] = [];
      for (const f of files) {
        const name = cleanName(decodeName(f.originalname)) ?? "Untitled";
        const mimeType = f.mimetype || "application/octet-stream";
        const content = await extractText(f.path, name, mimeType);
        const item = await DriveItem.create({
          ownerId,
          parentId: parent?._id ?? null,
          kind: "file",
          name,
          mimeType,
          size: f.size,
          storageKey: fileStorage.keyFor(ownerId, f.filename),
          content,
        });
        indexDriveItem(item);
        created.push(item);
      }
      res.status(201).json({ items: created.map(toDto) });
    })().catch(next);
  });
});

// GET /api/drive/:id/download
driveRouter.get(
  "/:id/download",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const item = await findOwned(req.params.id, req.userId!);
    if (!item || item.kind !== "file" || !item.storageKey || !fileStorage.exists(item.storageKey)) {
      return res.status(404).json({ error: "File not found" });
    }
    res.type(item.mimeType || "application/octet-stream");
    res.attachment(item.name);
    fileStorage.createReadStream(item.storageKey).pipe(res);
  }),
);

// PATCH /api/drive/:id  { name?, parentId? }  — rename and/or move
driveRouter.patch(
  "/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const ownerId = req.userId!;
    const item = await findOwned(req.params.id, ownerId);
    if (!item || item.trashedAt) return res.status(404).json({ error: "Item not found" });

    if (req.body?.name !== undefined) {
      const name = cleanName(req.body.name);
      if (!name) return res.status(400).json({ error: "Invalid name" });
      item.name = name;
    }

    if (req.body?.parentId !== undefined) {
      const parent = await resolveParent(req.body.parentId, ownerId);
      if (parent === undefined) return res.status(404).json({ error: "Target folder not found" });

      if (parent && item.kind === "folder") {
        const inside = String(parent._id) === String(item._id) ||
          (await descendantsOf(item._id, ownerId)).some((d) => String(d._id) === String(parent._id));
        if (inside) return res.status(400).json({ error: "Can't move a folder into itself" });
      }
      item.parentId = (parent?._id as mongoose.Types.ObjectId | undefined) ?? null;
    }

    await item.save();
    indexDriveItem(item);
    res.json(toDto(item));
  }),
);

// POST /api/drive/:id/share  — toggles the public link (files only)
driveRouter.post(
  "/:id/share",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const item = await findOwned(req.params.id, req.userId!);
    if (!item || item.kind !== "file" || item.trashedAt) return res.status(404).json({ error: "File not found" });

    if (item.shareToken) {
      item.shareToken = undefined;
    } else {
      item.shareToken = crypto.randomBytes(24).toString("base64url");
    }
    await item.save();
    res.json(toDto(item));
  }),
);

// DELETE /api/drive/:id  — move to trash (folders take their contents with them)
driveRouter.delete(
  "/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const ownerId = req.userId!;
    const item = await findOwned(req.params.id, ownerId);
    if (!item || item.trashedAt) return res.status(404).json({ error: "Item not found" });

    const all = [item, ...(item.kind === "folder" ? await descendantsOf(item._id, ownerId) : [])];
    const now = new Date();
    for (const it of all) {
      if (it.trashedAt) continue;
      it.trashedAt = now;
      it.shareToken = undefined; // trashing revokes public links
      await it.save();
      indexDriveItem(it);
    }
    res.json({ trashed: all.length });
  }),
);

// POST /api/drive/:id/restore
driveRouter.post(
  "/:id/restore",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const ownerId = req.userId!;
    const item = await findOwned(req.params.id, ownerId);
    if (!item || !item.trashedAt) return res.status(404).json({ error: "Item not found in trash" });

    // If its folder is still in the trash, bring it back at the top level instead.
    if (item.parentId) {
      const parent = await DriveItem.findOne({ _id: item.parentId, ownerId });
      if (!parent || parent.trashedAt) item.parentId = null;
    }

    const all = [item, ...(item.kind === "folder" ? await descendantsOf(item._id, ownerId) : [])];
    for (const it of all) {
      it.trashedAt = null;
      await it.save();
      indexDriveItem(it);
    }
    res.json(toDto(item));
  }),
);

async function purge(items: DriveItemDocument[]): Promise<void> {
  for (const it of items) {
    if (it.storageKey) await fileStorage.remove(it.storageKey);
    unindexDriveItem(String(it._id));
    await it.deleteOne();
  }
}

// DELETE /api/drive/:id/permanent  — only for items already in the trash
driveRouter.delete(
  "/:id/permanent",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const ownerId = req.userId!;
    const item = await findOwned(req.params.id, ownerId);
    if (!item || !item.trashedAt) return res.status(404).json({ error: "Item not found in trash" });

    const all = [item, ...(item.kind === "folder" ? await descendantsOf(item._id, ownerId) : [])];
    await purge(all);
    res.json({ deleted: all.length });
  }),
);

// DELETE /api/drive/trash/all  — empty the trash
driveRouter.delete(
  "/trash/all",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const items = await DriveItem.find({ ownerId: req.userId!, trashedAt: { $ne: null } });
    await purge(items);
    res.json({ deleted: items.length });
  }),
);
