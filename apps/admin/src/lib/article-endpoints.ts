/**
 * Shared GET/PUT handlers for the single-article admin endpoints
 * (/api/news/[id], /api/topics/[id], /api/playguide/[slug]) — they differ only
 * in which table they read and the itemType they write. Playguides carry no
 * category and no publish date, so those fields come back null for them.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import {
  createDb,
  getArticleTranslations,
  getEnabledLanguages,
  getImagesByKeys,
  getImageTranslations,
  getNewsItem,
  getPlayguide,
  getTopic,
  updateArticleSource,
  upsertItemTranslation,
  type ArticleType,
} from '@hiroba/db';
import { collectImages, imageKey, type Block } from '@hiroba/richtext';

import { validateBlocks } from './validate-blocks';

/** Model attribution recorded on translation rows edited by hand. */
const MANUAL_EDIT_MODEL = 'manual-edit';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getDb() {
  return createDb(env.DB);
}

/**
 * GET /api/{news,topics}/[id] — source fields plus one translation per enabled
 * language. Each language also carries `localizedImages`: original imageKey →
 * the VERSIONED R2 key of that language's localized raster, so the editor can
 * swap `/img/<key>` → `/img/<storedKey>` on the translated tabs. The stored key
 * always names a written object, so it is served as-is rather than reconstructed
 * from a path convention.
 */
export function createArticleGet(itemType: ArticleType): APIRoute {
  return async ({ params }) => {
    const db = getDb();
    // News/topics route on [id]; playguides on [slug].
    const id = (params.id ?? params.slug)!;

    const item =
      itemType === 'news'
        ? await getNewsItem(db, id)
        : itemType === 'playguide'
          ? await getPlayguide(db, id)
          : await getTopic(db, id);
    if (!item) return json({ error: 'Not found' }, 404);

    const languages = await getEnabledLanguages(db);

    // The distinct images referenced by the article. Localization only swaps
    // the raster (never the block tree), so the source tree carries every key.
    const imgKeys = [
      ...new Set(
        collectImages((item.blocksJa as Block[] | null) ?? [])
          .map((i) => imageKey(i.src))
          .filter((k): k is string => !!k),
      ),
    ];
    const imageRows = imgKeys.length ? await getImagesByKeys(db, imgKeys) : [];
    const imageIds = imageRows.map((r) => r.id);

    const translations: Record<
      string,
      {
        title: string | null;
        blocks: Block[] | null;
        translatedAt: string | null;
        localizedImages: Record<string, string>;
      }
    > = {};
    for (const lang of languages) {
      const t = await getArticleTranslations(db, itemType, id, lang.code);
      const localizedImages: Record<string, string> = {};
      if (imageIds.length) {
        const urls = await getImageTranslations(db, imageIds, lang.code, 'url');
        for (const row of imageRows) {
          const stored = urls.get(row.id);
          if (stored) localizedImages[row.key] = stored;
        }
      }
      translations[lang.code] = {
        title: t.title,
        blocks: t.blocks,
        translatedAt: t.translatedAt?.toString() ?? null,
        localizedImages,
      };
    }

    return json({
      id: item.id,
      titleJa: item.titleJa,
      // Playguides have neither a category nor a publish date.
      category: 'category' in item ? item.category : null,
      publishedAt: item.publishedAt?.toString() ?? null,
      blocksJa: item.blocksJa,
      languages,
      translations,
    });
  };
}

/** PUT /api/{news,topics,playguide}/[id] — update titleJa and/or blocksJa. */
export function createArticlePut(itemType: ArticleType): APIRoute {
  return async ({ params, request }) => {
    const db = getDb();
    const id = (params.id ?? params.slug)!;

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

/** PUT /api/{news,topics,playguide}/[id]/[lang] — update the translated title/blocks. */
export function createTranslationPut(itemType: ArticleType): APIRoute {
  return async ({ params, request }) => {
    const db = getDb();
    const id = (params.id ?? params.slug)!;
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
