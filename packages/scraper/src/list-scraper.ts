/**
 * Async iterator-based list scraper for DQX Hiroba news.
 *
 * Yields news items page by page, allowing callers to break early
 * when hitting known items (incremental scraping mode).
 */

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

import type { ListItem } from '@hiroba/db';
import {
  CATEGORIES,
  parseJstDate,
  SCRAPE_CONFIG,
  type Category,
} from '@hiroba/shared';

export type { ListItem };

const BASE_URL = SCRAPE_CONFIG.baseUrl;

/**
 * Map Category strings to numeric IDs used in the website URLs.
 */
export const CATEGORY_TO_ID: Record<Category, number> = {
  news: 0,
  event: 1,
  update: 2,
  maintenance: 3,
};

/**
 * Extract date from the same table row as the link.
 * Structure: <tr><td class="news"><a>...</a></td><td class="date"><div>DATE</div></td></tr>
 */
function extractDateNearElement(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<AnyNode>,
): string {
  // The link is inside td.news, look for sibling td.date in same row
  const parentTd = element.closest('td');
  if (parentTd.length) {
    const dateTd = parentTd.siblings('td.date').first();
    if (dateTd.length) {
      const text = dateTd.text().trim();
      const match = text.match(/(\d{4}[-/]\d{2}[-/]\d{2}(?:\s+\d{2}:\d{2})?)/);
      if (match) return match[1];
    }
  }

  // Fallback: look for date pattern in the row
  const row = element.closest('tr');
  if (row.length) {
    const text = row.text();
    const match = text.match(/(\d{4}[-/]\d{2}[-/]\d{2}(?:\s+\d{2}:\d{2})?)/);
    if (match) return match[1];
  }

  return '';
}

/**
 * Extract the total number of DISPLAY pages from the pagination.
 *
 * Hiroba's URL path segment is 0-based relative to the 1-based display page
 * (`/sc/news/category/3/1` serves display page 2 — see `listPageUrl`), so
 * every `<a>` suffix advertises `displayPage - 1` and must be counted +1.
 * The current page renders as an unlinked `<li class="location">N</li>`
 * (display-numbered), never as a self-referencing link — without counting it,
 * the genuine last page under-reports its own total by one. An out-of-range
 * request is CLAMPED to the last page's content rendered with NO location
 * marker and a link window that includes the true last page, so a clamped
 * page still advertises the correct total — which is exactly what lets a
 * caller detect the overrun (`requestedPage > totalPages`).
 */
export function extractTotalPages($: cheerio.CheerioAPI): number {
  let maxPage = 1;

  // Numbered/first/prev/next/last links: URL suffix + 1 = display page.
  $("a[href*='/sc/news/category/']").each((_, elem) => {
    const href = $(elem).attr('href') || '';
    const match = href.match(/\/sc\/news\/category\/\d+\/(\d+)/);
    if (match) {
      maxPage = Math.max(maxPage, parseInt(match[1]) + 1);
    }
  });

  // The unlinked current-page marker — the only place the genuine last page
  // states its own number.
  $('.pageNavi li.location').each((_, elem) => {
    const num = parseInt($(elem).text().trim());
    if (!Number.isNaN(num)) {
      maxPage = Math.max(maxPage, num);
    }
  });

  return maxPage;
}

/**
 * URL for one DISPLAY page (1-based) of a category listing. The site's path
 * segment is 0-based: display page 1 is the bare category URL and display
 * page N is `/<categoryId>/<N-1>`. (The previous `/<N>` mapping silently
 * skipped display page 2 — items 51–100 — of every category.)
 */
export function listPageUrl(category: Category, page: number): string {
  const base = `${BASE_URL}/sc/news/category/${CATEGORY_TO_ID[category]}`;
  return page > 1 ? `${base}/${page - 1}` : base;
}

/**
 * Parse a list page HTML and extract news items.
 */
export function parseListPage(html: string, category: Category): ListItem[] {
  const $ = cheerio.load(html);
  const items: ListItem[] = [];
  const seenIds = new Set<string>();

  // Find all news links
  $("a[href*='/sc/news/detail/']").each((_, elem) => {
    const link = $(elem);
    const href = link.attr('href') || '';
    const match = href.match(/\/sc\/news\/detail\/([^/]+)\/?/);
    if (!match) return;

    const newsId = match[1];

    // Skip duplicates
    if (seenIds.has(newsId)) return;
    seenIds.add(newsId);

    const title = link.text().trim();

    // Skip empty titles or navigation links
    if (!title || title === '詳細' || title === 'もっと見る') return;

    const dateStr = extractDateNearElement($, link);

    items.push({
      id: newsId,
      titleJa: title,
      category,
      publishedAt: parseJstDate(dateStr),
    });
  });

  return items;
}

/**
 * Fetch a single list page for a category, returning its items and the total
 * page count parsed from the pagination. Exported so a workflow can page the
 * archive one durable step at a time (each step is a fresh subrequest budget).
 */
export async function fetchNewsListPage(
  category: Category,
  page: number,
): Promise<{ items: ListItem[]; totalPages: number }> {
  const response = await fetch(listPageUrl(category, page), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch list page: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  return {
    items: parseListPage(html, category),
    totalPages: extractTotalPages($),
  };
}

/**
 * Async iterator that yields news items page by page.
 * Caller can break early when hitting known items (incremental mode).
 */
export async function* scrapeNewsList(
  category: Category,
): AsyncGenerator<ListItem[], void, unknown> {
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const result = await fetchNewsListPage(category, page);

    if (result.items.length === 0) break;

    totalPages = result.totalPages;
    yield result.items;

    page++;
  }
}

/**
 * Scrape a single category and return all items.
 * Convenience function for full scrapes.
 */
export async function scrapeCategory(category: Category): Promise<ListItem[]> {
  const allItems: ListItem[] = [];

  for await (const items of scrapeNewsList(category)) {
    allItems.push(...items);
  }

  return allItems;
}

/**
 * Get all available categories.
 */
export function getAllCategories(): readonly Category[] {
  return CATEGORIES;
}
