import { useEffect, useState } from 'react';

import {
  getStats,
  refreshBanners,
  type ArticleTypeStats,
  type Stats,
} from '../lib/api';

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
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);

  async function handleRefreshBanners() {
    setBannerBusy(true);
    setBannerMsg(null);
    try {
      const res = await refreshBanners();
      setBannerMsg(
        res.status === 'already_running'
          ? 'Already running.'
          : 'Refresh started — banners re-localize in the background.',
      );
    } catch (err) {
      setBannerMsg('Failed to start refresh. Check console.');
      console.error(err);
    }
    setBannerBusy(false);
  }

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

      <div className="actions">
        <h3>Rotation banners</h3>
        <button onClick={handleRefreshBanners} disabled={bannerBusy}>
          {bannerBusy ? 'Working…' : 'Refresh banners'}
        </button>
        {bannerMsg && <span className="workflow-status">{bannerMsg}</span>}
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
