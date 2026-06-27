import { useEffect, useState } from 'react';

import { getRecheckQueue, invalidateBody, type QueueItem } from '../lib/api';
import { formatLocal, formatOverdue, formatRelativePast } from '../lib/format-date';

export default function RecheckQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadQueue();
  }, []);

  async function loadQueue() {
    setLoading(true);
    try {
      const { items } = await getRecheckQueue(100);
      setItems(items);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function handleInvalidate(id: string) {
    try {
      await invalidateBody(id);
      loadQueue();
    } catch (err) {
      alert('Failed to invalidate');
      console.error(err);
    }
  }

  async function handleInvalidateAll() {
    if (!confirm(`Invalidate all ${items.length} items in queue?`)) return;

    for (const item of items) {
      try {
        await invalidateBody(item.id);
      } catch (err) {
        console.error(`Failed to invalidate ${item.id}:`, err);
      }
    }
    loadQueue();
  }

  if (loading) {
    return <p className="loading">Loading...</p>;
  }

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <p>No items due for recheck.</p>
        <button onClick={loadQueue}>Refresh</button>
      </div>
    );
  }

  return (
    <div className="recheck-queue">
      <div className="queue-actions">
        <span>{items.length} items in queue</span>
        <button onClick={loadQueue}>Refresh</button>
        <button onClick={handleInvalidateAll} className="btn-danger">
          Invalidate All
        </button>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Category</th>
            <th>Published</th>
            <th>Last Fetched</th>
            <th>Overdue By</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="title-cell">{item.titleJa}</td>
              <td>
                <span className={`category-badge ${item.category}`}>
                  {item.category}
                </span>
              </td>
              <td>{formatRelativePast(item.publishedAt)}</td>
              <td>
                {item.bodyFetchedAt ? formatLocal(item.bodyFetchedAt) : 'Never'}
              </td>
              <td className="overdue">{formatOverdue(item.nextCheckAt)}</td>
              <td>
                <button
                  onClick={() => handleInvalidate(item.id)}
                  className="btn-small"
                >
                  Invalidate
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
