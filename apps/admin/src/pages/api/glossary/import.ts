import type { APIRoute } from 'astro';

import { createDb } from '@hiroba/db';

import { importGlossaryFromCsv } from '../../../lib/db-operations';

export const POST: APIRoute = async ({ locals, request }) => {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  const db = createDb(runtime.env.DB);

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const targetLanguage = formData.get('targetLanguage') as string | null;

  if (!file || !targetLanguage) {
    return new Response(
      JSON.stringify({ error: 'Missing file or targetLanguage' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const csv = await file.text();
  const imported = await importGlossaryFromCsv(db, csv, targetLanguage);

  return new Response(JSON.stringify({ success: true, imported }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
