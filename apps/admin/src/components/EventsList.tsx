import { useEffect, useState } from 'react';

import { deleteEvent, getEvents, type EventItem } from '../lib/api';
import { formatJst, formatJstDate, formatLocal } from '../lib/format-date';

const EVENT_TYPE_LABELS: Record<string, string> = {
  multiDay: 'Multi-day',
  allDay: 'All-day',
  span: 'Timed',
  mark: 'Milestone',
};

/**
 * Format an event time (UTC instant ISO string) for display.
 *
 * Date-granular events (multiDay/allDay) show the JST calendar date only —
 * converting a date to the viewer's zone could shift the day. Time-granular
 * events (span/mark) show the viewer's local time annotated with the JST
 * wall-clock, since those are the times announced officially in JST.
 */
function formatEventTime(iso: string, type: string): string {
  if (type === 'multiDay' || type === 'allDay') {
    return `${formatJstDate(iso)} JST`;
  }
  return `${formatLocal(iso)} (${formatJst(iso)} JST)`;
}

export default function EventsList() {
  const [items, setItems] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  useEffect(() => {
    loadItems();
  }, [type]);

  async function loadItems() {
    setLoading(true);
    try {
      const { items } = await getEvents({
        limit: 100,
        type: type || undefined,
        search: search || undefined,
      });
      setItems(items);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    loadItems();
  }

  async function handleDelete(id: string, title: string) {
    if (!confirm(`Delete event "${title}"? This cannot be undone.`)) return;
    try {
      await deleteEvent(id);
      loadItems();
    } catch (err) {
      alert('Failed to delete event');
      console.error(err);
    }
  }

  return (
    <div className="events-list-page">
      <div className="filters">
        <label>
          Type:
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            <option value="multiDay">Multi-day</option>
            <option value="allDay">All-day</option>
            <option value="span">Timed</option>
            <option value="mark">Milestone</option>
          </select>
        </label>
        <form onSubmit={handleSearch} className="search-form">
          <input
            type="text"
            placeholder="Search title..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>
        <button onClick={loadItems} disabled={loading}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="loading">Loading...</p>
      ) : items.length === 0 ? (
        <p>No events found.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Title (JA)</th>
              <th>Title (EN)</th>
              <th>Type</th>
              <th>Start</th>
              <th>End</th>
              <th>Source</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="title-cell">{item.titleJa}</td>
                <td className="title-cell">
                  {item.titleEn || <span className="muted">—</span>}
                </td>
                <td>
                  <span className={`type-badge ${item.type}`}>
                    {EVENT_TYPE_LABELS[item.type] || item.type}
                  </span>
                </td>
                <td>{formatEventTime(item.startTime, item.type)}</td>
                <td>
                  {item.endTime ? (
                    formatEventTime(item.endTime, item.type)
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {item.sourceId ? (
                    <a
                      href={`https://hiroba.dqx.jp/sc/news/detail/${item.sourceId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="source-link"
                    >
                      {item.sourceType}
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="actions-cell">
                  <button
                    onClick={() => handleDelete(item.id, item.titleJa)}
                    className="btn-small btn-danger"
                  >
                    Delete
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
