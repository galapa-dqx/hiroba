import { useEffect, useState } from 'react';

import { getRecheckQueue, invalidateBody, type QueueItem } from '../lib/api';

function formatOverdue(nextCheckAt: number): string {
  const diff = Date.now() - nextCheckAt;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp * 1000;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

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
              <td>{formatRelativeTime(item.publishedAt)}</td>
              <td>
                {item.bodyFetchedAt
                  ? new Date(item.bodyFetchedAt * 1000).toLocaleString()
                  : 'Never'}
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
