/**
 * News items table - stores scraped news metadata and content.
 *
 * Supports two-phase scraping:
 * - Phase 1 (list scraping): Populates id, titleJa, category, publishedAt
 * - Phase 2 (body scraping): Populates contentJa on demand
 *
 * Note: Concurrency is now handled by Durable Objects, not database locks.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const newsItems = sqliteTable("news_items", {
	// Primary identifier - 32-char hex from source URL
	id: text("id").primaryKey(),

	// From list page (Phase 1)
	titleJa: text("title_ja").notNull(),
	category: text("category").notNull(), // news|event|update|maintenance
	publishedAt: integer("published_at").notNull(), // Unix timestamp

	// From detail page (Phase 2) - NULL if not yet fetched
	contentJa: text("content_ja"),

	// Body fetch tracking
	bodyFetchedAt: integer("body_fetched_at"), // Unix timestamp
});

// Type exports
export type NewsItem = typeof newsItems.$inferSelect;
export type NewNewsItem = typeof newsItems.$inferInsert;

/** Phase 1 (list scraping) fields only */
export type ListItem = Pick<NewsItem, "id" | "titleJa" | "category" | "publishedAt">;
