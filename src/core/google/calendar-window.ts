/**
 * The calendar sync window: every calendar path materializes only events in
 * `[now - historyDays, now + CALENDAR_HORIZON_DAYS]`.
 *
 * A syncToken delta cannot carry timeMin/timeMax, and with singleEvents=true
 * one change to a recurring series returns every expanded instance, years
 * back and forward. So the window is enforced here on every list (initial,
 * incremental, token-expired and full), with the Calendar API's own
 * semantics: the floor compares an event's END, the ceiling its START.
 *
 * A delta reports changed events only, so an unchanged instance that has
 * entered the horizon since the last list would never arrive. The state's
 * `calendar_horizon_ms` records how far the calendar has been listed, and
 * `calendarCoverageRange` names the bounded stretch to list next. A `--full`
 * reconcile deletes only pages whose event starts inside the listed window and
 * that the complete window list no longer names; nothing before the floor is
 * ever deleted, so shrinking historyDays never removes history.
 */
import type { CalendarEventData } from './types.ts';

/** Days ahead of now the calendar keeps pages for (the windowed list's timeMax). */
export const CALENDAR_HORIZON_DAYS = 60;
const DAY_MS = 86_400_000;

export interface CalendarWindow { floorMs: number; ceilMs: number }

export function calendarWindowAt(nowMs: number, historyDays: number): CalendarWindow {
  return { floorMs: nowMs - historyDays * DAY_MS, ceilMs: nowMs + CALENDAR_HORIZON_DAYS * DAY_MS };
}

/** An event's place against the window; an unparseable start (a cancelled skeleton) counts as in-window. */
export function calendarWindowPlacement(startIso: string, endIso: string, window: CalendarWindow): 'past' | 'in' | 'future' {
  const startMs = Date.parse(startIso);
  if (Number.isFinite(startMs) && startMs >= window.ceilMs) return 'future';
  const endMs = Date.parse(endIso);
  const lastMs = Number.isFinite(endMs) ? endMs : startMs;
  if (Number.isFinite(lastMs) && lastMs <= window.floorMs) return 'past';
  return 'in';
}

/**
 * The stretch still to list after the cursor's own list, or null when none is
 * owed. A windowed list already covered through the ceiling. State that never
 * recorded a horizon (written before it existed) gets one bounded `[now, ceil]`
 * coverage list before the horizon is set; otherwise the stretch past the
 * recorded horizon is listed once the ceiling has moved a day.
 */
export function calendarCoverageRange(horizonMs: number | null | undefined, listedWindow: boolean, window: CalendarWindow,
  nowMs: number): { fromMs: number } | null {
  if (listedWindow) return null;
  if (typeof horizonMs !== 'number') return { fromMs: nowMs };
  return window.ceilMs - horizonMs >= DAY_MS ? { fromMs: horizonMs } : null;
}

export interface CalendarApplyIo<R extends { relPath: string }> {
  signal?: AbortSignal;
  render: (ev: CalendarEventData) => R | null;
  existingPath: (eventId: string) => Promise<string | null>;
  fallbackPath: (ev: CalendarEventData) => string;
  dropPage: (relPath: string) => Promise<void>;
  importPage: (rendered: R) => Promise<void>;
}

/**
 * Materialize listed events inside the window; returns how many were outside
 * it. A past event leaves its page as imported (aged-out history is kept). A
 * cancellation deletes its page wherever the event sits. An event rescheduled
 * past the horizon loses its page; the coverage list brings it back in range.
 */
export async function applyCalendarEvents<R extends { relPath: string }>(events: CalendarEventData[], window: CalendarWindow, io: CalendarApplyIo<R>): Promise<number> {
  let outside = 0;
  for (const ev of events) {
    if (io.signal?.aborted) return outside;
    const rendered = io.render(ev);
    const placement = rendered ? calendarWindowPlacement(ev.startIso, ev.endIso, window) : 'in';
    if (placement === 'past') { outside++; continue; }
    // Identity is the immutable event id, not the date-derived path: reschedules move and
    // cancelled skeletons (id + status only) still find their page.
    const existingPath = await io.existingPath(ev.id);
    if (!rendered) { await io.dropPage(existingPath ?? io.fallbackPath(ev)); continue; }
    if (placement === 'future') {
      outside++;
      if (existingPath) await io.dropPage(existingPath);
      continue;
    }
    if (existingPath && existingPath !== rendered.relPath) await io.dropPage(existingPath);
    await io.importPage(rendered);
  }
  return outside;
}

/** Calendar pages a complete `--full` list of `window` no longer names, limited to events starting inside it. */
export function unlistedInWindow<T extends { event_id: string | null; start_iso: string | null }>(rows: T[], listedIds: ReadonlySet<string>,
  window: CalendarWindow): T[] {
  return rows.filter(row => {
    const startMs = Date.parse(row.start_iso ?? '');
    return row.event_id !== null && !listedIds.has(row.event_id)
      && Number.isFinite(startMs) && startMs >= window.floorMs && startMs < window.ceilMs;
  });
}
