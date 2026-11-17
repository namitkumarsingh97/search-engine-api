import crypto from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import { User } from "../database/models/User";
import { Video, VideoDocument } from "../database/models/Video";
import { VideoComment } from "../database/models/VideoComment";
import { asyncHandler } from "../middleware/asyncHandler";
import { AuthedRequest, optionalAuth, requireAuth } from "../middleware/auth";
import { fileStorage } from "../storage/localStorage";
import { indexVideo, unindexVideo } from "../video/indexing";
import { probeAndThumbnail } from "../video/media";

export const videoRouter = Router();

const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB ?? 500);
const PAGE_SIZE = 24;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, fileStorage.uploadDir((req as AuthedRequest).userId!)),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("video/")),
});

/**
 * <video> and <img> tags can't send an Authorization header, so the stream and
 * thumbnail endpoints also accept ?token=. Only used for private videos.
 */
function queryToken(req: Request, _res: Response, next: NextFunction) {
  if (!req.headers.authorization && typeof req.query.token === "string") {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}

function toDto(v: VideoDocument, viewerId?: string) {
  return {
    id: String(v._id),
    ownerId: v.ownerId,
    ownerName: v.ownerName,
    title: v.title,
    description: v.description,
    visibility: v.visibility,
    mimeType: v.mimeType,
    size: v.size,
    duration: v.duration ?? null,
    hasThumbnail: Boolean(v.thumbnailKey),
    views: v.views,
    likeCount: v.likes.length,
    liked: viewerId ? v.likes.includes(viewerId) : false,
    commentCount: v.commentCount,
    createdAt: v.createdAt,
  };
}

const canView = (v: VideoDocument, viewerId?: string) => v.visibility === "public" || v.ownerId === viewerId;

async function findViewable(id: string, viewerId?: string): Promise<VideoDocument | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  const video = await Video.findById(id);
  return video && canView(video, viewerId) ? video : null;
}

async function findOwned(id: string, ownerId: string): Promise<VideoDocument | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  return Video.findOne({ _id: id, ownerId });
}

function cleanTitle(raw: unknown): string | null {
  const t = String(raw ?? "").trim();
  return t && t.length <= 150 ? t : null;
}

// GET /api/videos?page=1&mine=1
videoRouter.get(
  "/",
  optionalAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const mine = req.query.mine === "1";
    if (mine && !req.userId) return res.status(401).json({ error: "Authentication required" });

    const filter = mine ? { ownerId: req.userId } : { visibility: "public" };
    const [videos, total] = await Promise.all([
      Video.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE),
      Video.countDocuments(filter),
    ]);
    res.json({ page, total, pageSize: PAGE_SIZE, videos: videos.map((v) => toDto(v, req.userId)) });
  }),
);

// POST /api/videos  multipart: video (file) + title, description, visibility
videoRouter.post("/", requireAuth, (req: AuthedRequest, res: Response, next: NextFunction) => {
  upload.single("video")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res
        .status(tooBig ? 413 : 400)
        .json({ error: tooBig ? `Video exceeds the ${MAX_VIDEO_MB} MB limit` : err.message });
    }
    if (err) return next(err);

    (async () => {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "Attach a video file (field 'video')" });

      const ownerId = req.userId!;
      const key = fileStorage.keyFor(ownerId, file.filename);
      const originalName = Buffer.from(file.originalname, "latin1").toString("utf8");
      const title = cleanTitle(req.body?.title) ?? cleanTitle(path.parse(originalName).name);
      if (!title) {
        await fileStorage.remove(key);
        return res.status(400).json({ error: "A title (max 150 characters) is required" });
      }

      const user = await User.findById(ownerId);
      if (!user) {
        await fileStorage.remove(key);
        return res.status(401).json({ error: "Account no longer exists" });
      }

      const thumbKey = fileStorage.keyFor(ownerId, `${file.filename}.jpg`);
      const info = await probeAndThumbnail(file.path, fileStorage.absolutePath(thumbKey));

      const video = await Video.create({
        ownerId,
        ownerName: user.name,
        title,
        description: String(req.body?.description ?? "").slice(0, 5000),
        visibility: req.body?.visibility === "private" ? "private" : "public",
        mimeType: file.mimetype,
        size: file.size,
        storageKey: key,
        thumbnailKey: info.thumbnailCreated ? thumbKey : undefined,
        duration: info.duration,
      });
      indexVideo(video);
      res.status(201).json(toDto(video, ownerId));
    })().catch(next);
  });
});

// GET /api/videos/:id
videoRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findViewable(req.params.id, req.userId);
    if (!video) return res.status(404).json({ error: "Video not found" });
    res.json(toDto(video, req.userId));
  }),
);

// GET /api/videos/:id/stream  — supports HTTP Range so players can seek
videoRouter.get(
  "/:id/stream",
  queryToken,
  optionalAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findViewable(req.params.id, req.userId);
    if (!video || !fileStorage.exists(video.storageKey)) return res.status(404).json({ error: "Video not found" });

    const size = video.size;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", video.mimeType);

    const range = req.headers.range;
    if (!range) {
      res.setHeader("Content-Length", size);
      return void fileStorage.createReadStream(video.storageKey).pipe(res);
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = m && m[1] !== "" ? Number(m[1]) : NaN;
    let end = m && m[2] !== "" ? Number(m[2]) : NaN;
    if (!m || (Number.isNaN(start) && Number.isNaN(end))) {
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }
    if (Number.isNaN(start)) {
      // "bytes=-500" means the last 500 bytes
      start = Math.max(0, size - end);
      end = size - 1;
    } else if (Number.isNaN(end) || end >= size) {
      end = size - 1;
    }
    if (start > end || start >= size) {
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    fileStorage.createReadStream(video.storageKey, { start, end }).pipe(res);
  }),
);

