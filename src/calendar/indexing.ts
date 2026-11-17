import { CalendarEvent, CalendarEventDocument } from "../database/models/CalendarEvent";
import { searchIndex } from "../search/indexer";
import { describeRecurrence } from "./recurrence";

/** Events are always private: indexed with the owner's id. */
export function indexEvent(event: CalendarEventDocument): void {
  const id = String(event._id);
  const when = event.start.toUTCString(); // e.g. "Tue, 17 Nov 2026 14:00:00 GMT" so day/month names are searchable

  searchIndex.addDocument({
    id,
    type: "event",
    ownerId: event.ownerId,
    title: event.title,
    // The calendar page opens the month containing this date and selects the event.
    url: `/calendar?event=${id}`,
    content: [event.description, event.location, when, describeRecurrence(event.recurrence)]
      .filter(Boolean)
      .join(" — "),
    headings: event.location,
    date: event.start.toISOString(),
  });
}

export function unindexEvent(id: string): void {
  searchIndex.removeDocument(id);
}

export async function loadEventsIntoIndex(): Promise<number> {
  const events = await CalendarEvent.find();
  events.forEach(indexEvent);
  return events.length;
}
