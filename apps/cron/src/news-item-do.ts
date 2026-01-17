/**
 * NewsItemDO - Durable Object for coordinating news item operations.
 *
 * Provides single-threaded execution for body fetching and translation,
 * eliminating the need for database locks. Each news item has its own
 * DO instance, identified by the item ID.
 *
 * D1 remains the source of truth - the DO only coordinates operations.
 */

import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
	createDb,
	newsItems,
	translations,
	findMatchingGlossaryEntries,
	type Database,
	type FieldTranslations,
	type ItemType,
} from "@hiroba/db";
import { isTranslationStale, translateWithAI } from "@hiroba/shared";
import { fetchNewsBody, type BodyContent } from "@hiroba/scraper";

export interface Env {
	DB: D1Database;
	OPENAI_API_KEY: string;
}

export class NewsItemDO extends DurableObject<Env> {
	/**
	 * Fetch body content if not already cached.
	 *
	 * DO serialization ensures only one fetch happens at a time per item.
	 */
	async fetchBodyIfNeeded(itemId: string): Promise<BodyContent | null> {
		const db = createDb(this.env.DB);

		// Check current state
		const item = await db
			.select({
				contentJa: newsItems.contentJa,
			})
			.from(newsItems)
			.where(eq(newsItems.id, itemId))
			.get();

		if (!item) return null;

		// If body exists, return it
		if (item.contentJa !== null) {
			return { contentJa: item.contentJa };
		}

		// Fetch the body (no lock needed - DO guarantees serialization)
		const now = Math.floor(Date.now() / 1000);
		const body = await fetchNewsBody(itemId);

		// Save to D1
		await db
			.update(newsItems)
			.set({
				contentJa: body.contentJa,
				bodyFetchedAt: now,
			})
			.where(eq(newsItems.id, itemId));

		return body;
	}

	/**
	 * Get or create translations for an item's fields.
	 *
	 * DO serialization ensures only one translation happens at a time per item.
	 */
	async translateFields(
		itemId: string,
		itemType: ItemType,
		language: string,
		sourceFields: Record<string, string>,
		publishedAt: number,
	): Promise<FieldTranslations> {
		const db = createDb(this.env.DB);
		const fieldNames = Object.keys(sourceFields);

		if (fieldNames.length === 0) {
			return {};
		}

		// Check for existing translations
		const existing = await db
			.select()
			.from(translations)
			.where(eq(translations.itemType, itemType))
			.all()
			.then((rows) =>
				rows.filter(
					(r) =>
						r.itemId === itemId &&
						r.language === language &&
						fieldNames.includes(r.field),
				),
			);

		// Build map of existing translations
		const existingByField = new Map(existing.map((t) => [t.field, t]));

		// Find fields that need translation (missing or stale)
		const fieldsToTranslate: string[] = [];
		const result: FieldTranslations = {};

		for (const field of fieldNames) {
			const ex = existingByField.get(field);
			if (ex && !isTranslationStale(publishedAt, ex.translatedAt)) {
				// Use existing translation
				result[field] = {
					value: ex.value,
					translatedAt: ex.translatedAt,
					model: ex.model,
				};
			} else {
				fieldsToTranslate.push(field);
			}
		}

		// If all fields are cached and fresh, return early
		if (fieldsToTranslate.length === 0) {
			return result;
		}

		// Translate the missing fields (no lock needed - DO guarantees serialization)
		const now = Math.floor(Date.now() / 1000);

		// Build source text for glossary matching
		const combinedSource = Object.values(sourceFields).join(" ");
		const glossaryTerms = await findMatchingGlossaryEntries(
			db,
			combinedSource,
			language,
		);

		// Build map of fields to translate
		const fieldsForAI: Record<string, string> = {};
		for (const field of fieldsToTranslate) {
			fieldsForAI[field] = sourceFields[field];
		}

		// Do AI translation
		const translated = await translateWithAI(
			fieldsForAI,
			language,
			glossaryTerms,
			this.env.OPENAI_API_KEY,
		);

		// Save all translated fields to D1
		for (const field of fieldsToTranslate) {
			const value = translated.fields[field] ?? sourceFields[field];
			await db
				.insert(translations)
				.values({
					itemType,
					itemId,
					language,
					field,
					value,
					translatedAt: now,
					model: translated.model,
				})
				.onConflictDoUpdate({
					target: [
						translations.itemType,
						translations.itemId,
						translations.language,
						translations.field,
					],
					set: {
						value,
						translatedAt: now,
						model: translated.model,
					},
				});

			result[field] = {
				value,
				translatedAt: now,
				model: translated.model,
			};
		}

		return result;
	}
}
