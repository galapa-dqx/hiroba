/**
 * Body scraper for news detail pages.
 *
 * A news body is a strict subset of the topics rich-text model — paragraphs,
 * line breaks, and links (sqex.to shortlinks) — so we parse it with the topics
 * parser pointed at `div.newsContent`. This preserves the `<a>` links the old
 * plaintext conversion destroyed (see DQX-9); fetching is driven by the workflow.
 */

import { load } from 'cheerio';
import type { Element } from 'domhandler';

import type { Block } from '@hiroba/richtext';
import { SCRAPE_CONFIG } from '@hiroba/shared';

import { parseTopicContent } from './topics-parser';

/**
 * Parse a news detail page's HTML into the @hiroba/richtext block tree, targeting
 * the `div.newsContent` body container.
 */
export function parseNewsBody(html: string): Block[] {
  const $ = load(html);
  const root = $('div.newsContent')[0] as Element | undefined;
  if (!root) return [];
  return parseTopicContent($, root);
}

/**
 * Fetch and parse the detail page for a news item into a block tree.
 */
export async function fetchNewsBody(id: string): Promise<Block[]> {
  const url = `${SCRAPE_CONFIG.baseUrl}${SCRAPE_CONFIG.newsDetailPath}${id}/`;

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch detail page: ${response.status}`);
  }

  return parseNewsBody(await response.text());
}
