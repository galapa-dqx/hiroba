/**
 * GET /api/news - List news items (for admin preview)
 */
import type { APIRoute } from "astro";

import { createDb, getNewsItems } from "@hiroba/db";
import type { Category } from "@hiroba/shared";

export const GET: APIRoute = async ({ locals, url }) => {
	const runtime = locals.runtime;
	const db = createDb(runtime.env.DB);

	const category = url.searchParams.get("category") as Category | null;
	const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);

	const result = await getNewsItems(db, {
		category: category || undefined,
		limit,
	});

	return new Response(JSON.stringify(result), {
		headers: { "Content-Type": "application/json" },
	});
};
