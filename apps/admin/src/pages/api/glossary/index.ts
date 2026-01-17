import type { APIRoute } from "astro";

import { createDb } from "@hiroba/db";

import { getGlossaryEntries } from "../../../lib/db-operations";

export const GET: APIRoute = async ({ locals, request }) => {
	const runtime = locals.runtime as { env: { DB: D1Database } };
	const db = createDb(runtime.env.DB);

	const url = new URL(request.url);
	const lang = url.searchParams.get("lang") ?? undefined;

	const entries = await getGlossaryEntries(db, lang);

	return new Response(JSON.stringify({ entries }), {
		headers: { "Content-Type": "application/json" },
	});
};
