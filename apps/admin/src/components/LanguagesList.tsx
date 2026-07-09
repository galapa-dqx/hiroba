import { useEffect, useState } from 'react';

import { formatLocalDate } from '@hiroba/ui/format-date';

import {
  addLanguage,
  backfillLanguageTitles,
  deleteLanguage,
  getLanguages,
  updateLanguage,
  type LanguageEntry,
} from '../lib/api';

const EMPTY_FORM = { code: '', label: '', nativeLabel: '' };

export default function LanguagesList() {
  const [languages, setLanguages] = useState<LanguageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    loadLanguages();
  }, []);

  async function loadLanguages() {
    setLoading(true);
    try {
      const { languages } = await getLanguages();
      setLanguages(languages);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await addLanguage(form);
      setForm(EMPTY_FORM);
      await loadLanguages();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add language');
      console.error(err);
    }
    setSaving(false);
  }

  async function handleToggle(entry: LanguageEntry) {
    try {
      await updateLanguage(entry.code, { enabled: !entry.enabled });
      await loadLanguages();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update language');
      console.error(err);
    }
  }

  async function handleBackfill(entry: LanguageEntry) {
    if (
      !confirm(
        `Backfill every untranslated ${entry.label} (${entry.code}) title ` +
          `across the whole archive? Runs in the background; already-translated ` +
          `titles are skipped, so it's safe to re-run.`,
      )
    ) {
      return;
    }
    try {
      await backfillLanguageTitles(entry.code);
      alert(
        `Started the ${entry.label} title backfill. Lists fill in as it runs.`,
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to start backfill');
      console.error(err);
    }
  }

  async function handleDelete(entry: LanguageEntry) {
    if (
      !confirm(
        `Remove "${entry.label}" (${entry.code}) from the whitelist? Existing ` +
          `translations stay in the database but stop being served.`,
      )
    ) {
      return;
    }
    try {
      await deleteLanguage(entry.code);
      await loadLanguages();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete language');
      console.error(err);
    }
  }

  if (loading) {
    return <p className="loading">Loading...</p>;
  }

  return (
    <div className="languages-list">
      <form className="filters" onSubmit={handleAdd}>
        <input
          type="text"
          placeholder="Code (en, fr, zh-TW…)"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
          required
          pattern="[a-z]{2,3}(-[A-Za-z0-9]{2,8})?"
          title='A BCP-47-style code like "en", "fr" or "zh-TW"'
          size={12}
        />
        <input
          type="text"
          placeholder="English name (French)"
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
          required
        />
        <input
          type="text"
          placeholder="Native name (Français)"
          value={form.nativeLabel}
          onChange={(e) => setForm({ ...form, nativeLabel: e.target.value })}
          required
        />
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Adding…' : 'Add language'}
        </button>
      </form>

      {languages.length === 0 ? (
        <p>
          No languages whitelisted — the site falls back to English until one is
          added.
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>English name</th>
              <th>Native name</th>
              <th>Status</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {languages.map((entry) => (
              <tr key={entry.code}>
                <td>
                  <code>{entry.code}</code>
                </td>
                <td>{entry.label}</td>
                <td lang={entry.code}>{entry.nativeLabel}</td>
                <td>{entry.enabled ? 'Enabled' : 'Disabled'}</td>
                <td>{formatLocalDate(entry.updatedAt)}</td>
                <td>
                  <button
                    onClick={() => handleToggle(entry)}
                    className="btn-small"
                  >
                    {entry.enabled ? 'Disable' : 'Enable'}
                  </button>{' '}
                  <button
                    onClick={() => handleBackfill(entry)}
                    className="btn-small"
                    title="Translate every untranslated title across the archive"
                  >
                    Backfill titles
                  </button>{' '}
                  <button
                    onClick={() => handleDelete(entry)}
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
