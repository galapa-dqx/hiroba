/**
 * Playguide body scraper — fetch a /sc/public/playguide/<slug> page and parse
 * its content into the @hiroba/richtext block tree (blocks_ja). Playguide bodies
 * are the same 2005-era markup as topics (`contentsTable*`, `playguide_img_*`,
 * `h2.iconTitle`), living in `#contentArea .cttBox`, so this reuses the topics
 * parser wholesale (`parseTopicBody`'s root chain already targets `.cttBox`).
 *
 * The playguide-specific concern is the title. Playguide pages carry three
 * heading candidates and none is universally best:
 *  - `h2.iconTitle` — the SPECIFIC page heading when present ("エリアの地図"),
 *    authoritative over anything a crawl anchor might have labelled the page.
 *  - `h2.tit_icon` — usually specific, but on sibling index pages it's a shared
 *    SECTION header ("基礎知識や操作方法"), worse than the crawl's curated label.
 *  - `h1#cttTitle` — the generic section label ("プレイガイド"), a last resort.
 * So we expose `specificTitle` (the iconTitle, or null) separately from a
 * self-contained `titleJa` fallback chain; the fetch-body step prefers
 * `specificTitle`, then the crawl-seeded anchor label, then this `titleJa`.
 */

import * as cheerio from 'cheerio';

import type { Block } from '@hiroba/richtext';
import { SCRAPE_CONFIG } from '@hiroba/shared';

import { parseTopicBody } from './topics-parser';

export type PlayguideBody = {
  /** Best self-contained title: iconTitle ?? tit_icon ?? #cttTitle ?? slug. */
  titleJa: string;
  /**
   * The specific in-page heading (`h2.iconTitle`) if present — authoritative
   * over a crawl-provided section label. null when the page has only a
   * shared/section heading, in which case the crawl anchor label wins.
   */
  specificTitle: string | null;
  blocks: Block[];
};

/** Fetch and parse the detail page for a playguide slug. */
export async function fetchPlayguideBody(slug: string): Promise<PlayguideBody> {
  const url = `${SCRAPE_CONFIG.baseUrl}${SCRAPE_CONFIG.playguideBasePath}${slug}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch playguide page ${slug}: ${response.status}`,
    );
  }

  return parsePlayguidePage(await response.text(), slug);
}

/**
 * Parse a playguide page's HTML into a title + block tree. `slug` is the final
 * title fallback when the page carries no usable heading.
 */
export function parsePlayguidePage(html: string, slug: string): PlayguideBody {
  const $ = cheerio.load(html);
  const iconTitle = $('.cttBox h2.iconTitle').first().text().trim();
  const titIcon = $('.cttBox h2.tit_icon').first().text().trim();
  const cttTitle = $('#cttTitle').first().text().trim();
  const specificTitle = iconTitle || null;
  const titleJa = iconTitle || titIcon || cttTitle || slug;
  const blocks = parseTopicBody(html);
  return { titleJa, specificTitle, blocks };
}
