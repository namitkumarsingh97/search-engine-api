import { Recurrence, RepeatFreq } from "../database/models/CalendarEvent";

export interface Occurrence {
  start: Date;
  end: Date;
}

const DAY_MS = 86_400_000;
const MAX_OCCURRENCES = 500; // per event per query
const MAX_STEPS = 20_000; // hard stop for runaway loops

/** `base` shifted forward by n periods. Month/year steps clamp to the end of short months. */
function addPeriods(base: Date, freq: RepeatFreq, n: number): Date {
  const d = new Date(base.getTime());
  if (freq === "daily") {
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  }
  if (freq === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7 * n);
    return d;
  }
  const months = freq === "monthly" ? n : 12 * n;
  const day = base.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, daysInMonth));
  return d;
}

/**
 * All occurrences of an event that overlap [from, to).
 * Series arithmetic is done in UTC, so a repeating event keeps its UTC time of
 * day (it can shift by an hour across DST changes in the viewer's timezone).
 */
export function expandOccurrences(
  event: { start: Date; end: Date; recurrence: Recurrence | null; exdates: Date[] },
  from: Date,
  to: Date,
): Occurrence[] {
  const duration = event.end.getTime() - event.start.getTime();
  const overlaps = (s: Date, e: Date) => s < to && (e > from || s >= from);

  const rec = event.recurrence;
  if (!rec) {
    return overlaps(event.start, event.end) ? [{ start: event.start, end: event.end }] : [];
  }

  const skipped = new Set(event.exdates.map((d) => d.getTime()));
  const out: Occurrence[] = [];

  // Daily/weekly series can jump straight to the first occurrence near `from`.
  let k = 0;
  if (rec.freq === "daily" || rec.freq === "weekly") {
    const stepMs = rec.interval * (rec.freq === "daily" ? DAY_MS : 7 * DAY_MS);
    k = Math.max(0, Math.floor((from.getTime() - duration - event.start.getTime()) / stepMs));
  }

  for (let steps = 0; steps < MAX_STEPS && out.length < MAX_OCCURRENCES; steps++, k++) {
    if (rec.count && k >= rec.count) break;
    const s = addPeriods(event.start, rec.freq, k * rec.interval);
    if (rec.until && s > rec.until) break;
    if (s >= to) break;
    const e = new Date(s.getTime() + duration);
    if (overlaps(s, e) && !skipped.has(s.getTime())) out.push({ start: s, end: e });
  }
  return out;
}

export function describeRecurrence(rec: Recurrence | null): string {
  if (!rec) return "";
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rec.freq];
  return rec.interval === 1 ? `repeats every ${unit}` : `repeats every ${rec.interval} ${unit}s`;
}
