import crypto from "crypto";
import { NextFunction, Response, Router } from "express";
import fs from "fs";
import mongoose from "mongoose";
import multer from "multer";
import { DriveItem } from "../database/models/DriveItem";
import { MailFolder, MailItem, MailItemDocument } from "../database/models/MailItem";
import { Address, Attachment, Message, MessageDocument } from "../database/models/Message";
import { User } from "../database/models/User";
import { extractText } from "../drive/extract";
import { indexDriveItem } from "../drive/indexing";
import { indexMailItem, unindexMailItem } from "../mail/indexing";
import { asyncHandler } from "../middleware/asyncHandler";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { fileStorage } from "../storage/localStorage";

export const mailRouter = Router();
mailRouter.use(requireAuth);

const PAGE_SIZE = 30;
const MAX_ATTACHMENT_MB = Number(process.env.MAX_ATTACHMENT_MB ?? 25);
const MAX_RECIPIENTS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, fileStorage.uploadDir((req as AuthedRequest).userId!)),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_ATTACHMENT_MB * 1024 * 1024, files: 5 },
});

// ---- helpers ----------------------------------------------------------------

const isFolder = (v: unknown): v is MailFolder => ["inbox", "sent", "draft", "trash"].includes(String(v));

function parseEmails(raw: unknown): string[] {
  const list = String(raw ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(list)];
}

const addrDto = (a: Address) => ({ name: a.name, email: a.email });

function summarize(item: MailItemDocument, m: MessageDocument) {
  return {
    id: String(item._id),
    folder: item.folder,
    read: item.read,
    starred: item.starred,
    date: item.date,
    threadId: item.threadId,
    from: addrDto(m.from),
    to: m.to.map(addrDto),
    subject: m.subject,
    snippet: m.body.replace(/\s+/g, " ").trim().slice(0, 140),
    hasAttachments: m.attachments.length > 0,
  };
}

function detail(item: MailItemDocument, m: MessageDocument) {
  return {
    ...summarize(item, m),
    messageId: String(m._id),
    cc: m.cc.map(addrDto),
    body: m.body,
    sentAt: m.sentAt,
    attachments: m.attachments.map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size })),
  };
}

async function findOwnedItem(id: string, userId: string) {
  if (!mongoose.isValidObjectId(id)) return null;
  const item = await MailItem.findOne({ _id: id, userId });
  if (!item) return null;
  const message = await Message.findById(item.messageId);
  return message ? { item, message } : null;
}

/** Removes a Message and its files once no user's MailItem points at it any more. */
async function deleteMessageIfOrphaned(messageId: unknown): Promise<void> {
  if (await MailItem.exists({ messageId })) return;
  const message = await Message.findById(messageId);
  if (!message) return;
  for (const a of message.attachments) await fileStorage.remove(a.storageKey);
  await message.deleteOne();
}

function decodeName(raw: string): string {
  return Buffer.from(raw, "latin1").toString("utf8").replace(/[\\/]/g, "_").slice(0, 255) || "attachment";
}

// ---- reading ----------------------------------------------------------------

// GET /api/mail/folders  — counts for the sidebar
mailRouter.get(
  "/folders",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const userId = req.userId!;
    const rows = await MailItem.aggregate<{ _id: MailFolder; total: number; unread: number }>([
      { $match: { userId } },
      { $group: { _id: "$folder", total: { $sum: 1 }, unread: { $sum: { $cond: ["$read", 0, 1] } } } },
    ]);
    const out: Record<string, { total: number; unread: number }> = {
      inbox: { total: 0, unread: 0 },
      sent: { total: 0, unread: 0 },
      draft: { total: 0, unread: 0 },
      trash: { total: 0, unread: 0 },
    };
    for (const r of rows) out[r._id] = { total: r.total, unread: r.unread };
    out.starred = { total: await MailItem.countDocuments({ userId, starred: true, folder: { $ne: "trash" } }), unread: 0 };
    res.json(out);
  }),
);

