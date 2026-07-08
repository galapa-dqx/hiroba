import { useEffect, useState } from 'react';

import { describeSnapshot } from '@hiroba/shared';
import { formatLocalDate } from '@hiroba/ui/format-date';

import {
  deleteTopicTranslation,
  getStats,
  getTopicsList,
  invalidateTopicBody,
  scrapeTopics,
  triggerTopicWorkflow,
  type ArticleTypeStats,
  type TopicItem,
} from '../lib/api';

export default function TopicsList() {
  const [items, setItems] = useState<TopicItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [stats, setStats] = useState<ArticleTypeStats | null>(null);
  const [scrapeProgress, setScrapeProgress] = useState<string | null>(null);
  const [scraping, setScraping] = useState(false);
  const [workflowStatus, setWorkflowStatus] = useState<Map<string, string>>(
    new Map(),
  );

  useEffect(() => {
    loadStats();
    loadItems();
  }, []);

  async function loadStats() {
    try {
      setStats((await getStats()).topics);
    } catch (err) {
      console.error(err);
    }
  }

  async function loadItems() {
    setLoading(true);
    try {
      const { items, nextCursor } = await getTopicsList({ limit: 50 });
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
      const res = await getTopicsList({ limit: 50, cursor: nextCursor });
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleScrapeLatest() {
    setScraping(true);
    setScrapeProgress('Scraping current month…');
    try {
      // batch=1 → only the current (not-yet-archived) listing page.
      const res = await scrapeTopics({ cursor: 0, batch: 1 });
      setScrapeProgress(`Done — ${res.newItems} new topic(s).`);
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
        'Backfill the entire topics archive (all months)? New titles are translated automatically; article bodies still fetch lazily.',
      )
    )
      return;

    setScraping(true);
    let cursor = 0;
    let totalNew = 0;
    try {
      // Loop the batched endpoint until the whole backnumber archive is seeded.
      // Each request stays well within a Worker's subrequest limits.
      for (;;) {
        const res = await scrapeTopics({ cursor, batch: 12 });
        totalNew += res.newItems;
        setScrapeProgress(
          `Seeding ${res.nextCursor}/${res.total} months… (${totalNew} new)`,
        );
        cursor = res.nextCursor;
        if (res.done) break;
      }
      setScrapeProgress(`Backfill complete — ${totalNew} new topic(s).`);
      await Promise.all([loadStats(), loadItems()]);
    } catch (err) {
      setScrapeProgress('Backfill failed. Check console.');
      console.error(err);
    }
    setScraping(false);
  }

  async function handleTriggerWorkflow(id: string) {
    try {
      await triggerTopicWorkflow(id);
      setWorkflowStatus((prev) => new Map(prev).set(id, 'Starting...'));

      const evtSource = new EventSource(`/api/topics/${id}/sse`);

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

  async function handleInvalidateBody(id: string) {
    if (!confirm('Invalidate cached body? It will be re-fetched on next view.'))
      return;
    try {
      await invalidateTopicBody(id);
      loadItems();
    } catch (err) {
      alert('Failed to invalidate body');
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
      await deleteTopicTranslation(id, 'en');
      loadItems();
    } catch (err) {
      alert('Failed to delete translation');
      console.error(err);
    }
  }

  return (
    <div className="topics-list-page">
      <div className="stats-grid">
        <div className="stat-card">
          <h3>Total Topics</h3>
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
        {scrapeProgress && (
          <span className="workflow-status">{scrapeProgress}</span>
        )}
      </div>

      {loading ? (
        <p className="loading">Loading...</p>
      ) : items.length === 0 ? (
        <p>
          No topics yet. Use “Scrape Latest” or “Backfill All” to seed them.
        </p>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
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
                    <a href={`/topics/${item.id}`}>{item.titleJa}</a>
                    <a
                      className="external-link"
                      href={`https://hiroba.dqx.jp/sc/topics/detail/${item.id}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="View original on Hiroba"
                    >
                      ↗
                    </a>
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
