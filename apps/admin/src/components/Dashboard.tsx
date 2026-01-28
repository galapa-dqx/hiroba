import { useEffect, useState } from 'react';

import { getStats, triggerScrape, type Stats } from '../lib/api';

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
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
      const data = await getStats();
      setStats(data);
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