// GET /api/mail?folder=inbox|sent|draft|trash|starred&page=1
mailRouter.get(
  "/",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const userId = req.userId!;
    const folder = String(req.query.folder ?? "inbox");
    const page = Math.max(1, Number(req.query.page) || 1);

    let filter: Record<string, unknown>;
    if (folder === "starred") filter = { userId, starred: true, folder: { $ne: "trash" } };
    else if (isFolder(folder)) filter = { userId, folder };
    else return res.status(400).json({ error: "Unknown folder" });

    const [items, total] = await Promise.all([
      MailItem.find(filter).sort({ date: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE),
      MailItem.countDocuments(filter),
    ]);
    const messages = await Message.find({ _id: { $in: items.map((i) => i.messageId) } });
    const byId = new Map(messages.map((m) => [String(m._id), m]));

    res.json({
      page,
      total,
      pageSize: PAGE_SIZE,
      items: items.flatMap((i) => {
        const m = byId.get(String(i.messageId));
        return m ? [summarize(i, m)] : [];
      }),
    });
  }),
);

// GET /api/mail/contacts?q=  — registered users to autocomplete recipients (min 2 chars)
mailRouter.get(
  "/contacts",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const q = String(req.query.q ?? "").trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const users = await User.find({ $or: [{ email: new RegExp(`^${escaped}`) }, { name: new RegExp(`^${escaped}`, "i") }] }).limit(8);
    res.json(users.map((u) => ({ name: u.name, email: u.email })));
  }),
);

// GET /api/mail/items/:id  — full message; opening it marks it read
mailRouter.get(
  "/items/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const found = await findOwnedItem(req.params.id, req.userId!);
    if (!found) return res.status(404).json({ error: "Message not found" });
    if (!found.item.read) {
      found.item.read = true;
      await found.item.save();
    }
    res.json(detail(found.item, found.message));
  }),
);

// GET /api/mail/threads/:threadId  — this user's messages in a conversation, oldest first
mailRouter.get(
  "/threads/:threadId",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const items = await MailItem.find({ userId: req.userId!, threadId: req.params.threadId, folder: { $ne: "trash" } });
    const messages = await Message.find({ _id: { $in: items.map((i) => i.messageId) } });
    const byId = new Map(messages.map((m) => [String(m._id), m]));
    const rows = items
      .flatMap((i) => {
        const m = byId.get(String(i.messageId));
        return m ? [{ item: i, message: m }] : [];
      })
      .sort((a, b) => a.item.date.getTime() - b.item.date.getTime());
    res.json(rows.map((r) => detail(r.item, r.message)));
  }),
);

// ---- changing state ---------------------------------------------------------

// PATCH /api/mail/items/:id  { read?, starred? }
mailRouter.patch(
  "/items/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const found = await findOwnedItem(req.params.id, req.userId!);
    if (!found) return res.status(404).json({ error: "Message not found" });
    if (typeof req.body?.read === "boolean") found.item.read = req.body.read;
    if (typeof req.body?.starred === "boolean") found.item.starred = req.body.starred;
    await found.item.save();
    res.json(summarize(found.item, found.message));
  }),
);

// POST /api/mail/items/:id/trash
mailRouter.post(
  "/items/:id/trash",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const found = await findOwnedItem(req.params.id, req.userId!);
    if (!found || found.item.folder === "trash") return res.status(404).json({ error: "Message not found" });
    found.item.prevFolder = found.item.folder as "inbox" | "sent" | "draft";
    found.item.folder = "trash";
    await found.item.save();
    indexMailItem(found.item, found.message);
    res.json({ trashed: true });
  }),
);

// POST /api/mail/items/:id/restore
mailRouter.post(
  "/items/:id/restore",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const found = await findOwnedItem(req.params.id, req.userId!);
    if (!found || found.item.folder !== "trash") return res.status(404).json({ error: "Message not found in trash" });
    found.item.folder = found.item.prevFolder ?? "inbox";
    found.item.prevFolder = undefined;
    await found.item.save();
    indexMailItem(found.item, found.message);
    res.json({ restored: true, folder: found.item.folder });
  }),
);

