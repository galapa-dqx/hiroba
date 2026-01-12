/**
 * Translations table and AI translation service.
 *
 * Uses a composite primary key (itemType, itemId, language) to support:
 * - Multiple content types (news, topics in future)
 * - Multiple languages per item
 *
 * Includes single-flight concurrency control to prevent duplicate
 * translation API calls when multiple workers request the same translation.
 */

import {
	sqliteTable,
	text,
	integer,
	primaryKey,
} from "drizzle-orm/sqlite-core";
import { eq, and, or, lt, isNull } from "drizzle-orm";
import type { Database } from "../client";
import { findMatchingGlossaryEntries } from "./glossary";
import { LOCK_CONFIG, isTranslationStale, translateWithAI } from "@hiroba/shared";

export const translations = sqliteTable(
	"translations",
	{
		// Composite key components
		itemType: text("item_type").notNull(), // "news" or "topic"
		itemId: text("item_id").notNull(), // FK to news_items.id or topics.id
		language: text("language").notNull(), // e.g., "en"

		// Translated content
		title: text("title").notNull(),
		content: text("content").notNull(),

		// Tracking
		translatedAt: integer("translated_at").notNull(), // Unix timestamp
		model: text("model"), // AI model used for translation (e.g., "gpt-4o")

		// Concurrency lock for translation-in-progress
		translatingSince: integer("translating_since"), // Unix timestamp
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.itemType, table.itemId, table.language],
		}),
	}),
);

// Type exports
export type Translation = typeof translations.$inferSelect;
export type NewTranslation = typeof translations.$inferInsert;

export type TranslationResult = Pick<Translation, "title" | "content" | "translatedAt" | "model">;

/**
 * Get or create translation for a news item.
 * Uses single-flight pattern to prevent concurrent translations.
 */
export async function getOrCreateTranslation(
	db: Database,
	itemId: string,
	itemType: "news" | "topic",
	language: string,
	sourceTitle: string,
	sourceContent: string,
	publishedAt: number,
	aiApiKey: string,
): Promise<TranslationResult> {
	// Check for existing translation
	const existing = await db
		.select()
		.from(translations)
		.where(
			and(
				eq(translations.itemType, itemType),
				eq(translations.itemId, itemId),
				eq(translations.language, language),
			),
		)
		.get();

	// If exists and not stale, return it
	if (existing && !isTranslationStale(publishedAt, existing.translatedAt)) {
		return {
			title: existing.title,
			content: existing.content,
			translatedAt: existing.translatedAt,
			model: existing.model,
		};
	}

	// Try to claim the translation lock
	const now = Math.floor(Date.now() / 1000);
	const staleThreshold = now - Math.floor(LOCK_CONFIG.translationStaleThreshold / 1000);

	const claimed = await tryClaimTranslationLock(
		db,
		itemId,
		itemType,
		language,
		now,
		staleThreshold,
		existing !== undefined,
	);

	if (claimed) {
		try {
			// Find glossary entries that appear in the source text
			const combinedSource = `${sourceTitle} ${sourceContent}`;
			const glossaryTerms = await findMatchingGlossaryEntries(db, combinedSource, language);

			// Do AI translation
			const translated = await translateWithAI(
				sourceTitle,
				sourceContent,
				language,
				glossaryTerms,
				aiApiKey,
			);

			// Save translation
			await db
				.insert(translations)
				.values({
					itemType,
					itemId,
					language,
					title: translated.title,
					content: translated.content,
					translatedAt: now,
					model: translated.model,
					translatingSince: null,
				})
				.onConflictDoUpdate({
					target: [translations.itemType, translations.itemId, translations.language],
					set: {
						title: translated.title,
						content: translated.content,
						translatedAt: now,
						model: translated.model,
						translatingSince: null,
					},
				});

			return { ...translated, translatedAt: now };
		} catch (error) {
			// Release lock on error
			await releaseTranslationLock(db, itemId, itemType, language);
			throw error;
		}
	}

	// Someone else is translating, poll until done
	return pollForTranslation(db, itemId, itemType, language);
}

/**
 * Delete a translation for an item.
 */
export async function deleteTranslation(
	db: Database,
	itemId: string,
	language: string,
	itemType: "news" | "topic" = "news",
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

/**
 * Try to claim the translation lock using atomic update.
 */
async function tryClaimTranslationLock(
	db: Database,
	itemId: string,
	itemType: string,
	language: string,
	now: number,
	staleThreshold: number,
	exists: boolean,
): Promise<boolean> {
	if (exists) {
		// Update existing record to claim lock
		const result = await db
			.update(translations)
			.set({ translatingSince: now })
			.where(
				and(
					eq(translations.itemType, itemType),
					eq(translations.itemId, itemId),
					eq(translations.language, language),
					or(
						isNull(translations.translatingSince),
						lt(translations.translatingSince, staleThreshold),
					),
				),
			)
			.returning({ itemId: translations.itemId });

		return result.length > 0;
	} else {
		// Insert new record with lock
		try {
			await db.insert(translations).values({
				itemType,
				itemId,
				language,
				title: "",
				content: "",
				translatedAt: 0,
				translatingSince: now,
			});
			return true;
		} catch {
			// Conflict - someone else inserted first
			return false;
		}
	}
}

/**
 * Release translation lock on error.
 */
async function releaseTranslationLock(
	db: Database,
	itemId: string,
	itemType: string,
	language: string,
): Promise<void> {
	await db
		.update(translations)
		.set({ translatingSince: null })
		.where(
			and(
				eq(translations.itemType, itemType),
				eq(translations.itemId, itemId),
				eq(translations.language, language),
			),
		);
}

/**
 * Poll database waiting for another worker to complete translation.
 */
async function pollForTranslation(
	db: Database,
	itemId: string,
	itemType: string,
	language: string,
): Promise<TranslationResult> {
	const maxWait = LOCK_CONFIG.translationMaxWait;
	const pollInterval = LOCK_CONFIG.translationPollInterval;
	const startTime = Date.now();

	while (Date.now() - startTime < maxWait) {
		await sleep(pollInterval);

		const result = await db
			.select()
			.from(translations)
			.where(
				and(
					eq(translations.itemType, itemType),
					eq(translations.itemId, itemId),
					eq(translations.language, language),
				),
			)
			.get();

		// Translation is complete (has content and lock released)
		if (result && result.content && result.translatingSince === null) {
			return {
				title: result.title,
				content: result.content,
				translatedAt: result.translatedAt,
				model: result.model,
			};
		}
	}

	throw new Error("Timeout waiting for translation");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
