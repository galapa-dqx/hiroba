/**
 * Body scraper for fetching news detail page content.
 */

import * as cheerio from 'cheerio';

import { SCRAPE_CONFIG } from '@hiroba/shared';

export type BodyContent = {
  contentJa: string;
};

/**
 * Fetch and parse the detail page for a news item.
 */
export async function fetchNewsBody(id: string): Promise<BodyContent> {
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

  const html = await response.text();
  return parseDetailPage(html);
}

/**
 * Extract the main content from a detail page.
 */
function parseDetailPage(html: string): BodyContent {
  const $ = cheerio.load(html);

  // Extract content from div.newsContent
  const contentElem = $('div.newsContent');
  let contentJa = '';
  if (contentElem.length) {
    // Get text content, preserving some structure
    contentJa = contentElem
      .html()!
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return { contentJa };
}