// DELETE /api/mail/items/:id  — permanent; only from the trash (or a discarded draft)
mailRouter.delete(
  "/items/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const found = await findOwnedItem(req.params.id, req.userId!);
    if (!found || (found.item.folder !== "trash" && found.item.folder !== "draft")) {
      return res.status(404).json({ error: "Message not found in trash or drafts" });
    }
    unindexMailItem(String(found.item._id));
    await found.item.deleteOne();
    await deleteMessageIfOrphaned(found.message._id);
    res.json({ deleted: true });
  }),
);

// DELETE /api/mail/trash/all  — empty the trash
mailRouter.delete(
  "/trash/all",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const items = await MailItem.find({ userId: req.userId!, folder: "trash" });
    for (const item of items) {
      await item.deleteOne();
      await deleteMessageIfOrphaned(item.messageId);
    }
    res.json({ deleted: items.length });
  }),
);

// ---- attachments ------------------------------------------------------------

function findAttachment(message: MessageDocument, attId: string): Attachment | undefined {
  return message.attachments.find((a) => a.id === attId);
}

// GET /api/mail/items/:id/attachments/:attId
mailRouter.get(
  "/items/:id/attachments/:attId",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const found = await findOwnedItem(req.params.id, req.userId!);
    const att = found && findAttachment(found.message, req.params.attId);
    if (!att || !fileStorage.exists(att.storageKey)) return res.status(404).json({ error: "Attachment not found" });
    res.type(att.mimeType);
    res.attachment(att.name);
    fileStorage.createReadStream(att.storageKey).pipe(res);
  }),
);

// POST /api/mail/items/:id/attachments/:attId/save-to-drive
mailRouter.post(
  "/items/:id/attachments/:attId/save-to-drive",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const userId = req.userId!;
    const found = await findOwnedItem(req.params.id, userId);
    const att = found && findAttachment(found.message, req.params.attId);
    if (!att || !fileStorage.exists(att.storageKey)) return res.status(404).json({ error: "Attachment not found" });

    // Copy the bytes so the Drive file lives on even if the email is deleted.
    const fileName = crypto.randomUUID();
    const key = fileStorage.keyFor(userId, fileName);
    fileStorage.uploadDir(userId);
    await fs.promises.copyFile(fileStorage.absolutePath(att.storageKey), fileStorage.absolutePath(key));

    const content = await extractText(fileStorage.absolutePath(key), att.name, att.mimeType);
    const driveItem = await DriveItem.create({
      ownerId: userId,
      parentId: null,
      kind: "file",
      name: att.name,
      mimeType: att.mimeType,
      size: att.size,
      storageKey: key,
      content,
    });
    indexDriveItem(driveItem);
    res.status(201).json({ driveItemId: String(driveItem._id) });
  }),
);

// ---- composing --------------------------------------------------------------

/**
 * POST /api/mail/messages  (multipart)
 * Fields: draftId?, to, cc, subject, body, send ("1" sends, otherwise saves a draft),
 *         replyTo? (item id, for threading), keep? (JSON array of draft attachment ids to keep)
 * Files:  files[] (up to 5)
 */
// Per-user cap on sends and draft saves, so one account can't flood others.
const composeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  key: (req) => (req as AuthedRequest).userId,
  message: "You've reached the hourly sending limit. Try again later.",
});

mailRouter.post("/messages", composeLimiter, (req: AuthedRequest, res: Response, next: NextFunction) => {
  upload.array("files", 5)(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res
        .status(tooBig ? 413 : 400)
        .json({ error: tooBig ? `Attachments are limited to ${MAX_ATTACHMENT_MB} MB each` : err.message });
    }
    if (err) return next(err);
    compose(req, res).catch(next);
  });
});

