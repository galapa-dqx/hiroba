import { useEffect, useState, type FormEvent } from 'react';

import CategoryDot from '@hiroba/ui/CategoryDot';
import { formatLocalDate } from '@hiroba/ui/format-date';

import {
  deleteTranslation,
  getNewsList,
  getStats,
  invalidateBody,
  startArchiveScrape,
  triggerRecentNewsWorkflows,
  triggerScrape,
  triggerWorkflow,
  type ArticleTypeStats,
  type NewsItem,
} from '../lib/api';
import { subscribeJob } from '../lib/job-stream';
import { usePrimaryLanguage } from '../lib/use-primary-language';

/** Matches the server-side cap in lib/trigger-recent.ts. */
const MAX_RECENT_TRIGGER = 50;

export default function NewsList() {
  const lang = usePrimaryLanguage();
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [category, setCategory] = useState<string>('');
  const [stats, setStats] = useState<ArticleTypeStats | null>(null);
  const [scraping, setScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState<string | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<Map<string, string>>(
    new Map(),
  );
  const [recentCount, setRecentCount] = useState(10);
  const [triggering, setTriggering] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => {
    loadItems();
  }, [category, lang]);

  async function loadStats() {
    try {
      setStats((await getStats()).news);
    } catch (err) {
      console.error(err);
    }
  }

  async function loadItems() {
    setLoading(true);
    try {
      const { items, nextCursor } = await getNewsList({
        limit: 50,
        category: category || undefined,
        lang,
      });
      setItems(items);
      setNextCursor(nextCursor);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const res = await getNewsList({
        limit: 50,
        category: category || undefined,
        cursor: nextCursor,
        lang,
      });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleScrapeLatest() {
    setScraping(true);
    setScrapeProgress('Scraping category list pages…');
    try {
      const res = await triggerScrape();
      setScrapeProgress(`Done — ${res.totalNewItems} new item(s).`);
      await Promise.all([loadStats(), loadItems()]);
    } catch (err) {
      setScrapeProgress('Scrape failed. Check console.');
      console.error(err);
    }
    setScraping(false);
  }

  async function handleBackfill() {
    if (
      !confirm(
        'Scrape every listing page of every category? New titles are translated automatically; article bodies still fetch lazily.',
      )
    )
      return;

    // The whole archive is too many pages for one request (subrequest limit), so
    // this runs as a background workflow; follow its live progress over SSE.
    setScraping(true);
    setScrapeProgress('Starting archive scrape…');
    try {
      await startArchiveScrape();
      subscribeJob('/api/scrape/stream', {
        onProgress: (p) => setScrapeProgress(p.label),
        onDone: (summary) => {
          setScrapeProgress(`Backfill complete — ${summary ?? 'done'}.`);
          setScraping(false);
          void Promise.all([loadStats(), loadItems()]);
        },
        onError: (message) => {
          setScrapeProgress(`Backfill failed — ${message}.`);
          setScraping(false);
        },
      });
    } catch (err) {
      setScrapeProgress('Backfill failed. Check console.');
      setScraping(false);
      console.error(err);
    }
  }

  async function handleInvalidateBody(id: string) {
    if (!confirm('Invalidate cached body? It will be re-fetched on next view.'))
      return;
    try {
      await invalidateBody(id);
      loadItems();
    } catch (err) {
      alert('Failed to invalidate body');
      console.error(err);
    }
  }

  async function handleTriggerRecent(e: FormEvent) {
    e.preventDefault();
    const n = Math.min(
      Math.max(Math.floor(recentCount), 1),
      MAX_RECENT_TRIGGER,
    );
    if (
      !confirm(
        `Trigger the translation workflow on the ${n} most recent news items? Oversized documents translate in the background and can take a while.`,
      )
    )
      return;

    setTriggering(true);
    setTriggerMsg(null);
    try {
      const res = await triggerRecentNewsWorkflows(n);
      setTriggerMsg(`Triggered ${res.triggered} workflow(s).`);
    } catch (err) {
      setTriggerMsg('Failed to trigger. Check console.');
      console.error(err);
    }
    setTriggering(false);
  }

  async function handleTriggerWorkflow(id: string) {
    try {
      await triggerWorkflow(id);
      setWorkflowStatus((prev) => new Map(prev).set(id, 'Starting...'));

      const setStatus = (line: string) =>
        setWorkflowStatus((prev) => new Map(prev).set(id, line));
      subscribeJob(`/api/news/${id}/sse`, {
        onProgress: (p) => setStatus(p.label),
        onDone: () => {
          setStatus('Done!');
          setTimeout(() => {
            setWorkflowStatus((prev) => {
              const next = new Map(prev);
              next.delete(id);
              return next;
            });
            loadStats();
            loadItems();
          }, 2000);
        },
        onError: (message) =>
          setStatus(
            message === 'Connection lost' ? message : `Error: ${message}`,
          ),
      });
    } catch (err) {
      alert('Failed to trigger workflow');
      console.error(err);
    }
  }

  async function handleDeleteTranslation(id: string) {
    if (
      !confirm(
        'Delete English translation? It will be re-generated on next view.',
      )
    )
      return;
    try {
      await deleteTranslation(id, 'en');
      loadItems();
    } catch (err) {
      alert('Failed to delete translation');
      console.error(err);
    }
  }

  return (
    <div className="news-list-page">
      <div className="stats-grid">
        <div className="stat-card">
          <h3>Total News</h3>
          <p className="stat-value">{stats?.total ?? '—'}</p>
        </div>
        <div className="stat-card">
          <h3>With Body</h3>
          <p className="stat-value">{stats?.withBody ?? '—'}</p>
        </div>
        <div className="stat-card">
          <h3>Translated</h3>
          <p className="stat-value">{stats?.translated ?? '—'}</p>
        </div>
      </div>

      <div className="actions">
        <h3>Scrape</h3>
        <button onClick={handleScrapeLatest} disabled={scraping}>
          {scraping ? 'Working…' : 'Scrape Latest'}
        </button>
        <button onClick={handleBackfill} disabled={scraping}>
          Backfill All
        </button>
        <button onClick={loadItems} disabled={loading || scraping}>
          Refresh
        </button>
        <label>
          Category:
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">All</option>
            <option value="news">News</option>
            <option value="event">Events</option>
            <option value="update">Updates</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </label>
        {scrapeProgress && (
          <span className="workflow-status">{scrapeProgress}</span>
        )}
      </div>

      <div className="actions">
        <h3>Translate recent</h3>
        <form className="inline-form" onSubmit={handleTriggerRecent}>
          <label>
            Count:
            <input
              type="number"
              min={1}
              max={MAX_RECENT_TRIGGER}
              value={recentCount}
              onChange={(e) => setRecentCount(Number(e.target.value))}
              disabled={triggering}
            />
          </label>
          <button type="submit" disabled={triggering}>
            {triggering
              ? 'Triggering…'
              : `Run workflow on ${recentCount} most recent`}
          </button>
        </form>
        {triggerMsg && <span className="workflow-status">{triggerMsg}</span>}
      </div>

      {loading ? (
        <p className="loading">Loading...</p>
      ) : items.length === 0 ? (
        <p>No items found.</p>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Date</th>
                <th>Body</th>
                <th>Translated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="title-cell">
                    <a href={`/news/${item.id}`}>
                      {item.titleLocalized || item.titleJa}
                    </a>
                    <a
                      className="external-link"
                      href={`https://hiroba.dqx.jp/sc/news/detail/${item.id}`}
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
                    <span className={`category-badge ${item.category}`}>
                      <CategoryDot category={item.category} />
                      {item.category}
                    </span>
                  </td>
                  <td>{formatLocalDate(item.publishedAt)}</td>
                  <td>{item.hasBody ? '✓' : '—'}</td>
                  <td>{item.translated ? '✓' : '—'}</td>
                  <td className="actions-cell">
                    <button
                      onClick={() => handleTriggerWorkflow(item.id)}
                      className="btn-small"
                      disabled={workflowStatus.has(item.id)}
                    >
                      Run Workflow
                    </button>
                    {workflowStatus.has(item.id) && (
                      <span className="workflow-status">
                        {workflowStatus.get(item.id)}
                      </span>
                    )}
                    <button
                      onClick={() => handleInvalidateBody(item.id)}
                      className="btn-small"
                    >
                      Invalidate Body
                    </button>
                    <button
                      onClick={() => handleDeleteTranslation(item.id)}
                      className="btn-small btn-danger"
                    >
                      Delete Translation
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {nextCursor && (
            <button onClick={loadMore} disabled={loading}>
              Load more
            </button>
          )}
        </>
      )}
    </div>
  );
}
