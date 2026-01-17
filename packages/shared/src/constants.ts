/**
 * Shared constants for the Hiroba news translation system.
 */

// News categories
export const CATEGORIES = ['news', 'event', 'update', 'maintenance'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Maps Japanese category names to English slugs.
 * Used when parsing scraped content.
 */
export const CATEGORY_MAP: Record<string, Category> = {
  ニュース: 'news',
  イベント: 'event',
  アップデート: 'update',
  メンテナンス: 'maintenance',
  障害: 'maintenance',
};

/**
 * Human-readable labels for categories.
 * Used in UI display.
 */
export const CATEGORY_LABELS: Record<Category, string> = {
  news: 'News',
  event: 'Events',
  update: 'Updates',
  maintenance: 'Maintenance',
};

/**
 * Scraping configuration - source URLs and paths.
 */
export const SCRAPE_CONFIG = {
  baseUrl: 'https://hiroba.dqx.jp',
  newsListPath: '/sc/news/',
  newsDetailPath: '/sc/news/detail/',
  topicsDetailPath: '/sc/topics/detail/',
} as const;
