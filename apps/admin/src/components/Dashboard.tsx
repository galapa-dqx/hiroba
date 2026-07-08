import { useEffect, useState } from 'react';

import { getStats, type ArticleTypeStats, type Stats } from '../lib/api';

function TypeStatsGrid({ stats }: { stats: ArticleTypeStats }) {
  const cards: Array<[string, number]> = [
    ['Total', stats.total],
    ['With Body', stats.withBody],
    ['Translated', stats.translated],
    ['Recheck Due', stats.recheckDue],
    ['Recheck Upcoming', stats.recheckUpcoming],
    ['Recheck Retired', stats.recheckRetired],
  ];
  return (
    <div className="stats-grid">
      {cards.map(([label, value]) => (
        <div className="stat-card" key={label}>
          <h3>{label}</h3>
          <p className="stat-value">{value}</p>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    setLoading(true);
    setError(null);
    try {
      setStats(await getStats());
    } catch (err) {
      setError('Failed to load stats.');
      console.error(err);
    }
    setLoading(false);
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
      <div className="type-summary">
        <h3>
          News <a href="/news">Manage →</a>
        </h3>
        <TypeStatsGrid stats={stats.news} />
      </div>

      <div className="type-summary">
        <h3>
          Topics <a href="/topics">Manage →</a>
        </h3>
        <TypeStatsGrid stats={stats.topics} />
      </div>

      <div className="category-breakdown">
        <h3>News by Category</h3>
        <ul>
          {Object.entries(stats.news.byCategory).map(([category, count]) => (
            <li key={category}>
              <span className="category-name">{category}</span>
              <span className="category-count">{count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
