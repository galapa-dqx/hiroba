import { useEffect, useState } from 'react';

import CategoryDot from '@hiroba/ui/CategoryDot';
import {
  formatOverdue,
  formatRelativePast,
  formatUntil,
} from '@hiroba/ui/format-date';

import {
  getRecheckQueue,
  invalidateBody,
  invalidateTopicBody,
  type RecheckQueue as Queue,
  type RecheckItem,
} from '../lib/api';

function editHref(item: RecheckItem): string {
  return item.itemType === 'topic' ? `/topics/${item.id}` : `/news/${item.id}`;
}

function QueueTable({
  items,
  mode,
  onInvalidate,
}: {
  items: RecheckItem[];
  mode: 'due' | 'upcoming';
  onInvalidate: (item: RecheckItem) => void;
}) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Title</th>
          <th>Category</th>
          <th>Published</th>
          <th>Last Change</th>
          <th>Last Checked</th>
          <th>{mode === 'due' ? 'Overdue By' : 'Next Check In'}</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={`${item.itemType}:${item.id}`}>
            <td>
              <span className={`wf-run__type wf-run__type--${item.itemType}`}>
                {item.itemType}
              </span>
            </td>
            <td className="title-cell">
              <a href={editHref(item)}>{item.titleJa}</a>
            </td>
            <td>
              {item.category ? (
                <span className={`category-badge ${item.category}`}>
                  <CategoryDot category={item.category} />
                  {item.category}
                </span>
              ) : (
                '—'
              )}
            </td>
            <td>{formatRelativePast(item.publishedAt)}</td>
            <td>{formatRelativePast(item.lastChangedAt)}</td>
            <td>{formatRelativePast(item.bodyCheckedAt)}</td>
            <td className={mode === 'due' ? 'overdue' : undefined}>
              {mode === 'due'
                ? formatOverdue(item.nextCheckAt!)
                : formatUntil(item.nextCheckAt!)}
            </td>
            <td>
              <button
                onClick={() => onInvalidate(item)}
                className="btn-small"
                title="Drop the cached body so the next view re-fetches it"
              >
                Invalidate
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function RecheckQueue() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadQueue();
  }, []);

  async function loadQueue() {
    setLoading(true);
    try {
      setQueue(await getRecheckQueue(100));
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function handleInvalidate(item: RecheckItem) {
    try {
      if (item.itemType === 'topic') await invalidateTopicBody(item.id);
      else await invalidateBody(item.id);
      loadQueue();
    } catch (err) {
      alert('Failed to invalidate');
      console.error(err);
    }
  }

  if (loading || queue === null) {
    return <p className="loading">Loading...</p>;
  }

  return (
    <div className="recheck-queue">
      <p className="page-description">
        Articles are re-polled for post-publication edits on a fading schedule
        anchored to their last change; the hourly cron drains the due list.
        Articles quiet for two months retire from checking.
      </p>

      <div className="queue-actions">
        <span>
          {queue.due.length} due · {queue.upcoming.length} upcoming ·{' '}
          {queue.retired} retired
        </span>
        <button onClick={loadQueue}>Refresh</button>
      </div>

      <h3 className="queue-section">Due now</h3>
      {queue.due.length === 0 ? (
        <p className="hint">
          Nothing due — the cron is keeping up with the schedule.
        </p>
      ) : (
        <QueueTable
          items={queue.due}
          mode="due"
          onInvalidate={handleInvalidate}
        />
      )}

      <h3 className="queue-section">Upcoming</h3>
      {queue.upcoming.length === 0 ? (
        <p className="hint">No checks scheduled.</p>
      ) : (
        <QueueTable
          items={queue.upcoming}
          mode="upcoming"
          onInvalidate={handleInvalidate}
        />
      )}
    </div>
  );
}
