/**
 * WorkflowManager - Durable Object for coordinating workflow operations.
 *
 * Responsibilities:
 * - Stream SSE progress updates to connected clients
 * - Create/track workflow instances
 * - Poll workflow status and emit events
 */

import { DurableObject } from 'cloudflare:workers';

import type { Env, NewsWorkflowOutput } from './types';

function getProgressMessage(output: Partial<NewsWorkflowOutput> | undefined): string {
  if (!output) return 'Starting...';
  if ('translate' in output) return 'Finishing up...';
  if ('extractEvents' in output) return 'Translating...';
  if ('fetchBody' in output) return 'Extracting events...';
  return 'Fetching content...';
}

export class WorkflowManager extends DurableObject<Env> {
  /** Track active workflow instance IDs by news item ID */
  private activeWorkflows = new Map<string, string>();

  /**
   * Handle incoming requests.
   */
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
      if (!itemId) {
        return Response.json({ error: 'itemId required' }, { status: 400 });
      }
      return this.handleStatus(itemId);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  /**
   * Handle SSE connection — streams workflow progress as server-sent events.
   */
  private handleSSE(url: URL): Response {
    const itemId = url.searchParams.get('itemId');
    if (!itemId) {
      return new Response('itemId query param required', { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        const instanceId = this.activeWorkflows.get(itemId);
        if (!instanceId) {
          send({ type: 'error', error: 'No active workflow' });
          controller.close();
          return;
        }

        const pollInterval = 1000;
        const maxPolls = 300; // 5 minutes

        for (let i = 0; i < maxPolls; i++) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));

          try {
            const instance = await this.env.NEWS_WORKFLOW.get(instanceId);
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

            const message = getProgressMessage(
              status.output as Partial<NewsWorkflowOutput> | undefined,
            );
            send({ type: 'progress', message });
          } catch (error) {
            console.error('Error polling workflow status:', error);
            send({ type: 'error', error: 'Polling failed' });
            controller.close();
            return;
          }
        }

        // Timeout
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

  /**
   * Handle workflow trigger request.
   */
  private async handleTrigger(request: Request): Promise<Response> {
    const body = (await request.json()) as { itemId: string };
    const { itemId } = body;

    if (!itemId) {
      return Response.json({ error: 'itemId required' }, { status: 400 });
    }

    // Check if already processing
    const existingInstanceId = this.activeWorkflows.get(itemId);
    if (existingInstanceId) {
      const instance = await this.env.NEWS_WORKFLOW.get(existingInstanceId);
      const status = await instance.status();

      if (status.status === 'running' || status.status === 'queued') {
        return Response.json({
          status: 'already_processing',
          instanceId: existingInstanceId,
        });
      }
    }

    // Create new workflow instance
    const instance = await this.env.NEWS_WORKFLOW.create({
      params: { itemId },
    });

    this.activeWorkflows.set(itemId, instance.id);

    return Response.json({ status: 'started', instanceId: instance.id });
  }

  /**
   * Handle status request.
   */
  private async handleStatus(itemId: string): Promise<Response> {
    const instanceId = this.activeWorkflows.get(itemId);

    if (!instanceId) {
      return Response.json({ status: 'idle' });
    }

    try {
      const instance = await this.env.NEWS_WORKFLOW.get(instanceId);
      const status = await instance.status();

      return Response.json({
        status: status.status,
        instanceId,
        output: status.output,
        error: status.error,
      });
    } catch {
      this.activeWorkflows.delete(itemId);
      return Response.json({ status: 'idle' });
    }
  }
}
