/**
 * Page-purge proxy for the admin worker's manual image upload.
 *
 * An upload writes the versioned R2 object and the D1 translation row in the
 * admin worker itself, but cached article pages still embed the previous
 * version's URL — and the purge credentials (zone id + token) live only here.
 * So the admin proxies the bust over its WORKFLOW service binding, exactly
 * like the regenerate route purges after its own render. Best-effort: a purge
 * failure means cached pages keep the previous version until their TTL, never
 * a failed upload.
 */

import { createDb } from '@hiroba/db';

import { purgeImagePages } from './purge';
import type { Env } from './types';

export async function purgeImagePagesRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as {
    imageKey?: unknown;
    language?: unknown;
  };
  const imageKey = typeof body.imageKey === 'string' ? body.imageKey : '';
  const language = typeof body.language === 'string' ? body.language : '';
  if (!imageKey || !language) {
    return Response.json(
      { error: 'imageKey (string) and language (string) required' },
      { status: 400 },
    );
  }
  await purgeImagePages(env, createDb(env.DB), imageKey, language, {
    warn: (m) => console.warn(m),
    debug: () => {},
  });
  return Response.json({ ok: true });
}
