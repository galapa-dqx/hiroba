/**
 * Rotation banner scraper for DQX Hiroba.
 *
 * The home page's promotional carousel lives at `/sc/rotationbanner` as a
 * `<div id="topBanner">` of `<li class="slide">` entries, each a linked banner
 * image:
 *
 *   <li class="slide"><a href="javascript:ctrLinkAction('link=<URL>');">
 *     <img src="…/rotationbanner/banner_rotation_<date>_<n>.jpg" alt="<caption>" />
 *   </a></li>
 *
 * The click target is buried in the `ctrLinkAction('link=…')` href (an ad-click
 * tracker); almost always a `/sc/topics/detail/<id>/` page. We return the raw
 * image src, the resolved link, the topic id when the link is a topic, and the
 * caption — in rotation order. Computing the mirror `imageKey` is left to the
 * caller (it owns the @hiroba/richtext dependency).
 */

import * as cheerio from 'cheerio';
import { type Temporal } from 'temporal-polyfill';

import { parseJstDate, SCRAPE_CONFIG } from '@hiroba/shared';

const BASE_URL = SCRAPE_CONFIG.baseUrl;

/** The rotation banner page. */
export const ROTATION_BANNER_URL = `${BASE_URL}/sc/rotationbanner/`;

// The click URL inside `ctrLinkAction('link=<URL>')` — up to the closing quote.
const LINK_RE = /link=([^'")]+)/;
const TOPIC_ID_RE = /\/sc\/topics\/detail\/([a-f0-9]{32})\//;
// The date the banner filename encodes: `banner_rotation_YYYYMMDD_NNN.jpg`.
const FILENAME_DATE_RE = /banner_rotation_(\d{4})(\d{2})(\d{2})_/;

/** A banner as seen on the rotation page, in rotation order. */
export type RotationBannerItem = {
  /** Raw upstream image URL (a `banner_rotation_*.jpg`). */
  imageSrc: string;
  /** Resolved click target, or null when unparseable. */
  linkUrl: string | null;
  /** The 32-char topic id when the link points at a topic detail page. */
  linkTopicId: string | null;
  /** Japanese caption from the `<img alt>`. */
  altJa: string;
  /** 0-based position in the (stable, editorial) rotation order. */
  order: number;
  /** Posting date parsed from the filename (midnight JST); null if unparseable. */
  publishedAt: Temporal.Instant | null;
};

/** Parse the posting date a `banner_rotation_YYYYMMDD_NNN` filename encodes. */
function publishedAtFromSrc(src: string): Temporal.Instant | null {
  const m = src.match(FILENAME_DATE_RE);
  return m ? parseJstDate(`${m[1]}-${m[2]}-${m[3]}`) : null;
}

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

/** Parse the rotation banner page markup into ordered, deduped banner items. */
export function parseRotationBanners(html: string): RotationBannerItem[] {
  const $ = cheerio.load(html);
  const items: RotationBannerItem[] = [];
  const seen = new Set<string>();

  $('#topBanner li.slide').each((_, el) => {
    const imageSrc = $(el).find('img').first().attr('src')?.trim();
    // Carousels often clone slides for looping — dedupe by image.
    if (!imageSrc || seen.has(imageSrc)) return;
    seen.add(imageSrc);

    const href = $(el).find('a').first().attr('href') ?? '';
    const linkMatch = href.match(LINK_RE);
    const linkUrl = linkMatch ? decodeURIComponent(linkMatch[1]) : null;
    const topicMatch = linkUrl?.match(TOPIC_ID_RE);

    items.push({
      imageSrc,
      linkUrl,
      linkTopicId: topicMatch ? topicMatch[1] : null,
      altJa: $(el).find('img').first().attr('alt')?.trim() ?? '',
      order: items.length,
      publishedAt: publishedAtFromSrc(imageSrc),
    });
  });

  return items;
}

/** Fetch and parse the current rotation banners, in rotation order. */
export async function fetchRotationBanners(): Promise<RotationBannerItem[]> {
  return parseRotationBanners(await fetchText(ROTATION_BANNER_URL));
}
