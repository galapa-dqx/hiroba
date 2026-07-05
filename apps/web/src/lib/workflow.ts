/**
 * Web-side interface to the WorkflowManager Durable Object — the one place
 * that knows the DO naming convention: a news item's DO is named by its bare
 * id; a topic's is namespaced `topic:<id>` so it can't collide with a news
 * item of the same id.
 */

import type { ItemType } from '@hiroba/db';

type ArticleType = Extract<ItemType, 'news' | 'topic'>;

type Runtime = App.Locals['runtime'];

function workflowStub(runtime: Runtime, itemType: ArticleType, id: string) {
  const name = itemType === 'topic' ? `topic:${id}` : id;
  const doId = runtime.env.WORKFLOW_MANAGER.idFromName(name);
  return runtime.env.WORKFLOW_MANAGER.get(doId);
}

/**
 * Fire-and-forget trigger for an article's pipeline (the DO ignores the
 * trigger when a run is already in flight). Failures are logged, not thrown —
 * the page still renders whatever content it has.
 */
export function triggerWorkflow(
  runtime: Runtime,
  itemType: ArticleType,
  id: string,
): void {
  try {
    const stub = workflowStub(runtime, itemType, id);
    stub.fetch('http://internal/trigger', {
      method: 'POST',
      body: JSON.stringify({ itemId: id, itemType }),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error(`Workflow trigger failed for ${itemType} ${id}:`, error);
  }
}

/** Proxy the DO's SSE progress stream for an article (the api sse routes). */
export async function proxyWorkflowSse(
  runtime: Runtime,
  itemType: ArticleType,
  id: string,
): Promise<Response> {
  const stub = workflowStub(runtime, itemType, id);
  const res = await stub.fetch(
    `http://internal/sse?itemId=${id}&itemType=${itemType}`,
  );

  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
