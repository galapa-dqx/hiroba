import { useEffect, useState } from 'react';

import {
  deleteTranslation,
  getNewsList,
  invalidateBody,
  triggerWorkflow,
  type NewsItem,
} from '../lib/api';

export default function NewsList() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<string>('');
  const [workflowStatus, setWorkflowStatus] = useState<Map<string, string>>(
    new Map(),
  );

  useEffect(() => {
    loadItems();
  }, [category]);

  async function loadItems() {
    setLoading(true);
    try {
      const { items } = await getNewsList({
        limit: 50,
        category: category || undefined,
      });
      setItems(items);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
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

        if (data.type === 'progress') {
          setWorkflowStatus((prev) => new Map(prev).set(id, data.message));
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
        setWorkflowStatus((prev) =>
          new Map(prev).set(id, 'Connection lost'),
        );
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
      alert('Translation deleted');
    } catch (err) {
      alert('Failed to delete translation');
      console.error(err);
    }
  }

  return (
    <div className="news-list-page">
      <div className="filters">
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
        <button onClick={loadItems} disabled={loading}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="loading">Loading...</p>
      ) : items.length === 0 ? (
        <p>No items found.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Category</th>
              <th>Date</th>
              <th>Body</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="title-cell">
                  <a
                    href={`https://hiroba.dqx.jp/sc/news/detail/${item.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.titleJa}
                  </a>
                </td>
                <td>
                  <span className={`category-badge ${item.category}`}>
                    {item.category}
                  </span>
                </td>
                <td>
                  {new Date(item.publishedAt * 1000).toLocaleDateString()}
                </td>
                <td>{item.contentJa ? '✓' : '—'}</td>
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
      )}
    </div>
  );
}
