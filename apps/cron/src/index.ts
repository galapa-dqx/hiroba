/**
 * Cron-only Cloudflare Worker for scheduled news and glossary refresh.
 *
 * No HTTP endpoints - all API routes are now served by apps/web.
 * Also hosts the NewsItemDO Durable Object for coordinating news operations.
 */

import { sql } from "drizzle-orm";

import { createDb, glossary, upsertListItems, type Database } from "@hiroba/db";
import { fetchGlossary, scrapeNewsList } from "@hiroba/scraper";
import { CATEGORIES } from "@hiroba/shared";

// Export the Durable Object class
export { NewsItemDO } from "./news-item-do";

type Bindings = {
	DB: D1Database;
	NEWS_ITEM_DO: DurableObjectNamespace;
};

export default {
	/**
	 * No HTTP routes - redirect any requests to the main web app.
	 */
	async fetch(): Promise<Response> {
		return new Response(
			"This worker handles cron jobs only. API is at hiroba.dqx.tools",
			{
				status: 404,
			},
		);
	},

	/**
	 * Handle scheduled cron jobs.
	 *
	 * Triggers:
	 * - "0 * * * *" = Hourly news refresh (first page of each category)
	 * - "0 15 * * *" = Daily glossary refresh (midnight JST)
	 */
	async scheduled(
		controller: ScheduledController,
		env: Bindings,
		_ctx: ExecutionContext,
	): Promise<void> {
		const db = createDb(env.DB);

		const isGlossaryRefresh = controller.cron === "0 15 * * *";

		if (isGlossaryRefresh) {
			await refreshGlossary(db);
		} else {
			await refreshNews(db);
		}
	},
};

/**
 * Refresh glossary from GitHub CSV.
 */
async function refreshGlossary(db: Database): Promise<void> {
	try {
		const entries = await fetchGlossary();
		const now = Math.floor(Date.now() / 1000);

		// Clear existing glossary and insert new entries
		await db.delete(glossary);

		// Insert in batches
		const BATCH_SIZE = 25;
		let inserted = 0;

		for (let i = 0; i < entries.length; i += BATCH_SIZE) {
			const batch = entries.slice(i, i + BATCH_SIZE);

			await db
				.insert(glossary)
				.values(
					batch.map((e) => ({
						sourceText: e.japanese_text,
						targetLanguage: "en",
						translatedText: e.english_text,
						updatedAt: now,
					})),
				)
				.onConflictDoUpdate({
					target: [glossary.sourceText, glossary.targetLanguage],
					set: {
						translatedText: sql`excluded.translated_text`,
						updatedAt: sql`excluded.updated_at`,
					},
				});

			inserted += batch.length;
		}

		console.log(`Glossary refresh complete: ${inserted} entries loaded`);
	} catch (error) {
		console.error("Glossary refresh failed:", error);
	}
}

/**
 * Refresh news by scraping first page of each category.
 */
async function refreshNews(db: Database): Promise<void> {
	let totalNew = 0;
	let errors = 0;

	for (const category of CATEGORIES) {
		try {
			// Scrape first page only for scheduled refresh
			for await (const items of scrapeNewsList(category)) {
				const inserted = await upsertListItems(db, items);
				totalNew += inserted.length;
				// Only scrape first page in scheduled job
				break;
			}
		} catch (error) {
			console.error(`Failed to scrape ${category}:`, error);
			errors++;
		}
	}

	console.log(
		`Scheduled refresh complete: ${totalNew} new items, ${errors} errors`,
	);
}
