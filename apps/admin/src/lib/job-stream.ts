/**
 * Client-side consumer for the SSE job protocol (@hiroba/shared `SSEEvent`).
 *
 * One place that knows how to open an EventSource, fold `state`/`progress` into
 * a display line, and tear down on `complete`/`error`/transport failure — so
 * the per-article pipeline views and the whole-archive scrape don't each
 * re-implement the same lifecycle.
 */

import { describeSnapshot, type SSEEvent } from '@hiroba/shared';

export type JobProgress = { label: string; done?: number; total?: number };

export type JobHandlers = {
  /** A new running line — either a pipeline snapshot or a scrape counter. */
  onProgress: (progress: JobProgress) => void;
  /** Terminal success, with an optional human summary. */
  onDone?: (summary?: string) => void;
  /** Terminal failure (an `error` event or a dropped connection). */
  onError?: (message: string) => void;
};

/**
 * Open an SSE stream and dispatch its events to `handlers`. Returns a cleanup
 * that closes the stream; it also closes itself on any terminal event.
 */
export function subscribeJob(url: string, handlers: JobHandlers): () => void {
  const source = new EventSource(url);
  const close = () => source.close();

  source.onmessage = (event) => {
    const data = JSON.parse(event.data) as SSEEvent;
    switch (data.type) {
      case 'state':
        handlers.onProgress({ label: describeSnapshot(data.snapshot) });
        break;
      case 'progress':
        handlers.onProgress({
          label: data.label,
          done: data.done,
          total: data.total,
        });
        break;
      case 'complete':
        close();
        handlers.onDone?.(data.summary);
        break;
      case 'error':
        close();
        handlers.onError?.(data.error);
        break;
    }
  };
  source.onerror = () => {
    close();
    handlers.onError?.('Connection lost');
  };

  return close;
}
