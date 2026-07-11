import { useEffect, useState } from 'react';

import {
  crawlPlayguides,
  getPlayguideList,
  triggerPlayguideWorkflow,
  type PlayguideItem,
} from '../lib/api';

/**
 * Playguide management — the bounded guide set (no pagination). A "Crawl now"
 * button re-runs discovery from `guide01` (mirrors the daily cron); each row
 * links to the shared article editor and can (re-)trigger its pipeline.
 */
export default function PlayguideList() {
  const [items, setItems] = useState<PlayguideItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [crawling, setCrawling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const { items } = await getPlayguideList();
      setItems(items);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function onCrawl() {
    setCrawling(true);
    setMessage(null);
    try {
      const r = await crawlPlayguides();
      setMessage(
        `Crawled ${r.crawled} page(s), ${r.newItems} new (${r.titlesEnqueued} title(s) queued).`,
      );
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Crawl failed');
    } finally {
      setCrawling(false);
    }
  }

  async function onTrigger(slug: string) {
    setBusy((b) => new Set(b).add(slug));
    try {
      await triggerPlayguideWorkflow(slug);
      setMessage(`Triggered pipeline for ${slug}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Trigger failed');
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(slug);
        return next;
      });
    }
  }

  return (
    <section>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <h1>Play Guide ({items.length})</h1>
        <button type="button" onClick={onCrawl} disabled={crawling}>
          {crawling ? 'Crawling…' : 'Crawl now'}
        </button>
      </header>

      {message && <p role="status">{message}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>
          No guide pages yet. Click “Crawl now” to discover them from guide01.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Title</th>
              <th>Slug</th>
              <th>Body</th>
              <th>Translated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.sortOrder}</td>
                <td>
                  <a href={`/playguide/${item.id}`}>{item.titleJa}</a>
                </td>
                <td>
                  <code>{item.id}</code>
                </td>
                <td>{item.hasBody ? '✓' : '—'}</td>
                <td>{item.translated ? '✓' : '—'}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => onTrigger(item.id)}
                    disabled={busy.has(item.id)}
                  >
                    {busy.has(item.id) ? '…' : 'Run'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
