/**
 * Topics list scraper for DQX Hiroba.
 *
 * Unlike news (numeric category pages), topics are archived by calendar month
 * under `/sc/topics/backnumber/{YYYY}/{M}/`. The backnumber index page links to
 * every month; the current (not-yet-archived) month lives on `/sc/topics/`.
 *
 * Each listing entry is `<h2 class="iconTitle"><a href="…/detail/{id}/">TITLE
 * （YYYY/M/D）</a></h2>` — the published date is embedded in the title text
 * (format varies: full/half-width parens, a trailing `更新`, etc.), so we pull
 * the first `YYYY/M/D` we find and fall back to the month page's year/month.
 *
 * The title is stored verbatim (`.text().trim()`) to match what the body scraper
 * writes from the detail page's own `h2.iconTitle`, so re-upserts don't flip-flop.
 */

import * as cheerio from 'cheerio';
import { Temporal } from 'temporal-polyfill';

import { parseJstDate, SCRAPE_CONFIG } from '@hiroba/shared';

const BASE_URL = SCRAPE_CONFIG.baseUrl;

/** Current (not-yet-archived) topics listing. */
export const TOPICS_LIST_URL = `${BASE_URL}/sc/topics/`;
/** Backnumber index — links to every year/month archive page. */
export const TOPICS_BACKNUMBER_URL = `${BASE_URL}/sc/topics/backnumber/`;

const DETAIL_ID_RE = /\/sc\/topics\/detail\/([a-f0-9]{32})\//;
const MONTH_LINK_RE = /\/sc\/topics\/backnumber\/(\d{4})\/(\d{1,2})\//;
// First YYYY/M/D anywhere in the title (also matches YYYY年M月D日).
const TITLE_DATE_RE = /(\d{4})[/年](\d{1,2})[/月](\d{1,2})/;

/** A topic as seen on a listing page (Phase 1 metadata). */
export type TopicListItem = {
  id: string;
  titleJa: string;
  publishedAt: Temporal.Instant;
};

/** A backnumber month archive. */
export type TopicsMonth = {
  year: number;
  month: number;
  url: string;
};

/** A listing source to scrape (the current page, or one month archive). */
export type TopicsSource = {
  label: string;
  url: string;
  /** Month fallback for entries whose title has no embedded date. */
  fallback?: { year: number; month: number };
};

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

/**
 * Extract the published instant from a listing title. Anchored to midnight JST.
 * Falls back to the month page's year/month (day 1), else the current instant.
 */
function extractDateFromTitle(
  title: string,
  fallback?: { year: number; month: number },
): Temporal.Instant {
  const m = title.match(TITLE_DATE_RE);
  if (m) {
    const [, year, month, day] = m;
    return parseJstDate(
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    );
  }
  if (fallback) {
    return parseJstDate(
      `${fallback.year}-${String(fallback.month).padStart(2, '0')}-01`,
    );
  }
  return Temporal.Now.instant();
}

/**
 * Parse a topics listing page (the current `/sc/topics/` page or a backnumber
 * month page). Only `h2.iconTitle` headers are entries — detail links inside a
 * topic's body preview (cross-references to other topics) are ignored.
 */
export function parseTopicsListPage(
  html: string,
  fallback?: { year: number; month: number },
): TopicListItem[] {
  const $ = cheerio.load(html);
  const items: TopicListItem[] = [];
  const seen = new Set<string>();

  $('h2.iconTitle a[href*="/sc/topics/detail/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const idMatch = href.match(DETAIL_ID_RE);
    if (!idMatch) return;

    const id = idMatch[1];
    if (seen.has(id)) return;
    seen.add(id);

    const titleJa = $(el).text().trim();
    if (!titleJa) return;

    items.push({ id, titleJa, publishedAt: extractDateFromTitle(titleJa, fallback) });
  });

  return items;
}

/**
 * Fetch and parse a single listing page.
 */
export async function fetchTopicsListPage(
  url: string,
  fallback?: { year: number; month: number },
): Promise<TopicListItem[]> {
  return parseTopicsListPage(await fetchText(url), fallback);
}

/**
 * Fetch the backnumber index and return every month archive, newest first.
 */
export async function listBacknumberMonths(): Promise<TopicsMonth[]> {
  const $ = cheerio.load(await fetchText(TOPICS_BACKNUMBER_URL));
  const seen = new Set<string>();
  const months: TopicsMonth[] = [];

  $('a[href*="/sc/topics/backnumber/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(MONTH_LINK_RE);
    if (!m) return;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const key = `${year}-${month}`;
    if (seen.has(key)) return;
    seen.add(key);
    months.push({ year, month, url: `${BASE_URL}/sc/topics/backnumber/${year}/${month}/` });
  });

  months.sort((a, b) => b.year - a.year || b.month - a.month);
  return months;
}

/**
 * The full ordered list of sources to scrape for a complete backfill: the
 * current page first, then every backnumber month newest → oldest. Used by the
 * admin's batched backfill (slice by cursor).
 */
export async function listTopicsSources(): Promise<TopicsSource[]> {
  const months = await listBacknumberMonths();
  return [
    { label: 'current', url: TOPICS_LIST_URL },
    ...months.map((m) => ({
      label: `${m.year}/${m.month}`,
      url: m.url,
      fallback: { year: m.year, month: m.month },
    })),
  ];
}

/**
 * Async iterator yielding topic listing pages, newest first. Yields the current
 * page, then (unless `incremental`) each backnumber month. Callers can break
 * early once they stop seeing new items.
 */
export async function* scrapeTopicsList(
  opts: { incremental?: boolean } = {},
): AsyncGenerator<TopicListItem[], void, unknown> {
  yield await fetchTopicsListPage(TOPICS_LIST_URL);
  if (opts.incremental) return;

  for (const m of await listBacknumberMonths()) {
    yield await fetchTopicsListPage(m.url, { year: m.year, month: m.month });
  }
}

/**
 * Convenience: scrape the entire topics corpus into one array (dedup by id).
 */
export async function scrapeAllTopics(): Promise<TopicListItem[]> {
  const byId = new Map<string, TopicListItem>();
  for await (const page of scrapeTopicsList()) {
    for (const item of page) if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}
