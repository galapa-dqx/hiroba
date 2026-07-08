import { useEffect, useState } from 'react';

import { describeSnapshot } from '@hiroba/shared';
import CategoryDot from '@hiroba/ui/CategoryDot';
import { formatLocalDate } from '@hiroba/ui/format-date';

import {
  deleteTranslation,
  getNewsList,
  getStats,
  invalidateBody,
  triggerScrape,
  triggerWorkflow,
  type ArticleTypeStats,
  type NewsItem,
} from '../lib/api';

export default function NewsList() {
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

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => {
    loadItems();
  }, [category]);

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
      const res = await triggerScrape(false);
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

    setScraping(true);
    setScrapeProgress('Scraping all category pages…');
    try {
      const res = await triggerScrape(true);
      setScrapeProgress(
        `Backfill complete — ${res.totalNewItems} new item(s).`,
      );
      await Promise.all([loadStats(), loadItems()]);
    } catch (err) {
      setScrapeProgress('Backfill failed. Check console.');
      console.error(err);
    }
    setScraping(false);
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

  async function handleTriggerWorkflow(id: string) {
    try {
      await triggerWorkflow(id);
      setWorkflowStatus((prev) => new Map(prev).set(id, 'Starting...'));

      const evtSource = new EventSource(`/api/news/${id}/sse`);

      evtSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'state') {
          setWorkflowStatus((prev) =>
            new Map(prev).set(id, describeSnapshot(data.snapshot)),
          );
        }

        if (data.type === 'complete') {
          evtSource.close();
          setWorkflowStatus((prev) => new Map(prev).set(id, 'Done!'));
          setTimeout(() => {
            setWorkflowStatus((prev) => {
              const next = new Map(prev);
              next.delete(id);
              return next;
            });
            loadStats();
            loadItems();
          }, 2000);
        }

        if (data.type === 'error') {
          evtSource.close();
          setWorkflowStatus((prev) =>
            new Map(prev).set(id, `Error: ${data.error}`),
          );
        }
      };

      evtSource.onerror = () => {
        evtSource.close();
        setWorkflowStatus((prev) => new Map(prev).set(id, 'Connection lost'));
      };
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
                    <a href={`/news/${item.id}`}>{item.titleJa}</a>
                    <a
                      className="external-link"
                      href={`https://hiroba.dqx.jp/sc/news/detail/${item.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="View original on Hiroba"
                    >
                      ↗
                    </a>
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
