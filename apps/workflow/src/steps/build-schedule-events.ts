/**
 * Turn a scraped つよさ予報 forecast into `events` rows. These are deterministic
 * recurring-rotation occurrences (no LLM): each boss slot becomes a `span` event
 * running from its 06:00 JST changeover to the next slot's changeover, so on the
 * calendar it reads as a whole-day band on interior days and a 06:00 bar on the
 * changeover day.
 *
 * All rows carry `sourceType='schedule'` and `sourceId=<content key>` so the
 * calendar can style/group them and `replaceScheduleEvents` can swap the whole
 * set each scrape. Ids are a deterministic hash so re-scrapes upsert in place.
 */

import { type Temporal } from 'temporal-polyfill';

import type { NewEvent } from '@hiroba/db';
import type { BossRotation, TsuyosaForecast } from '@hiroba/scraper';

export const SCHEDULE_SOURCE_TYPE = 'schedule';
const ZONE = 'Asia/Tokyo';
const CHANGEOVER_HOUR = 6; // rotations flip at 06:00 JST

const CONTENT_LABELS: Record<BossRotation['content'], string> = {
  bootcamp: 'ヴァリーブートキャンプ',
  panigarm: '源世庫パニガルム',
};

/** Build all schedule event rows from a forecast. */
export function buildScheduleEvents(
  forecast: TsuyosaForecast,
  now: Temporal.Instant,
): NewEvent[] {
  const rows: NewEvent[] = [];
  for (const rotation of [forecast.bootcamp, forecast.panigarm]) {
    if (rotation) rows.push(...bossRotationEvents(rotation, now));
  }
  return rows;
}

/** One `span` per boss slot: [date 06:00, nextDate 06:00) (last: + periodDays). */
function bossRotationEvents(
  rotation: BossRotation,
  now: Temporal.Instant,
): NewEvent[] {
  const label = CONTENT_LABELS[rotation.content];
  return rotation.slots.map((slot, i) => {
    const start = changeover(slot.date);
    const next = rotation.slots[i + 1];
    const end = next
      ? changeover(next.date)
      : start.add({ days: rotation.periodDays });
    const titleJa = `${label}：${slot.bossJa}`;
    return {
      id: scheduleEventId(rotation.content, titleJa, start, end),
      type: 'span',
      titleJa,
      startTime: start,
      endTime: end,
      sourceType: SCHEDULE_SOURCE_TYPE,
      sourceId: rotation.content,
      createdAt: now,
    };
  });
}

/** Midnight-JST of a date bumped to the 06:00 rotation changeover. */
function changeover(date: Temporal.PlainDate): Temporal.ZonedDateTime {
  return date.toZonedDateTime(ZONE).add({ hours: CHANGEOVER_HOUR });
}

/** Deterministic id from the row's identity (content|title|start|end). */
function scheduleEventId(
  content: string,
  title: string,
  start: Temporal.ZonedDateTime,
  end: Temporal.ZonedDateTime,
): string {
  const str = [content, title, start.toString(), end.toString()].join('|');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash; // 32-bit
  }
  return `sched-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}