async function compose(req: AuthedRequest, res: Response): Promise<unknown> {
  const userId = req.userId!;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const discardUploads = () => Promise.all(files.map((f) => fileStorage.remove(fileStorage.keyFor(userId, f.filename))));
  const fail = async (status: number, error: string) => {
    await discardUploads();
    return res.status(status).json({ error });
  };

  const sender = await User.findById(userId);
  if (!sender) return fail(401, "Account no longer exists");

  const sending = String(req.body?.send ?? "") === "1";
  const subject = String(req.body?.subject ?? "").slice(0, 200);
  const body = String(req.body?.body ?? "");
  if (body.length > 100_000) return fail(400, "Message is too long");

  const toEmails = parseEmails(req.body?.to);
  const ccEmails = parseEmails(req.body?.cc);
  if (toEmails.length + ccEmails.length > MAX_RECIPIENTS) return fail(400, `At most ${MAX_RECIPIENTS} recipients`);
  const bad = [...toEmails, ...ccEmails].filter((e) => !EMAIL_RE.test(e));
  if (bad.length) return fail(400, `Invalid address: ${bad.join(", ")}`);

  const known = await User.find({ email: { $in: [...toEmails, ...ccEmails] } });
  const byEmail = new Map(known.map((u) => [u.email, u]));
  const toAddress = (email: string): Address => {
    const u = byEmail.get(email);
    return u ? { userId: String(u._id), name: u.name, email } : { name: "", email };
  };

  if (sending) {
    if (toEmails.length === 0) return fail(400, "Add at least one recipient");
    const unknown = [...toEmails, ...ccEmails].filter((e) => !byEmail.has(e));
    if (unknown.length) return fail(400, `No Nexa account for: ${unknown.join(", ")}`);
    if (!subject.trim() && !body.trim() && files.length === 0) return fail(400, "Write a subject or a message first");
  }

  // Existing draft being edited?
  let draftItem: MailItemDocument | null = null;
  let message: MessageDocument | null = null;
  if (req.body?.draftId) {
    const found = await findOwnedItem(String(req.body.draftId), userId);
    if (!found || found.item.folder !== "draft") return fail(404, "Draft not found");
    draftItem = found.item;
    message = found.message;
  }

  // Threading: replying joins the parent's thread.
  let threadId = message?.threadId ?? crypto.randomUUID();
  if (!message && req.body?.replyTo) {
    const parent = await findOwnedItem(String(req.body.replyTo), userId);
    if (parent) threadId = parent.item.threadId;
  }

  // Attachments: keep the chosen existing ones, add the new uploads.
  let keepIds: string[] = [];
  try {
    keepIds = req.body?.keep ? JSON.parse(String(req.body.keep)) : [];
  } catch {
    return fail(400, "Invalid 'keep' list");
  }
  const kept = (message?.attachments ?? []).filter((a) => keepIds.includes(a.id));
  const dropped = (message?.attachments ?? []).filter((a) => !keepIds.includes(a.id));
  const added: Attachment[] = files.map((f) => ({
    id: crypto.randomUUID(),
    name: decodeName(f.originalname),
    mimeType: f.mimetype || "application/octet-stream",
    size: f.size,
    storageKey: fileStorage.keyFor(userId, f.filename),
  }));
  for (const a of dropped) await fileStorage.remove(a.storageKey);

  const fields = {
    threadId,
    from: { userId, name: sender.name, email: sender.email },
    to: toEmails.map(toAddress),
    cc: ccEmails.map(toAddress),
    subject,
    body,
    attachments: [...kept, ...added],
    sentAt: sending ? new Date() : null,
  };

  if (message) {
    message.set(fields);
    await message.save();
  } else {
    message = await Message.create(fields);
  }

  const now = new Date();
  let senderItem = draftItem;
  if (!senderItem) {
    senderItem = new MailItem({ userId, messageId: message._id, threadId, folder: "draft", read: true });
  }
  senderItem.folder = sending ? "sent" : "draft";
  senderItem.date = now;
  senderItem.read = true;
  await senderItem.save();
  indexMailItem(senderItem, message);

  if (!sending) return res.status(201).json(detail(senderItem, message));

  // Deliver a copy to every recipient's inbox.
  const recipientIds = [...new Set([...message.to, ...message.cc].map((a) => a.userId!))];
  for (const rid of recipientIds) {
    const inboxItem = await MailItem.create({
      userId: rid,
      messageId: message._id,
      threadId,
      folder: "inbox",
      read: false,
      date: now,
    });
    indexMailItem(inboxItem, message);
  }
  return res.status(201).json(detail(senderItem, message));
}
