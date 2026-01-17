/**
 * WorkflowManager - Durable Object for coordinating workflow operations.
 *
 * Responsibilities:
 * - Accept WebSocket connections for progress updates
 * - Create/track workflow instances
 * - Poll workflow status and broadcast to connected clients
 * - Handle "already processing" case gracefully
 */

import { DurableObject } from 'cloudflare:workers';

import type { Env, WorkflowStatus } from './types';

export class WorkflowManager extends DurableObject<Env> {
  /** Track active workflow instance IDs by news item ID */
  private activeWorkflows = new Map<string, string>();

  /**
   * Handle incoming requests - either WebSocket upgrades or workflow triggers.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket connection for progress updates
    if (url.pathname === '/ws') {
      return this.handleWebSocket(request, url);
    }

    // Trigger workflow for a news item
    if (url.pathname === '/trigger' && request.method === 'POST') {
      return this.handleTrigger(request);
    }

    // Get workflow status
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
   * Handle WebSocket upgrade request.
   */
  private handleWebSocket(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    const itemId = url.searchParams.get('itemId');
    if (!itemId) {
      return new Response('itemId query param required', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept with hibernation API, tag with itemId for filtering
    this.ctx.acceptWebSocket(server, [itemId]);

    // Send current status immediately
    const instanceId = this.activeWorkflows.get(itemId);
    if (instanceId) {
      server.send(JSON.stringify({ type: 'status', status: 'processing', instanceId }));
    }

    return new Response(null, { status: 101, webSocket: client });
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
      // Check if the workflow is still running
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

    // Track the workflow
    this.activeWorkflows.set(itemId, instance.id);

    // Broadcast to connected clients
    this.broadcast(itemId, { type: 'status', status: 'started', instanceId: instance.id });

    // Start polling for status updates
    this.ctx.waitUntil(this.pollWorkflowStatus(itemId, instance.id));

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
      // Instance may have been cleaned up
      this.activeWorkflows.delete(itemId);
      return Response.json({ status: 'idle' });
    }
  }

  /**
   * Poll workflow status and broadcast updates.
   */
  private async pollWorkflowStatus(itemId: string, instanceId: string): Promise<void> {
    const pollInterval = 1000; // 1 second
    const maxPolls = 300; // 5 minutes max

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      try {
        const instance = await this.env.NEWS_WORKFLOW.get(instanceId);
        const status = await instance.status();

        this.broadcast(itemId, {
          type: 'progress',
          status: status.status,
          output: status.output,
        });

        if (status.status === 'complete') {
          this.activeWorkflows.delete(itemId);
          this.broadcast(itemId, {
            type: 'complete',
            output: status.output,
          });
          return;
        }

        if (status.status === 'errored') {
          this.activeWorkflows.delete(itemId);
          this.broadcast(itemId, {
            type: 'error',
            error: status.error,
          });
          return;
        }
      } catch (error) {
        console.error('Error polling workflow status:', error);
      }
    }

    // Timeout - stop polling
    this.activeWorkflows.delete(itemId);
    this.broadcast(itemId, {
      type: 'error',
      error: 'Workflow timeout',
    });
  }

  /**
   * Broadcast message to all WebSocket clients subscribed to an item.
   */
  private broadcast(itemId: string, message: WorkflowStatus): void {
    const sockets = this.ctx.getWebSockets(itemId);
    const data = JSON.stringify(message);

    for (const socket of sockets) {
      try {
        socket.send(data);
      } catch {
        // Socket may be closed
      }
    }
  }

  /**
   * Handle incoming WebSocket messages.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Currently we don't need to handle incoming messages from clients
    // This is primarily a broadcast channel
    if (typeof message === 'string') {
      try {
        const data = JSON.parse(message) as { type: string; itemId?: string };
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore invalid messages
      }
    }
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // No cleanup needed - hibernation API handles this
  }

  /**
   * Handle WebSocket errors.
   */
  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Log but don't throw
    console.error('WebSocket error');
  }
}
