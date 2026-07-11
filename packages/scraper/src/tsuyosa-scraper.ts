/**
 * つよさ予報 scraper — the recurring battle-content rotation schedules at
 * `/sc/tokoyami/`. The page is server-rendered HTML tables (no JS needed), one
 * `<div class="head-withinfo" id="…">` section heading per content followed by a
 * `.tokoyami-box` table. Sections are keyed by stable ids:
 *   raid (防衛軍) · bootcamp (ヴァリー) · panigarm (パニガルム) ·
 *   togabito (深淵) · metal (メタルーキー)
 *
 * This scrapes the two clean boss-rotation sections (bootcamp, panigarm), whose
 * boss names are plain text in the cells. Date headers ("07/11(土)") carry no
 * year, so it's inferred against a reference "today".
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Temporal } from 'temporal-polyfill';

import { SCRAPE_CONFIG } from '@hiroba/shared';

export const TSUYOSA_URL = `${SCRAPE_CONFIG.baseUrl}${SCRAPE_CONFIG.tsuyosaPath}`;

/** A boss occupying one rotation slot, starting on `date` at 06:00 JST. */
export type BossSlot = {
  date: Temporal.PlainDate;
  bossJa: string;
  /** Icon image basename (e.g. "4.png" or a hash) — for dedup/debug. */
  iconKey: string;
};

/** A boss-rotation section: an ordered list of dated slots. */
export type BossRotation = {
  content: 'bootcamp' | 'panigarm';
  /** Days each boss stays before the next rotates in (7 for weekly, 3 for pani). */
  periodDays: number;
  /** Optional linked playguide slug from the section heading. */
  guideSlug: string | null;
  slots: BossSlot[];
};

/** One time-boxed cell of an icon grid (防衛軍 hourly, メタルーキー half-hourly). */
export type IconGridSlot = {
  /** Calendar date the slot falls on (00:00–05:59 rows belong to the next day). */
  date: Temporal.PlainDate;
  /** Minutes since 00:00 JST of `date`. */
  startMinute: number;
  durationMinutes: number;
  /** Full icon image URL (cache-buster stripped) — no readable name exists. */
  iconUrl: string;
};

/** One all-day boss availability (深淵の咎人, 4 bosses per day). */
export type AbyssSlot = {
  date: Temporal.PlainDate;
  iconUrl: string;
};

