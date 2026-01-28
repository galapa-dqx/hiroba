/**
 * Type definitions for the workflow worker.
 */

/**
 * Workflow instance type for type safety.
 */
export type WorkflowInstance = {
  id: string;
  status(): Promise<{
    status:
      | 'queued'
      | 'running'
      | 'paused'
      | 'complete'
      | 'errored'
      | 'terminated'
      | 'unknown';
    output?: unknown;
    error?: string;
  }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  restart(): Promise<void>;
};

/**
 * Workflow binding type.
 */
export type WorkflowBinding<T = unknown> = {
  create(options?: { id?: string; params?: T }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
};

/**
 * Environment bindings for the workflow worker.
 */
export type Env = {
  DB: D1Database;
  OPENAI_API_KEY: string;
  SENTRY_DSN: string;
  WORKFLOW_MANAGER: DurableObjectNamespace;
  NEWS_WORKFLOW: WorkflowBinding<NewsWorkflowParams>;
  CF_VERSION_METADATA: { id: string };
};

/**
 * Parameters passed to the NewsWorkflow.
 */
export type NewsWorkflowParams = {
  itemId: string;
};

/**
 * Result of the fetch-body step.
 */
export type FetchBodyResult = {
  success: boolean;
  contentLength?: number;
};

/**
 * Result of the extract-events step.
 */
export type ExtractEventsResult = {
  count: number;
  eventIds: string[];
};

/**
 * Result of the translate step.
 */
export type TranslateResult = {
  success: boolean;
  fieldsTranslated: number;
};

/**
 * Overall workflow output.
 */
export type NewsWorkflowOutput = {
  itemId: string;
  fetchBody: FetchBodyResult;
  extractEvents: ExtractEventsResult;
  translate: TranslateResult;
};

/**
 * WebSocket progress message types.
 */
export type WorkflowStatus =
  | { type: 'status'; status: string; instanceId?: string }
  | { type: 'progress'; status: string; output?: unknown }
  | { type: 'complete'; output?: unknown }
  | { type: 'error'; error?: string }
  | { type: 'pong' };
