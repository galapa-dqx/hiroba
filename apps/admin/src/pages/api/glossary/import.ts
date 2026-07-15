import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb } from '@hiroba/db';

import { importGlossaryFromCsv } from '../../../lib/db-operations';

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);

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