export type TsuyosaForecast = {
  bootcamp: BossRotation | null;
  panigarm: BossRotation | null;
  /** アストルティア防衛軍 — hourly brigade icons. */
  defense: IconGridSlot[];
  /** メタルーキー軍団 — half-hourly march markers (uniform icon). */
  metal: IconGridSlot[];
  /** 深淵の咎人たち — per-day boss icons. */
  abyss: AbyssSlot[];
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const BOSS_SECTIONS = {
  bootcamp: { periodDays: 7 },
  panigarm: { periodDays: 3 },
} as const;

/** Fetch and parse the current つよさ予報 rotations. */
export async function fetchTsuyosaForecast(): Promise<TsuyosaForecast> {
  const response = await fetch(TSUYOSA_URL, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch つよさ予報: ${response.status}`);
  }
  const html = await response.text();
  const today = Temporal.Now.zonedDateTimeISO('Asia/Tokyo').toPlainDate();
  return parseTsuyosaForecast(html, today);
}

/** Parse the page HTML (pure — `today` anchors year inference). */
export function parseTsuyosaForecast(
  html: string,
  today: Temporal.PlainDate,
): TsuyosaForecast {
  const $ = cheerio.load(html);
  return {
    bootcamp: parseBossRotation($, 'bootcamp', today),
    panigarm: parseBossRotation($, 'panigarm', today),
    defense: parseIconGrid($, 'raid', 60, today),
    metal: parseIconGrid($, 'metal', 30, today),
    abyss: parseAbyss($, today),
  };
}

/**
 * Parse one boss-rotation table (bootcamp / panigarm). Both use
 * `table.tokoyami-panigarm`: a date header row, then a boss row whose cells hold
 * `<img src=".../{icon}">` + `<div>boss name</div>`.
 */
function parseBossRotation(
  $: cheerio.CheerioAPI,
  content: 'bootcamp' | 'panigarm',
  today: Temporal.PlainDate,
): BossRotation | null {
  const heading = $(`#${content}`);
  if (heading.length === 0) return null;

  const guideSlug =
    heading
      .find('a[href*="/sc/public/playguide/"]')
      .attr('href')
      ?.match(/\/playguide\/([A-Za-z0-9_]+)/)?.[1] ?? null;

  const table = heading.nextAll('.tokoyami-box').first().find('table').first();
  const rows = table.find('tr');
  if (rows.length < 2) return null;

  // Header row: skip the leading "日付" th, parse each date column.
  const dates = headerDates($, rows.eq(0), today);
  // Boss row: skip the leading "出現ボスモンスター" th; one td per date column.
  const bossCells = rows.eq(1).find('td');

  const slots: BossSlot[] = [];
  bossCells.each((i, td) => {
    const date = dates[i];
    if (!date) return;
    const bossJa = $(td).find('div').first().text().trim();
    if (!bossJa) return;
    const iconKey = iconBasename($(td).find('img').attr('src'));
    slots.push({ date, bossJa, iconKey });
  });
  if (slots.length === 0) return null;

  return {
    content,
    periodDays: BOSS_SECTIONS[content].periodDays,
    guideSlug,
    slots,
  };
}

/**
 * Parse a time-boxed icon grid (`table.tokoyami-raid`): a date header row, then
 * one row per time slot ("6:00 ～ 6:59") with a per-day cell that holds an icon
 * `<img>` when the content is active. The game day runs 06:00→05:59, so the
 * 00:00–05:59 rows belong to the *next* calendar day.
 */
function parseIconGrid(
  $: cheerio.CheerioAPI,
  sectionId: string,
  durationMinutes: number,
  today: Temporal.PlainDate,
): IconGridSlot[] {
  const heading = $(`#${sectionId}`);
  if (heading.length === 0) return [];
  // The table isn't always in the first following box (metal has a notice box
  // first), so search the following boxes by the grid's table class.
  const table = heading
    .nextAll('.tokoyami-box')
    .find('table.tokoyami-raid')
    .first();
  const rows = table.find('tr');
  if (rows.length < 2) return [];

  const dates = headerDates($, rows.eq(0), today);
  const out: IconGridSlot[] = [];
  rows.slice(1).each((_, tr) => {
    const cells = $(tr).find('td');
    const time = parseSlotStart(cells.eq(0).text());
    if (!time) return;
    // 00:00–05:59 rows roll onto the next calendar day (06:00 game-day anchor).
    const rollsToNextDay = time.hour < 6;
    const startMinute = time.hour * 60 + time.minute;
    cells.slice(1).each((col, td) => {
      const src = $(td).find('img').attr('src');
      const base = dates[col];
      if (!src || !base) return;
      out.push({
        date: rollsToNextDay ? base.add({ days: 1 }) : base,
        startMinute,
        durationMinutes,
        iconUrl: iconUrl(src),
      });
    });
  });
  return out;
}

/**
 * Parse 深淵の咎人 (`#togabito` → `table.tokoyami`): a date header row then one
 * row per boss slot, each per-day cell holding a boss icon available all day.
 */
function parseAbyss(
  $: cheerio.CheerioAPI,
  today: Temporal.PlainDate,
): AbyssSlot[] {
  const heading = $('#togabito');
  if (heading.length === 0) return [];
  const table = heading.nextAll('.tokoyami-box').first().find('table').first();
  const rows = table.find('tr');
  if (rows.length < 2) return [];

  const dates = headerDates($, rows.eq(0), today);
  const out: AbyssSlot[] = [];
  rows.slice(1).each((_, tr) => {
    $(tr)
      .find('td')
      .each((col, td) => {
        const src = $(td).find('img').attr('src');
        const date = dates[col];
        if (!src || !date) return;
        out.push({ date, iconUrl: iconUrl(src) });
      });
  });
  return out;
}

/** "6:00 ～ 6:59" → the slot's start hour/minute. */
function parseSlotStart(text: string): { hour: number; minute: number } | null {
  const m = text.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Full icon URL with any `?cache-buster` stripped, for a stable event key. */
function iconUrl(src: string): string {
  return src.split('?')[0];
}

/** Parse the date `<th>`s of a header row (skipping the leading label cell). */
function headerDates(
  $: cheerio.CheerioAPI,
  headerRow: cheerio.Cheerio<AnyNode>,
  today: Temporal.PlainDate,
): (Temporal.PlainDate | null)[] {
  const out: (Temporal.PlainDate | null)[] = [];
  headerRow
    .find('th')
    .slice(1)
    .each((_, th) => {
      out.push(parseMonthDay($(th).text(), today));
    });
  return out;
}

/** "07/11(土)" / "07/11（土）" → a PlainDate with the year inferred vs `today`. */
export function parseMonthDay(
  text: string,
  today: Temporal.PlainDate,
): Temporal.PlainDate | null {
  const m = text.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // The page only ever shows the current/near-future window. Pick the year that
  // lands the date closest to `today`, so a Dec page showing Jan rolls forward.
  let candidate = Temporal.PlainDate.from({ year: today.year, month, day });
  const daysFrom = (d: Temporal.PlainDate) =>
    d.since(today, { largestUnit: 'days' }).days;
  if (daysFrom(candidate) < -180) {
    candidate = candidate.add({ years: 1 });
  } else if (daysFrom(candidate) > 180) {
    candidate = candidate.subtract({ years: 1 });
  }
  return candidate;
}

/** Last path segment of an image src, minus any `?cache-buster`. */
function iconBasename(src: string | undefined): string {
  if (!src) return '';
  return src.split('/').pop()?.split('?')[0] ?? '';
}
