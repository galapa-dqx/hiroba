/**
 * Day-agenda view model — classifies the events overlapping one JST calendar
 * day into the three shapes the timeline renders, purely from each event's
 * geometric relationship to the day (the stored `type` is unreliable for
 * layout — some multi-month events are typed `span`). `type === 'mark'` is used
 * only to pick the milestone rendering.
 *
 *   - band      events that cover the whole day (ongoing multi-day + allDay) →
 *               listed above the timeline
 *   - bars      events with a bounded portion inside the day → rectangles;
 *               `openStart` / `openEnd` mark the edges that spill past the day
 *   - milestones point-in-time marks → a line/tick
 *
 * Positions are fractions of the day (0 = 00:00 JST, 1 = 24:00 JST). The axis
 * is rendered in JST server-side; the client relabels it to the viewer's zone.
 */

import { type Temporal } from 'temporal-polyfill';

import type { EventWithTitle } from '@hiroba/db';

/** Game-server zone — the canonical schedule every event is stored in. */
export const AGENDA_ZONE = 'Asia/Tokyo';

export type BandItem = {
  event: EventWithTitle;
};

export type BarItem = {
  event: EventWithTitle;
  /** Top edge as a fraction of the day (0..1). */
  startFrac: number;
  /** Bottom edge as a fraction of the day (0..1). */
  endFrac: number;
  /** Event began before this day — top edge is a continuation, not a start. */
  openStart: boolean;
  /** Event ends after this day — bottom edge is a continuation, not an end. */
  openEnd: boolean;
  /** Column index within this bar's overlap cluster. */
  lane: number;
  /** Number of columns in this bar's overlap cluster (for width). */
  laneCount: number;
};

export type MilestoneItem = {
  event: EventWithTitle;
  /** Position down the axis as a fraction of the day (0..1). */
  frac: number;
};

export type DayAgenda = {
  band: BandItem[];
  /** Main-column bars (lane-packed among themselves). */
  bars: BarItem[];
  /** Bars pulled into dedicated side columns, keyed by swimlane id; each group
   *  is lane-packed independently so it never shifts the main column. */
  swimlanes: Record<string, BarItem[]>;
  milestones: MilestoneItem[];
};

/** Group key for a bar's event, or null to keep it in the main column. */
export type SwimlaneKey = (event: EventWithTitle) => string | null;

const MAIN = '__main__';

const DAY_MS = 86_400_000; // Asia/Tokyo has no DST, so every day is exactly 24h.

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** The instant an event effectively ends, by type. */
function effectiveEndMs(e: EventWithTitle): number {
  if (e.type === 'allDay') {
    return e.startTime.add({ days: 1 }).toInstant().epochMilliseconds;
  }
  if (e.type === 'mark' || e.endTime === null) {
    return e.startTime.toInstant().epochMilliseconds;
  }
  return e.endTime.toInstant().epochMilliseconds;
}

/**
 * Partition bars into overlap clusters and greedily assign a lane within each,
 * so overlapping bars sit side by side while isolated bars keep the full width.
 * Bars must already be sorted by `startFrac`.
 */
function assignLanes(bars: BarItem[]): void {
  let i = 0;
  while (i < bars.length) {
    // Grow a cluster while the next bar overlaps the cluster's running end.
    let clusterEnd = bars[i].endFrac;
    let j = i + 1;
    while (j < bars.length && bars[j].startFrac < clusterEnd) {
      clusterEnd = Math.max(clusterEnd, bars[j].endFrac);
      j++;
    }
    // Greedy lane packing within [i, j): reuse a lane once its bar has ended.
    const laneEnds: number[] = [];
    for (let k = i; k < j; k++) {
      const bar = bars[k];
      let lane = laneEnds.findIndex((end) => end <= bar.startFrac);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(bar.endFrac);
      } else {
        laneEnds[lane] = bar.endFrac;
      }
      bar.lane = lane;
    }
    const laneCount = laneEnds.length;
    for (let k = i; k < j; k++) bars[k].laneCount = laneCount;
    i = j;
  }
}

/**
 * Build the agenda view model for `day` (a JST calendar date) from the events
 * overlapping it.
 */
export function buildDayAgenda(
  events: EventWithTitle[],
  day: Temporal.PlainDate,
  swimlaneKey?: SwimlaneKey,
): DayAgenda {
  const dayStartMs = day
    .toZonedDateTime(AGENDA_ZONE)
    .toInstant().epochMilliseconds;
  const dayEndMs = dayStartMs + DAY_MS;

  const band: BandItem[] = [];
  const milestones: MilestoneItem[] = [];
  // Bars grouped by swimlane key (MAIN for the main column). Each group is
  // lane-packed on its own so a busy side column never reflows the main one.
  const groups = new Map<string, BarItem[]>();

  for (const event of events) {
    if (event.type === 'mark') {
      const ms = event.startTime.toInstant().epochMilliseconds;
      milestones.push({ event, frac: clamp01((ms - dayStartMs) / DAY_MS) });
      continue;
    }

    const startMs = event.startTime.toInstant().epochMilliseconds;
    const endMs = effectiveEndMs(event);

    // Covers the whole day → the top band (ongoing multi-day, or allDay).
    if (startMs <= dayStartMs && endMs >= dayEndMs) {
      band.push({ event });
      continue;
    }

    const key = swimlaneKey?.(event) ?? MAIN;
    const bar: BarItem = {
      event,
      startFrac: clamp01((startMs - dayStartMs) / DAY_MS),
      endFrac: clamp01((endMs - dayStartMs) / DAY_MS),
      openStart: startMs < dayStartMs,
      openEnd: endMs > dayEndMs,
      lane: 0,
      laneCount: 1,
    };
    const group = groups.get(key);
    if (group) group.push(bar);
    else groups.set(key, [bar]);
  }

  const swimlanes: Record<string, BarItem[]> = {};
  for (const [key, groupBars] of groups) {
    groupBars.sort(
      (a, b) => a.startFrac - b.startFrac || a.endFrac - b.endFrac,
    );
    assignLanes(groupBars);
    if (key !== MAIN) swimlanes[key] = groupBars;
  }
  milestones.sort((a, b) => a.frac - b.frac);

  return { band, bars: groups.get(MAIN) ?? [], swimlanes, milestones };
}
