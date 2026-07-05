/**
 * WorkflowManager - Durable Object for coordinating workflow operations.
 *
 * Handles both the news and topics pipelines: the trigger payload carries an
 * `itemType` ('news' | 'topic') selecting which workflow binding to drive. The
 * DO is namespaced per (itemType, itemId) by the caller, so news and topic ids
 * (both 32-char hex) never collide.
 *
 * Responsibilities:
 * - Stream SSE progress updates to connected clients
 * - Create/track workflow instances
 * - Poll workflow status and emit events
 */

import { DurableObject } from 'cloudflare:workers';

import type { Env, ItemType, WorkflowBinding } from './types';

function getProgressMessage(
  output: Record<string, unknown> | undefined,
  itemType: ItemType,
): string {
  if (!output) return 'Starting...';
  if (itemType === 'topic') {
    if ('localize' in output) return 'Finishing up...';
    if ('translate' in output) return 'Localizing images...';
    if ('transcribe' in output) return 'Translating...';
    if ('mirror' in output) return 'Reading image text...';
    if ('fetchBody' in output) return 'Saving images...';
  } else {
    if ('translate' in output) return 'Finishing up...';
    if ('extractEvents' in output) return 'Translating...';
    if ('fetchBody' in output) return 'Extracting events...';
  }
  return 'Fetching content...';
}

type Active = { instanceId: string; itemType: ItemType };

export class WorkflowManager extends DurableObject<Env> {
  /** Track active workflow instances by item ID. */
  private activeWorkflows = new Map<string, Active>();

  private workflowFor(itemType: ItemType): WorkflowBinding<{ itemId: string }> {
    return itemType === 'topic'
      ? this.env.TOPICS_WORKFLOW
      : this.env.NEWS_WORKFLOW;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/sse') {
      return this.handleSSE(url);
    }
    if (url.pathname === '/trigger' && request.method === 'POST') {
      return this.handleTrigger(request);
    }
    if (url.pathname === '/status') {
      const itemId = url.searchParams.get('itemId');
      if (!itemId)
        return Response.json({ error: 'itemId required' }, { status: 400 });
      return this.handleStatus(itemId);
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  /** Handle SSE connection — streams workflow progress as server-sent events. */
  private handleSSE(url: URL): Response {
    const itemId = url.searchParams.get('itemId');
    if (!itemId) {
      return new Response('itemId query param required', { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };

        const active = this.activeWorkflows.get(itemId);
        if (!active) {
          send({ type: 'error', error: 'No active workflow' });
          controller.close();
          return;
        }

        const workflow = this.workflowFor(active.itemType);
        const pollInterval = 1000;
        const maxPolls = 300; // 5 minutes

        for (let i = 0; i < maxPolls; i++) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));

          try {
            const instance = await workflow.get(active.instanceId);
            const status = await instance.status();

            if (status.status === 'complete') {
              send({ type: 'progress', message: 'Done!' });
              send({ type: 'complete' });
              this.activeWorkflows.delete(itemId);
              controller.close();
              return;
            }

            if (status.status === 'errored') {
              send({ type: 'error', error: status.error ?? 'Unknown error' });
              this.activeWorkflows.delete(itemId);
              controller.close();
              return;
            }

            send({
              type: 'progress',
              message: getProgressMessage(
                status.output as Record<string, unknown> | undefined,
                active.itemType,
              ),
            });
          } catch (error) {
            console.error('Error polling workflow status:', error);
            send({ type: 'error', error: 'Polling failed' });
            controller.close();
            return;
          }
        }

        this.activeWorkflows.delete(itemId);
        send({ type: 'error', error: 'Workflow timeout' });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /** Handle workflow trigger request. */
  private async handleTrigger(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      itemId: string;
      itemType?: ItemType;
    };
    const { itemId } = body;
    const itemType: ItemType = body.itemType ?? 'news';

    if (!itemId) {
      return Response.json({ error: 'itemId required' }, { status: 400 });
    }

    const workflow = this.workflowFor(itemType);

    // Skip if already processing.
    const existing = this.activeWorkflows.get(itemId);
    if (existing) {
      const instance = await workflow.get(existing.instanceId);
      const status = await instance.status();
      if (status.status === 'running' || status.status === 'queued') {
        return Response.json({
          status: 'already_processing',
          instanceId: existing.instanceId,
        });
      }
    }

    const instance = await workflow.create({ params: { itemId } });
    this.activeWorkflows.set(itemId, { instanceId: instance.id, itemType });
    return Response.json({ status: 'started', instanceId: instance.id });
  }

  /** Handle status request. */
  private async handleStatus(itemId: string): Promise<Response> {
    const active = this.activeWorkflows.get(itemId);
    if (!active) return Response.json({ status: 'idle' });

    try {
      const instance = await this.workflowFor(active.itemType).get(
        active.instanceId,
      );
      const status = await instance.status();
      return Response.json({
        status: status.status,
        instanceId: active.instanceId,
        output: status.output,
        error: status.error,
      });
    } catch {
      this.activeWorkflows.delete(itemId);
      return Response.json({ status: 'idle' });
    }
  }
}
