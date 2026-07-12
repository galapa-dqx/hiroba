import { useEffect, useRef, useState } from 'react';

import { formatLocalDate } from '@hiroba/ui/format-date';

import {
  deleteGlossaryOverride,
  getGlossary,
  upsertGlossaryOverride,
  type GlossaryEntry,
} from '../lib/api';
import { usePrimaryLanguage } from '../lib/use-primary-language';

const EMPTY_FORM = { sourceText: '', translatedText: '' };

export default function GlossaryList() {
  // The list is loaded for — and overrides created in — the sidebar's primary
  // target language.
  const lang = usePrimaryLanguage();
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  // Monotonic token so a slow in-flight load from an earlier language can't
  // clobber a newer one's entries.
  const loadSeq = useRef(0);

  useEffect(() => {
    // Drop any half-typed override when the language changes — its text is in
    // the previous language and must not be saved under the new one.
    setForm(EMPTY_FORM);
    loadEntries();
  }, [lang]);

  async function loadEntries() {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const { entries } = await getGlossary(lang);
      if (seq !== loadSeq.current) return; // a newer load superseded this one
      setEntries(entries);
    } catch (err) {
      console.error(err);
    }
    if (seq === loadSeq.current) setLoading(false);
  }

  async function handleSaveOverride(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await upsertGlossaryOverride({
        sourceText: form.sourceText.trim(),
        targetLanguage: lang,
        translatedText: form.translatedText.trim(),
      });
      setForm(EMPTY_FORM);
      await loadEntries();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save override');
      console.error(err);
    }
    setSaving(false);
  }

  // Prefill the form from an existing row so an imported term can be shadowed
  // (or an override tweaked) without retyping the Japanese.
  function handleEdit(entry: GlossaryEntry) {
    setForm({
      sourceText: entry.sourceText,
      translatedText: entry.translatedText,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleDeleteOverride(sourceText: string) {
    if (!confirm(`Remove the override for "${sourceText}"?`)) return;
    try {
      await deleteGlossaryOverride(sourceText, lang);
      await loadEntries();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete override');
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
      <form className="filters" onSubmit={handleSaveOverride}>
        <input
          type="text"
          placeholder="Japanese (カムバック)"
          value={form.sourceText}
          onChange={(e) => setForm({ ...form, sourceText: e.target.value })}
          required
          lang="ja"
        />
        <input
          type="text"
          placeholder={`Translation (${lang.toUpperCase()})`}
          value={form.translatedText}
          onChange={(e) => setForm({ ...form, translatedText: e.target.value })}
          required
        />
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : 'Save override'}
        </button>
        {(form.sourceText || form.translatedText) && (
          <button
            type="button"
            className="btn-small"
            onClick={() => setForm(EMPTY_FORM)}
          >
            Clear
          </button>
        )}
      </form>
      <p className="page-description">
        Overrides survive the nightly upstream refresh and win over the imported
        translation for the same Japanese term. Imported rows are replaced each
        night, so edit them by saving an override.
      </p>

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
              <th>{lang.toUpperCase()}</th>
              <th>Source</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.map((entry) => (
              <tr key={`${entry.sourceText}-${entry.targetLanguage}`}>
                <td className="jp-text">{entry.sourceText}</td>
                <td>{entry.translatedText}</td>
                <td>{entry.isOverride ? 'Override' : 'Imported'}</td>
                <td>{formatLocalDate(entry.updatedAt)}</td>
                <td>
                  <button
                    onClick={() => handleEdit(entry)}
                    className="btn-small"
                    title={
                      entry.isOverride
                        ? 'Edit this override'
                        : 'Create an override that shadows this imported term'
                    }
                  >
                    {entry.isOverride ? 'Edit' : 'Override'}
                  </button>{' '}
                  {entry.isOverride && (
                    <button
                      onClick={() => handleDeleteOverride(entry.sourceText)}
                      className="btn-small btn-danger"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
