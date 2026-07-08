/**
 * Topics body scraper — fetch a topic detail page and parse it into the
 * @hiroba/richtext block tree (blocks_ja). Mirrors body-scraper.ts (news), but
 * topics are rich text, so we keep structure via parseTopicBody.
 */

import * as cheerio from 'cheerio';

import type { Block } from '@hiroba/richtext';
import { SCRAPE_CONFIG } from '@hiroba/shared';

import { stripTitleDateSuffix } from './topics-list-scraper';
import { parseTopicBody } from './topics-parser';

export type TopicBody = {
  titleJa: string;
  blocks: Block[];
};

/** Fetch and parse the detail page for a topic. */
export async function fetchTopicBody(id: string): Promise<TopicBody> {
  const url = `${SCRAPE_CONFIG.baseUrl}${SCRAPE_CONFIG.topicsDetailPath}${id}/`;

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch topic detail page ${id}: ${response.status}`,
    );
  }

  return parseTopicPage(await response.text());
}

/**
 * Parse a topic detail page's HTML into a title + block tree. The title gets
 * the same posting-date strip as the list scraper, so a detail-page re-upsert
 * never flip-flops the stored title back to the dated form.
 */
export function parseTopicPage(html: string): TopicBody {
  const $ = cheerio.load(html);
  const titleJa = stripTitleDateSuffix($('h2.iconTitle').first().text().trim());
  const blocks = parseTopicBody(html);
  return { titleJa, blocks };
}
