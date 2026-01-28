/**
 * GET /api/news/:id/:lang - Get translated news item
 *
 * If translations exist, returns them immediately.
 * If not, triggers workflow and returns processing status with WebSocket URL.
 */

import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';

import { createDb, getNewsItem, translations } from '@hiroba/db';

import type {
  WorkflowStatusResponse,
  WorkflowTriggerResponse,
} from '../../../../types/do';

export const GET: APIRoute = async ({ locals, params, url }) => {
  const runtime = locals.runtime;
  const db = createDb(runtime.env.DB);
  const id = params.id!;
  const lang = params.lang!;

  // Validate language
  const validLanguages = ['en'];
  if (!validLanguages.includes(lang)) {
    return new Response(
      JSON.stringify({
        error: 'Unsupported language',
        valid: validLanguages,
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // Get the news item metadata from D1
  const item = await getNewsItem(db, id);
  if (!item) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check for existing translations
  const existingTranslations = await db
    .select()
    .from(translations)
    .where(
      and(
        eq(translations.itemType, 'news'),
        eq(translations.itemId, id),
        eq(translations.language, lang),
      ),
    )
    .all();

  const titleTranslation = existingTranslations.find(
    (t) => t.field === 'title',
  );
  const contentTranslation = existingTranslations.find(
    (t) => t.field === 'content',
  );

  // If we have both translations and content exists, return them
  if (titleTranslation && (contentTranslation || !item.contentJa)) {
    return new Response(
      JSON.stringify({
        item,
        translation: {
          title: titleTranslation.value,
          content: contentTranslation?.value ?? item.contentJa ?? '',
          translatedAt: titleTranslation.translatedAt,
          model: titleTranslation.model,
        },
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // No translations - trigger workflow and return processing status
  const doId = runtime.env.WORKFLOW_MANAGER.idFromName(id);
  const stub = runtime.env.WORKFLOW_MANAGER.get(doId);

  // Check current workflow status
  const statusResponse = await stub.fetch(
    `http://internal/status?itemId=${id}`,
  );
  const status = (await statusResponse.json()) as WorkflowStatusResponse;

  // If already processing, return status
  if (status.status === 'running' || status.status === 'queued') {
    const wsUrl = buildWsUrl(url, id);
    return new Response(
      JSON.stringify({
        item,
        processing: true,
        status: status.status,
        wsUrl,
      }),
      {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // Trigger new workflow
  try {
    const triggerResponse = await stub.fetch('http://internal/trigger', {
      method: 'POST',
      body: JSON.stringify({ itemId: id }),
      headers: { 'Content-Type': 'application/json' },
    });

    const triggerResult =
      (await triggerResponse.json()) as WorkflowTriggerResponse;
    const wsUrl = buildWsUrl(url, id);

    return new Response(
      JSON.stringify({
        item,
        processing: true,
        status:
          triggerResult.status === 'started' ? 'started' : 'already_processing',
        instanceId: triggerResult.instanceId,
        wsUrl,
      }),
      {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: `Failed to start processing: ${error}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

/**
 * Build WebSocket URL for progress updates.
 */
function buildWsUrl(requestUrl: URL, itemId: string): string {
  const protocol = requestUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${requestUrl.host}/api/news/${itemId}/ws`;
}
