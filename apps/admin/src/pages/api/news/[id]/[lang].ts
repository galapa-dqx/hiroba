import type { APIRoute } from "astro";

import { createDb } from "@hiroba/db";

import { deleteTranslation } from "../../../../lib/db-operations";

export const DELETE: APIRoute = async ({ locals, params }) => {
	const runtime = locals.runtime as { env: { DB: D1Database } };
	const db = createDb(runtime.env.DB);

	const id = params.id!;
	const lang = params.lang!;

	const success = await deleteTranslation(db, id, lang);

	if (!success) {
		return new Response(JSON.stringify({ error: "Not found" }), {
			status: 404,
			headers: { "Content-Type": "application/json" },
		});
	}

	return new Response(JSON.stringify({ success: true, id, language: lang }), {
		headers: { "Content-Type": "application/json" },
	});
};
