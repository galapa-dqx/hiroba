/**
 * Translations table schema.
 *
 * Uses a composite primary key (itemType, itemId, language, field) to support:
 * - Multiple content types (news, topics, events)
 * - Multiple languages per item
 * - Different translatable fields per item type
 *
 * Note: Concurrency is now handled by Durable Objects, not database locks.
 */

import { and, eq } from "drizzle-orm";
import {
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

import type { Database } from "../client";

export const translations = sqliteTable(
	"translations",
	{
		// Composite key components
		itemType: text("item_type").notNull(), // "news", "topic", or "event"
		itemId: text("item_id").notNull(), // FK to news_items.id, topics.id, or events.id
		language: text("language").notNull(), // e.g., "en"
		field: text("field").notNull(), // e.g., "title", "content"

		// Translated value
		value: text("value").notNull(),

		// Tracking
		translatedAt: integer("translated_at").notNull(), // Unix timestamp
		model: text("model"), // AI model used for translation (e.g., "gpt-4o")
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.itemType, table.itemId, table.language, table.field],
		}),
	}),
);

// Type exports
export type Translation = typeof translations.$inferSelect;
export type NewTranslation = typeof translations.$inferInsert;
export type ItemType = "news" | "topic" | "event";
export type TranslationField = "title" | "content";

/** Result for a single translated field */
export type FieldTranslation = {
	value: string;
	translatedAt: number;
	model: string | null;
};

/** Map of field name to translation result */
export type FieldTranslations = Partial<Record<string, FieldTranslation>>;

/**
 * Delete all translations for an item.
 */
export async function deleteTranslation(
	db: Database,
	itemId: string,
	language: string,
	itemType: ItemType = "news",
): Promise<boolean> {
	const result = await db
		.delete(translations)
		.where(
			and(
				eq(translations.itemType, itemType),
				eq(translations.itemId, itemId),
				eq(translations.language, language),
			),
		)
		.returning({ itemId: translations.itemId });

	return result.length > 0;
}
