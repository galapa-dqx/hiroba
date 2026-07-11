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
import type {
  AbyssSlot,
  BossRotation,
  IconGridSlot,
  TsuyosaForecast,
} from '@hiroba/scraper';

export const SCHEDULE_SOURCE_TYPE = 'schedule';
const ZONE = 'Asia/Tokyo';
const CHANGEOVER_HOUR = 6; // rotations flip at 06:00 JST

const CONTENT_LABELS: Record<BossRotation['content'], string> = {
  bootcamp: 'ヴァリーブートキャンプ',
  panigarm: '源世庫パニガルム',
};

// Icon-only sections carry no readable boss/brigade name; the event title is the
// section label and the icon (encoded in sourceId) identifies which one.
const DEFENSE_LABEL = 'アストルティア防衛軍';
const METAL_LABEL = 'メタルーキー軍団 大行進';
const ABYSS_LABEL = '深淵の咎人たち';

/**
 * sourceId encodes the content key and, for icon sections, the icon URL:
 * "panigarm" | "defense#https://…/12.png". The calendar splits on '#' to render
 * the icon and to gate the dense sections behind a toggle.
 */
function iconSourceId(content: string, iconUrl: string): string {
  return `${content}#${iconUrl}`;
}

/** Build all schedule event rows from a forecast. */
export function buildScheduleEvents(
  forecast: TsuyosaForecast,
  now: Temporal.Instant,
): NewEvent[] {
  const rows: NewEvent[] = [];
  for (const rotation of [forecast.bootcamp, forecast.panigarm]) {
    if (rotation) rows.push(...bossRotationEvents(rotation, now));
  }
  rows.push(...iconGridEvents(forecast.defense, 'defense', DEFENSE_LABEL, now));
  rows.push(...iconGridEvents(forecast.metal, 'metal', METAL_LABEL, now));
  rows.push(...abyssEvents(forecast.abyss, now));
  return rows;
}

/**
 * Merge an icon grid's contiguous same-icon cells (防衛軍 hourly, メタルーキー
 * half-hourly) into `span` events. Title is the section label; the icon lives in
 * sourceId. These are the dense sections the calendar hides by default.
 */
function iconGridEvents(
  slots: IconGridSlot[],
  content: 'defense' | 'metal',
  label: string,
  now: Temporal.Instant,
): NewEvent[] {
  const sorted = [...slots].sort(
    (a, b) =>
      a.date.toString().localeCompare(b.date.toString()) ||
      a.startMinute - b.startMinute,
  );
  const rows: NewEvent[] = [];
  let run: {
    date: Temporal.PlainDate;
    startMinute: number;
    endMinute: number;
    iconUrl: string;
  } | null = null;

  const flush = () => {
    if (!run) return;
    const midnight = run.date.toZonedDateTime(ZONE);
    const start = midnight.add({ minutes: run.startMinute });
    const end = midnight.add({ minutes: run.endMinute });
    const sourceId = iconSourceId(content, run.iconUrl);
    rows.push({
      id: scheduleEventId(sourceId, label, start, end),
      type: 'span',
      titleJa: label,
      startTime: start,
      endTime: end,
      sourceType: SCHEDULE_SOURCE_TYPE,
      sourceId,
      createdAt: now,
    });
    run = null;
  };

  for (const s of sorted) {
    if (
      run &&
      run.date.equals(s.date) &&
      run.iconUrl === s.iconUrl &&
      run.endMinute === s.startMinute
    ) {
      run.endMinute = s.startMinute + s.durationMinutes;
    } else {
      flush();
      run = {
        date: s.date,
        startMinute: s.startMinute,
        endMinute: s.startMinute + s.durationMinutes,
        iconUrl: s.iconUrl,
      };
    }
  }
  flush();
  return rows;
}

/**
 * 深淵 bosses: one `allDay` event per boss icon per day. The page keys these by
 * calendar date (no time), and all-day reads as a band chip rather than an
 * awkward 06:00-split bar.
 */
function abyssEvents(slots: AbyssSlot[], now: Temporal.Instant): NewEvent[] {
  return slots.map((s) => {
    const start = s.date.toZonedDateTime(ZONE);
    const sourceId = iconSourceId('abyss', s.iconUrl);
    return {
      id: scheduleEventId(sourceId, ABYSS_LABEL, start, start),
      type: 'allDay',
      titleJa: ABYSS_LABEL,
      startTime: start,
      endTime: null,
      sourceType: SCHEDULE_SOURCE_TYPE,
      sourceId,
      createdAt: now,
    };
  });
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
