/**
 * Shared GET/PUT handlers for the single-article admin endpoints
 * (/api/news/[id] and /api/topics/[id]) — the two differ only in which table
 * they read and the itemType they write.
 */

import type { APIRoute } from 'astro';

import {
  createDb,
  getArticleTranslations,
  getNewsItem,
  getTopic,
  updateArticleSource,
  upsertItemTranslation,
} from '@hiroba/db';
import type { Block } from '@hiroba/richtext';

import { validateBlocks } from './validate-blocks';

/** Model attribution recorded on translation rows edited by hand. */
export const MANUAL_EDIT_MODEL = 'manual-edit';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getDb(locals: App.Locals) {
  const runtime = locals.runtime as { env: { DB: D1Database } };
  return createDb(runtime.env.DB);
}

/** GET /api/{news,topics}/[id] — source fields plus the English translation. */
export function createArticleGet(itemType: 'news' | 'topic'): APIRoute {
  return async ({ locals, params }) => {
    const db = getDb(locals);
    const id = params.id!;

    const item =
      itemType === 'news' ? await getNewsItem(db, id) : await getTopic(db, id);
    if (!item) return json({ error: 'Not found' }, 404);

    const en = await getArticleTranslations(db, itemType, id, 'en');

    return json({
      id: item.id,
      titleJa: item.titleJa,
      category: item.category,
      publishedAt: item.publishedAt.toString(),
      blocksJa: item.blocksJa,
      en: {
        title: en.title,
        blocks: en.blocks,
        translatedAt: en.translatedAt?.toString() ?? null,
      },
    });
  };
}

/** PUT /api/{news,topics}/[id] — update titleJa and/or blocksJa. */
export function createArticlePut(itemType: 'news' | 'topic'): APIRoute {
  return async ({ locals, params, request }) => {
    const db = getDb(locals);
    const id = params.id!;

    const body = (await request.json()) as {
      titleJa?: string;
      blocksJa?: Block[];
    };

    const patch: { titleJa?: string; blocksJa?: Block[] } = {};
    if (body.titleJa !== undefined) {
      if (typeof body.titleJa !== 'string' || !body.titleJa.trim()) {
        return json({ error: 'titleJa must be a non-empty string' }, 400);
      }
      patch.titleJa = body.titleJa;
    }
    if (body.blocksJa !== undefined) {
      const error = validateBlocks(body.blocksJa);
      if (error) return json({ error: `Invalid blocks: ${error}` }, 400);
      patch.blocksJa = body.blocksJa;
    }
    if (Object.keys(patch).length === 0) {
      return json({ error: 'Nothing to update' }, 400);
    }

    const success = await updateArticleSource(db, itemType, id, patch);
    if (!success) return json({ error: 'Not found' }, 404);

    return json({ success: true, id });
  };
}

/** PUT /api/{news,topics}/[id]/[lang] — update the translated title/blocks. */
export function createTranslationPut(itemType: 'news' | 'topic'): APIRoute {
  return async ({ locals, params, request }) => {
    const db = getDb(locals);
    const id = params.id!;
    const lang = params.lang!;

    const body = (await request.json()) as {
      title?: string;
      blocks?: Block[];
    };

    if (body.title === undefined && body.blocks === undefined) {
      return json({ error: 'Nothing to update' }, 400);
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) {
        return json({ error: 'title must be a non-empty string' }, 400);
      }
    }
    if (body.blocks !== undefined) {
      const error = validateBlocks(body.blocks);
      if (error) return json({ error: `Invalid blocks: ${error}` }, 400);
    }

    if (body.title !== undefined) {
      await upsertItemTranslation(db, {
        itemType,
        itemId: id,
        language: lang,
        field: 'title',
        value: body.title,
        model: MANUAL_EDIT_MODEL,
      });
    }
    if (body.blocks !== undefined) {
      await upsertItemTranslation(db, {
        itemType,
        itemId: id,
        language: lang,
        field: 'content',
        value: JSON.stringify(body.blocks),
        model: MANUAL_EDIT_MODEL,
      });
    }

    return json({ success: true, id, language: lang });
  };
}
