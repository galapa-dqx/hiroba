/**
 * GET /api/news/:id - Get single news item with lazy body fetch
 */

import type { APIRoute } from "astro";
import { createDb, getNewsItem } from "@hiroba/db";
import type { NewsItemDO } from "../../../../types/do";

export const GET: APIRoute = async ({ locals, params }) => {
	const runtime = locals.runtime;
	const db = createDb(runtime.env.DB);
	const id = params.id!;

	const item = await getNewsItem(db, id);

	if (!item) {
		return new Response(JSON.stringify({ error: "Not found" }), {
			status: 404,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Lazy body fetch via DO if not yet fetched
	if (item.contentJa === null) {
		try {
			const doId = runtime.env.NEWS_ITEM_DO.idFromName(id);
			const stub = runtime.env.NEWS_ITEM_DO.get(doId) as unknown as NewsItemDO;
			const body = await stub.fetchBodyIfNeeded(id);
			if (body) {
				item.contentJa = body.contentJa;
			}
		} catch (error) {
			// Body fetch failed but we can still return metadata
			console.error(`Body fetch failed for ${id}:`, error);
		}
	}

	return new Response(JSON.stringify({ item }), {
		headers: { "Content-Type": "application/json" },
	});
};
