import { useEffect, useState } from 'react';

import {
  deleteTranslation,
  getNewsList,
  invalidateBody,
  type NewsItem,
} from '../lib/api';

export default function NewsList() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<string>('');

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
