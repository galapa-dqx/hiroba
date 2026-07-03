import { useEffect, useState } from 'react';

import {
  getStats,
  getTopicStats,
  triggerScrape,
  type Stats,
  type TopicStats,
} from '../lib/api';

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [topicStats, setTopicStats] = useState<TopicStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    setLoading(true);
    setError(null);
    try {
      const [data, topics] = await Promise.all([getStats(), getTopicStats()]);
      setStats(data);
      setTopicStats(topics);
    } catch (err) {
      setError('Failed to load stats.');
      console.error(err);
    }
    setLoading(false);
  }

  async function handleScrape(full: boolean) {
    setScraping(true);
    try {
      const result = await triggerScrape(full);
      alert(`Scrape complete: ${result.totalNewItems} new items`);
      loadStats();
    } catch (err) {
      alert('Scrape failed. Check console for details.');
      console.error(err);
    }
    setScraping(false);
  }

  if (loading) {
    return <p className="loading">Loading...</p>;
  }

  if (error) {
    return (
      <div className="error-state">
        <p>{error}</p>
        <button onClick={loadStats}>Retry</button>
      </div>
    );
  }

  if (!stats) {
    return <p>No data available</p>;
  }

  return (
    <div className="dashboard">
      <div className="stats-grid">
        <div className="stat-card">
          <h3>Total Items</h3>
          <p className="stat-value">{stats.totalItems}</p>
        </div>
        <div className="stat-card">
          <h3>With Body (contentJa)</h3>
          <p className="stat-value">{stats.itemsWithBody}</p>
        </div>
        <div className="stat-card">
          <h3>With bodyFetchedAt</h3>
          <p className="stat-value">{stats.itemsWithBodyFetchedAt}</p>
        </div>
        <div className="stat-card">
          <h3>Translated</h3>
          <p className="stat-value">{stats.itemsTranslated}</p>
        </div>
        <div className="stat-card">
          <h3>Pending Recheck</h3>
          <p className="stat-value">{stats.itemsPendingRecheck}</p>
        </div>
      </div>

      <div className="topics-summary">
        <h3>
          Topics <a href="/topics">Manage →</a>
        </h3>
        <div className="stats-grid">
          <div className="stat-card">
            <h3>Total Topics</h3>
            <p className="stat-value">{topicStats?.total ?? '—'}</p>
          </div>
          <div className="stat-card">
            <h3>With Body</h3>
            <p className="stat-value">{topicStats?.withBody ?? '—'}</p>
          </div>
          <div className="stat-card">
            <h3>Translated</h3>
            <p className="stat-value">{topicStats?.translated ?? '—'}</p>
          </div>
        </div>
      </div>

      <div className="category-breakdown">
        <h3>By Category</h3>
        <ul>
          {Object.entries(stats.byCategory).map(([category, count]) => (
            <li key={category}>
              <span className="category-name">{category}</span>
              <span className="category-count">{count}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="actions">
        <h3>Actions</h3>
        <button onClick={() => handleScrape(false)} disabled={scraping}>
          {scraping ? 'Scraping...' : 'Scrape New'}
        </button>
        <button onClick={() => handleScrape(true)} disabled={scraping}>
          Full Scrape
        </button>
        <button onClick={loadStats} disabled={loading}>
          Refresh Stats
        </button>
      </div>
    </div>
  );
}