// GET /api/videos/:id/thumbnail
videoRouter.get(
  "/:id/thumbnail",
  queryToken,
  optionalAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findViewable(req.params.id, req.userId);
    if (!video?.thumbnailKey || !fileStorage.exists(video.thumbnailKey)) {
      return res.status(404).json({ error: "No thumbnail" });
    }
    res.type("image/jpeg");
    fileStorage.createReadStream(video.thumbnailKey).pipe(res);
  }),
);

// POST /api/videos/:id/view  — the player calls this once when playback starts
videoRouter.post(
  "/:id/view",
  optionalAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findViewable(req.params.id, req.userId);
    if (!video) return res.status(404).json({ error: "Video not found" });
    const updated = await Video.findByIdAndUpdate(video._id, { $inc: { views: 1 } }, { new: true });
    res.json({ views: updated?.views ?? video.views });
  }),
);

// POST /api/videos/:id/like  — toggles
videoRouter.post(
  "/:id/like",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findViewable(req.params.id, req.userId);
    if (!video) return res.status(404).json({ error: "Video not found" });
    const liked = video.likes.includes(req.userId!);
    const updated = await Video.findByIdAndUpdate(
      video._id,
      liked ? { $pull: { likes: req.userId } } : { $addToSet: { likes: req.userId } },
      { new: true },
    );
    res.json({ liked: !liked, likeCount: updated?.likes.length ?? 0 });
  }),
);

// PATCH /api/videos/:id  { title?, description?, visibility? }
videoRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findOwned(req.params.id, req.userId!);
    if (!video) return res.status(404).json({ error: "Video not found" });

    if (req.body?.title !== undefined) {
      const title = cleanTitle(req.body.title);
      if (!title) return res.status(400).json({ error: "Invalid title" });
      video.title = title;
    }
    if (req.body?.description !== undefined) video.description = String(req.body.description).slice(0, 5000);
    if (req.body?.visibility === "public" || req.body?.visibility === "private") {
      video.visibility = req.body.visibility;
    }
    await video.save();
    indexVideo(video);
    res.json(toDto(video, req.userId));
  }),
);

// DELETE /api/videos/:id
videoRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findOwned(req.params.id, req.userId!);
    if (!video) return res.status(404).json({ error: "Video not found" });

    await fileStorage.remove(video.storageKey);
    if (video.thumbnailKey) await fileStorage.remove(video.thumbnailKey);
    await VideoComment.deleteMany({ videoId: video._id });
    unindexVideo(String(video._id));
    await video.deleteOne();
    res.json({ deleted: true });
  }),
);

// GET /api/videos/:id/comments
videoRouter.get(
  "/:id/comments",
  optionalAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findViewable(req.params.id, req.userId);
    if (!video) return res.status(404).json({ error: "Video not found" });
    const comments = await VideoComment.find({ videoId: video._id }).sort({ createdAt: -1 }).limit(200);
    res.json(
      comments.map((c) => ({
        id: String(c._id),
        userId: c.userId,
        userName: c.userName,
        text: c.text,
        createdAt: c.createdAt,
        canDelete: c.userId === req.userId || video.ownerId === req.userId,
      })),
    );
  }),
);

// POST /api/videos/:id/comments  { text }
videoRouter.post(
  "/:id/comments",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findViewable(req.params.id, req.userId);
    if (!video) return res.status(404).json({ error: "Video not found" });

    const text = String(req.body?.text ?? "").trim();
    if (!text || text.length > 2000) return res.status(400).json({ error: "Comment must be 1-2000 characters" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(401).json({ error: "Account no longer exists" });

    const c = await VideoComment.create({ videoId: video._id, userId: req.userId!, userName: user.name, text });
    await Video.findByIdAndUpdate(video._id, { $inc: { commentCount: 1 } });
    res.status(201).json({
      id: String(c._id),
      userId: c.userId,
      userName: c.userName,
      text: c.text,
      createdAt: c.createdAt,
      canDelete: true,
    });
  }),
);

// DELETE /api/videos/:id/comments/:commentId  — comment author or video owner
videoRouter.delete(
  "/:id/comments/:commentId",
  requireAuth,
  asyncHandler<AuthedRequest>(async (req, res) => {
    const video = await findViewable(req.params.id, req.userId);
    if (!video || !mongoose.isValidObjectId(req.params.commentId)) {
      return res.status(404).json({ error: "Comment not found" });
    }
    const comment = await VideoComment.findOne({ _id: req.params.commentId, videoId: video._id });
    if (!comment) return res.status(404).json({ error: "Comment not found" });
    if (comment.userId !== req.userId && video.ownerId !== req.userId) {
      return res.status(403).json({ error: "Not allowed" });
    }
    await comment.deleteOne();
    await Video.findByIdAndUpdate(video._id, { $inc: { commentCount: -1 } });
    res.json({ deleted: true });
  }),
);
