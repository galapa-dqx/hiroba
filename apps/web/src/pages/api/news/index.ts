/**
 * GET /api/news - List news items with pagination and filtering
 *
 * Query params:
 * - category: Filter by category (news|event|update|maintenance)
 * - limit: Number of items (default 20, max 100)
 * - cursor: Pagination cursor (publishedAt timestamp)
 */

import type { APIRoute } from "astro";

import { createDb, getNewsItems } from "@hiroba/db";
import type { Category } from "@hiroba/shared";

export const GET: APIRoute = async ({ locals, url }) => {
	const runtime = locals.runtime;
	const db = createDb(runtime.env.DB);

	const category = url.searchParams.get("category") as Category | undefined;
	const limitParam = url.searchParams.get("limit");
	const cursor = url.searchParams.get("cursor") ?? undefined;

	const limit = Math.min(limitParam ? parseInt(limitParam, 10) : 20, 100);

	// Validate category if provided
	const validCategories = ["news", "event", "update", "maintenance"];
	if (category && !validCategories.includes(category)) {
		return new Response(
			JSON.stringify({
				error: "Invalid category",
				valid: validCategories,
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	const result = await getNewsItems(db, { category, limit, cursor });

	return new Response(JSON.stringify(result), {
		headers: { "Content-Type": "application/json" },
	});
};
