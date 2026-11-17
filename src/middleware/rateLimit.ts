import { NextFunction, Request, Response } from "express";

interface Options {
  windowMs: number;
  max: number;
  /** What to count by. Defaults to the client IP. */
  key?: (req: Request) => string | undefined;
  message?: string;
}

/**
 * Small in-memory fixed-window limiter. Fine for one server process; if this
 * ever runs on several instances, move the counters to Redis or Mongo.
 */
export function rateLimit({ windowMs, max, key, message }: Options) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Drop expired entries so the map can't grow without bound.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const id = key?.(req) ?? req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(id);

    if (!entry || entry.resetAt <= now) {
      hits.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: message ?? "Too many requests. Please slow down and try again shortly." });
    }
    entry.count++;
    next();
  };
}
