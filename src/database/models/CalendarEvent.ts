import mongoose, { Schema, Document as MongoDocument } from "mongoose";

export type RepeatFreq = "daily" | "weekly" | "monthly" | "yearly";

export interface Recurrence {
  freq: RepeatFreq;
  /** Every N days/weeks/months/years. */
  interval: number;
  /** Stop after this instant (inclusive). */
  until?: Date | null;
  /** Or stop after this many occurrences. */
  count?: number | null;
}

export interface CalendarEventDocument extends MongoDocument {
  ownerId: string;
  title: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurrence: Recurrence | null;
  /** Occurrence start times removed from a repeating series. */
  exdates: Date[];
  /** Minutes before the start to remind; null means no reminder. */
  reminderMinutes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const eventSchema = new Schema<CalendarEventDocument>(
  {
    ownerId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, default: "", maxlength: 5000 },
    location: { type: String, default: "", maxlength: 200 },
    start: { type: Date, required: true, index: true },
    end: { type: Date, required: true },
    allDay: { type: Boolean, default: false },
    recurrence: {
      type: new Schema(
        {
          freq: { type: String, enum: ["daily", "weekly", "monthly", "yearly"], required: true },
          interval: { type: Number, default: 1, min: 1, max: 99 },
          until: { type: Date, default: null },
          count: { type: Number, default: null, min: 1, max: 500 },
        },
        { _id: false },
      ),
      default: null,
    },
    exdates: { type: [Date], default: [] },
    reminderMinutes: { type: Number, default: null, min: 0, max: 60 * 24 * 30 },
  },
  { timestamps: true },
);

export const CalendarEvent = mongoose.model<CalendarEventDocument>("CalendarEvent", eventSchema);
