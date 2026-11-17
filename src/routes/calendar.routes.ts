import { Router } from "express";
import mongoose from "mongoose";
import { indexEvent, unindexEvent } from "../calendar/indexing";
import { expandOccurrences } from "../calendar/recurrence";
import { CalendarEvent, CalendarEventDocument, Recurrence } from "../database/models/CalendarEvent";
import { asyncHandler } from "../middleware/asyncHandler";
import { AuthedRequest, requireAuth } from "../middleware/auth";

export const calendarRouter = Router();
calendarRouter.use(requireAuth);

const HOUR_MS = 3_600_000;
const MAX_RANGE_DAYS = 400;
const FREQS = ["daily", "weekly", "monthly", "yearly"];

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Fields = Partial<
  Pick<CalendarEventDocument, "title" | "description" | "location" | "start" | "end" | "allDay" | "recurrence" | "reminderMinutes">
>;

/** Validates a create/update body. `current` is set for PATCH (only given fields change). */
function buildFields(body: Record<string, unknown>, current?: CalendarEventDocument): { error: string } | { fields: Fields } {
  const f: Fields = {};

  if (body.title !== undefined || !current) {
    const title = String(body.title ?? "").trim();
    if (!title || title.length > 150) return { error: "Title is required (max 150 characters)" };
    f.title = title;
  }
  if (body.description !== undefined) f.description = String(body.description).slice(0, 5000);
  if (body.location !== undefined) f.location = String(body.location).slice(0, 200);
  if (body.allDay !== undefined) f.allDay = Boolean(body.allDay);

  if (body.start !== undefined || body.end !== undefined || !current) {
    const start = body.start !== undefined ? parseDate(body.start) : current?.start ?? null;
    if (!start) return { error: "A valid start date is required" };

    let end: Date | null;
    if (body.end !== undefined) end = parseDate(body.end);
    else if (current) end = new Date(start.getTime() + (current.end.getTime() - current.start.getTime()));
    else end = new Date(start.getTime() + HOUR_MS);

    if (!end) return { error: "End date is invalid" };
    if (end < start) return { error: "End must not be before start" };
    f.start = start;
    f.end = end;
  }

  if (body.recurrence !== undefined) {
    if (body.recurrence === null) {
      f.recurrence = null;
    } else {
      const r = body.recurrence as Record<string, unknown>;
      if (typeof r !== "object" || !FREQS.includes(String(r.freq))) return { error: "Invalid repeat frequency" };
      const interval = Number(r.interval ?? 1);
      if (!Number.isInteger(interval) || interval < 1 || interval > 99) return { error: "Repeat interval must be 1-99" };

      const rec: Recurrence = { freq: r.freq as Recurrence["freq"], interval, until: null, count: null };
      if (r.until) {
        const until = parseDate(r.until);
        if (!until) return { error: "Invalid repeat end date" };
        rec.until = until;
      }
      if (r.count) {
        const count = Number(r.count);
        if (!Number.isInteger(count) || count < 1 || count > 500) return { error: "Repeat count must be 1-500" };
        rec.count = count;
      }
      f.recurrence = rec;
    }
  }

  if (body.reminderMinutes !== undefined) {
    if (body.reminderMinutes === null) {
      f.reminderMinutes = null;
    } else {
      const m = Number(body.reminderMinutes);
      if (!Number.isInteger(m) || m < 0 || m > 60 * 24 * 30) return { error: "Invalid reminder" };
      f.reminderMinutes = m;
    }
  }
  return { fields: f };
}

function toDto(e: CalendarEventDocument) {
  return {
    id: String(e._id),
    title: e.title,
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    recurrence: e.recurrence
      ? { freq: e.recurrence.freq, interval: e.recurrence.interval, until: e.recurrence.until ?? null, count: e.recurrence.count ?? null }
      : null,
    reminderMinutes: e.reminderMinutes,
  };
}

function toOccurrenceDto(e: CalendarEventDocument, o: { start: Date; end: Date }) {
  return {
    id: String(e._id),
    title: e.title,
    description: e.description,
    location: e.location,
    allDay: e.allDay,
    start: o.start,
    end: o.end,
    recurring: Boolean(e.recurrence),
    reminderMinutes: e.reminderMinutes,
  };
}

async function occurrencesBetween(ownerId: string, from: Date, to: Date) {
  const events = await CalendarEvent.find({
    ownerId,
    start: { $lt: to },
    $or: [
      { recurrence: null, end: { $gte: from } },
      { recurrence: { $ne: null }, $or: [{ "recurrence.until": null }, { "recurrence.until": { $gte: from } }] },
    ],
  });
  return events
    .flatMap((e) => expandOccurrences(e, from, to).map((o) => toOccurrenceDto(e, o)))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

async function findOwned(id: string, ownerId: string) {
  return mongoose.isValidObjectId(id) ? CalendarEvent.findOne({ _id: id, ownerId }) : null;
}

// GET /api/calendar/events?from=ISO&to=ISO  — occurrences (repeats expanded) in the range
calendarRouter.get(
  "/events",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (!from || !to || to <= from) return res.status(400).json({ error: "Query params 'from' and 'to' (ISO dates) are required" });
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      return res.status(400).json({ error: `Range can't exceed ${MAX_RANGE_DAYS} days` });
    }
    res.json(await occurrencesBetween(req.userId!, from, to));
  }),
);

// GET /api/calendar/upcoming?days=7  — next occurrences from now (drives reminders)
calendarRouter.get(
  "/upcoming",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 7));
    const now = new Date();
    const list = await occurrencesBetween(req.userId!, now, new Date(now.getTime() + days * 86_400_000));
    res.json(list.slice(0, 50));
  }),
);

// GET /api/calendar/events/:id  — the full event (series definition)
calendarRouter.get(
  "/events/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const event = await findOwned(req.params.id, req.userId!);
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json(toDto(event));
  }),
);

// POST /api/calendar/events
calendarRouter.post(
  "/events",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const parsed = buildFields(req.body ?? {});
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const event = await CalendarEvent.create({ ...parsed.fields, ownerId: req.userId! });
    indexEvent(event);
    res.status(201).json(toDto(event));
  }),
);

// PATCH /api/calendar/events/:id  — edits the whole series for repeating events
calendarRouter.patch(
  "/events/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const event = await findOwned(req.params.id, req.userId!);
    if (!event) return res.status(404).json({ error: "Event not found" });

    const parsed = buildFields(req.body ?? {}, event);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });

    const startMoved = parsed.fields.start && parsed.fields.start.getTime() !== event.start.getTime();
    event.set(parsed.fields);
    if (startMoved) event.exdates = []; // removed occurrences no longer line up with the series
    await event.save();
    indexEvent(event);
    res.json(toDto(event));
  }),
);

// DELETE /api/calendar/events/:id[?occurrence=ISO]  — whole event, or one occurrence of a series
calendarRouter.delete(
  "/events/:id",
  asyncHandler<AuthedRequest>(async (req, res) => {
    const event = await findOwned(req.params.id, req.userId!);
    if (!event) return res.status(404).json({ error: "Event not found" });

    if (req.query.occurrence !== undefined) {
      const occurrence = parseDate(req.query.occurrence);
      if (!occurrence) return res.status(400).json({ error: "Invalid occurrence date" });
      if (event.recurrence) {
        event.exdates.push(occurrence);
        await event.save();
        return res.json({ deleted: "occurrence" });
      }
    }

    unindexEvent(String(event._id));
    await event.deleteOne();
    res.json({ deleted: "event" });
  }),
);
