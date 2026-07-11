/**
 * Playguide crawl scraper — discovers the playguide page set by breadth-first
 * crawling from the `guide01` hub, following every `/sc/public/playguide/<slug>`
 * link. Playguides have no list/archive page (unlike news categories or topics
 * backnumbers), so the link graph itself is the index.
 *
 * The crawl is bounded (a visited set + a `maxPages` cap) and stays on the
 * playguide path prefix. Each page's provisional `titleJa` is the anchor text of
 * the first link that discovered it (the hub's curated labels — "利用料金",
 * "エテーネの村のおはなし"); a page reached only by an image/empty link, or the
 * seed itself, falls back to the page's own heading once fetched. The body
 * scraper later refines the title with the page's specific `h2.iconTitle`.
 *
 * `sortOrder` is the discovery order, giving lists a stable, hub-first sequence.
 */

import * as cheerio from 'cheerio';

import { SCRAPE_CONFIG } from '@hiroba/shared';

const BASE_URL = SCRAPE_CONFIG.baseUrl;
const PLAYGUIDE_PATH = SCRAPE_CONFIG.playguideBasePath;

/** The root the crawl starts from — the playguide hub. */
export const PLAYGUIDE_SEED_SLUG = 'guide01';

/** Safety cap on how many pages one crawl visits (the guide is ~100–150 pages). */
const DEFAULT_MAX_PAGES = 250;

// A playguide URL's slug: letters/digits/underscore after the path prefix. Kept
// in sync with the `playguides` id CHECK (lowercased, length ≤ 64).
const SLUG_RE = /\/sc\/public\/playguide\/([A-Za-z0-9_]+)/;

/** A playguide discovered by the crawl (Phase-1 metadata). */
export type PlayguideCrawlItem = {
  slug: string;
  titleJa: string;
  sortOrder: number;
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

/** The absolute detail URL for a slug. */
export function playguideUrl(slug: string): string {
  return `${BASE_URL}${PLAYGUIDE_PATH}${slug}`;
}

/** Normalize an href to a playguide slug, or null if it isn't one. */
function slugFromHref(href: string): string | null {
  const m = SLUG_RE.exec(href);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  return slug.length >= 1 && slug.length <= 64 ? slug : null;
}

/**
 * Extract every `(slug, anchorText)` playguide link on a page, in document
 * order, deduped by slug (first anchor wins). Anchor text is collapsed
 * whitespace; empty when the link wraps only an image.
 */
export function parsePlayguideLinks(
  html: string,
): Array<{ slug: string; title: string }> {
  const $ = cheerio.load(html);
  const out: Array<{ slug: string; title: string }> = [];
  const seen = new Set<string>();

  $('a[href*="/sc/public/playguide/"]').each((_, el) => {
    const slug = slugFromHref($(el).attr('href') ?? '');
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    out.push({ slug, title: $(el).text().replace(/\s+/g, ' ').trim() });
  });

  return out;
}

/** The page's own heading, for pages reached without a usable anchor label. */
function ownTitle($: cheerio.CheerioAPI, slug: string): string {
  return (
    $('.cttBox h2.iconTitle').first().text().trim() ||
    $('.cttBox h2.tit_icon').first().text().trim() ||
    $('#cttTitle').first().text().trim() ||
    slug
  );
}

/**
 * Crawl the playguide tree from `guide01`, returning every discovered page with
 * a provisional title and its crawl order. Best-effort per page: a page that
 * fails to fetch is skipped (its links just aren't followed), never aborting the
 * whole crawl.
 */
export async function crawlPlayguides(
  opts: { maxPages?: number; seed?: string } = {},
): Promise<PlayguideCrawlItem[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const seed = opts.seed ?? PLAYGUIDE_SEED_SLUG;

  // slug → item; the seed has no discovering anchor (title filled from its page).
  const found = new Map<string, PlayguideCrawlItem>();
  const queue: string[] = [seed];
  found.set(seed, { slug: seed, titleJa: seed, sortOrder: 0 });
  let order = 1;

  while (queue.length > 0) {
    const slug = queue.shift()!;
    let html: string;
    try {
      html = await fetchText(playguideUrl(slug));
    } catch {
      continue; // unreachable page — skip, keep crawling the rest
    }
    const $ = cheerio.load(html);

    // Upgrade this page's title from its own heading when the discovering anchor
    // gave nothing better than the slug (covers the seed and image-only links).
    const entry = found.get(slug)!;
    if (entry.titleJa === slug) entry.titleJa = ownTitle($, slug);

    for (const { slug: child, title } of parsePlayguideLinks(html)) {
      if (found.has(child)) continue;
      if (found.size >= maxPages) return orderedItems(found);
      found.set(child, {
        slug: child,
        titleJa: title || child,
        sortOrder: order++,
      });
      queue.push(child);
    }
  }

  return orderedItems(found);
}

function orderedItems(
  found: Map<string, PlayguideCrawlItem>,
): PlayguideCrawlItem[] {
  return [...found.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}
