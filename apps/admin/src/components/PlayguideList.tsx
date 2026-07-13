import { useEffect, useRef, useState } from 'react';

import {
  crawlPlayguides,
  getPlayguideList,
  triggerPlayguideWorkflow,
  type PlayguideItem,
} from '../lib/api';
import { useItemRunStreams } from '../lib/use-item-run';
import { usePrimaryLanguage } from '../lib/use-primary-language';

/**
 * Playguide management — the bounded guide set (no pagination). A "Crawl now"
 * button re-runs discovery from `guide01` (mirrors the daily cron); each row
 * links to the shared article editor and can (re-)trigger its pipeline. Titles
 * render in the sidebar's primary target language, falling back to Japanese.
 */
export default function PlayguideList() {
  const followItemRun = useItemRunStreams();
  const lang = usePrimaryLanguage();
  const [items, setItems] = useState<PlayguideItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [crawling, setCrawling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Rows with a pipeline in flight — drives the disabled state. Kept separate
  // from `workflowStatus` (display text) so an SSE error can re-enable the
  // button while still surfacing what went wrong.
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [workflowStatus, setWorkflowStatus] = useState<Map<string, string>>(
    new Map(),
  );
  // Monotonic token so a slow in-flight list load (e.g. from an earlier
  // language) can't clobber the results of a newer one.
  const loadSeq = useRef(0);
  // Always read the *current* language, not the value captured when a deferred
  // caller (onCrawl, workflow onDone) closed over it — otherwise a language
  // change during that async work could reload the list in the stale language.
  const langRef = useRef(lang);
  langRef.current = lang;

  useEffect(() => {
    void load();
  }, [lang]);

  /** Reload the list. Returns true only when it fetched fresh data. */
  async function load(): Promise<boolean> {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const { items } = await getPlayguideList({ lang: langRef.current });
      if (seq !== loadSeq.current) return false; // a newer load superseded this
      setItems(items);
      setMessage(null); // clear any stale error/notice now that data is fresh
      return true;
    } catch (err) {
      // Only surface the error if this is still the newest load — a slow,
      // superseded fetch failing shouldn't overwrite a fresher success.
      if (seq === loadSeq.current) {
        setMessage(err instanceof Error ? err.message : 'Failed to load');
      }
      return false;
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  async function onCrawl() {
    setCrawling(true);
    setMessage(null);
    try {
      const r = await crawlPlayguides();
      // load() clears `message` on success, so set the summary afterwards — but
      // only if the reload actually succeeded, else we'd mask its error and
      // claim success over a stale table.
      const reloaded = await load();
      if (reloaded) {
        setMessage(
          `Crawled ${r.crawled} page(s), ${r.newItems} new (${r.titlesEnqueued} title(s) queued).`,
        );
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Crawl failed');
    } finally {
      setCrawling(false);
    }
  }

  async function onTrigger(slug: string) {
    const clearBusy = () =>
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(slug);
        return next;
      });
    try {
      setBusy((prev) => new Set(prev).add(slug));
      await triggerPlayguideWorkflow(slug);
      setWorkflowStatus((prev) => new Map(prev).set(slug, 'Starting...'));

      const setStatus = (line: string) =>
        setWorkflowStatus((prev) => new Map(prev).set(slug, line));
      followItemRun('playguide', slug, {
        onProgress: setStatus,
        onDone: () => {
          setStatus('Done!');
          setTimeout(() => {
            setWorkflowStatus((prev) => {
              const next = new Map(prev);
              next.delete(slug);
              return next;
            });
            clearBusy();
            void load();
          }, 2000);
        },
        onError: (msg) => {
          // Surface the error but re-enable the button so it can be retried.
          setStatus(msg === 'Connection lost' ? msg : `Error: ${msg}`);
          clearBusy();
        },
      });
    } catch (err) {
      alert('Failed to trigger workflow');
      console.error(err);
      clearBusy();
    }
  }

  return (
    <div className="playguide-list-page">
      <div className="actions">
        <h3>Play Guide ({items.length})</h3>
        <button type="button" onClick={onCrawl} disabled={crawling}>
          {crawling ? 'Crawling…' : 'Crawl now'}
        </button>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
        {message && <span className="workflow-status">{message}</span>}
      </div>

      {loading ? (
        <p className="loading">Loading...</p>
      ) : items.length === 0 ? (
        <p>
          No guide pages yet. Click “Crawl now” to discover them from guide01.
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Title</th>
              <th>Slug</th>
              <th>Body</th>
              <th>Translated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.sortOrder}</td>
                <td className="title-cell">
                  <a href={`/playguide/${item.id}`}>
                    {item.titleLocalized || item.titleJa}
                  </a>
                  <a
                    className="external-link"
                    href={`https://hiroba.dqx.jp/sc/public/playguide/${item.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View original on Hiroba"
                  >
                    ↗
                  </a>
                  {item.titleLocalized && (
                    <span className="title-cell__ja" lang="ja">
                      {item.titleJa}
                    </span>
                  )}
                </td>
                <td>
                  <code>{item.id}</code>
                </td>
                <td>{item.hasBody ? '✓' : '—'}</td>
                <td>{item.translated ? '✓' : '—'}</td>
                <td className="actions-cell">
                  <button
                    type="button"
                    onClick={() => onTrigger(item.id)}
                    className="btn-small"
                    disabled={busy.has(item.id)}
                  >
                    Run Workflow
                  </button>
                  {workflowStatus.has(item.id) && (
                    <span className="workflow-status">
                      {workflowStatus.get(item.id)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
