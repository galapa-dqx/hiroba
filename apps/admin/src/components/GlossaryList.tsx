import { useEffect, useState } from 'react';

import { formatLocalDate } from '@hiroba/ui/format-date';

import {
  deleteGlossaryEntry,
  getGlossary,
  type GlossaryEntry,
} from '../lib/api';

export default function GlossaryList() {
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadEntries();
  }, []);

  async function loadEntries() {
    setLoading(true);
    try {
      const { entries } = await getGlossary('en');
      setEntries(entries);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function handleDelete(sourceText: string, lang: string) {
    if (!confirm(`Delete "${sourceText}"?`)) return;
    try {
      await deleteGlossaryEntry(sourceText, lang);
      loadEntries();
    } catch (err) {
      alert('Failed to delete entry');
      console.error(err);
    }
  }

  const filteredEntries = search
    ? entries.filter(
        (e) =>
          e.sourceText.toLowerCase().includes(search.toLowerCase()) ||
          e.translatedText.toLowerCase().includes(search.toLowerCase()),
      )
    : entries;

  if (loading) {
    return <p className="loading">Loading...</p>;
  }

  return (
    <div className="glossary-list">
      <div className="filters">
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="count">{filteredEntries.length} entries</span>
        <button onClick={loadEntries}>Refresh</button>
      </div>

      {filteredEntries.length === 0 ? (
        <p>No glossary entries found.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Japanese</th>
              <th>English</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.map((entry) => (
              <tr key={`${entry.sourceText}-${entry.targetLanguage}`}>
                <td className="jp-text">{entry.sourceText}</td>
                <td>{entry.translatedText}</td>
                <td>{formatLocalDate(entry.updatedAt)}</td>
                <td>
                  <button
                    onClick={() =>
                      handleDelete(entry.sourceText, entry.targetLanguage)
                    }
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
