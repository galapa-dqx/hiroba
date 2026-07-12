import { useEffect, useState } from 'react';
import { RRuleTemporal } from 'rrule-temporal';
import { toText } from 'rrule-temporal/totext';

import {
  deleteReset,
  getResets,
  upsertReset,
  type ResetLanguage,
  type ResetMilestoneEntry,
} from '../lib/api';

// The recurrences the builder compiles. Every reset fires at a wall-clock time
// in Asia/Tokyo (the game-server zone); the DTSTART anchor date is arbitrary —
// rrule-temporal expands BYDAY/BYMONTHDAY independently of it.
type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY';

const WEEKDAYS = [
  { code: 'SU', label: 'Sun' },
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
];

type FormState = {
  /** The reset's slug id; locked once it exists (it keys the row). */
  id: string;
  editing: boolean;
  titleJa: string;
  titles: Record<string, string>;
  freq: Freq;
  byday: string[];
  bymonthday: string; // comma list, e.g. "1, 15"
  hour: number;
  minute: number;
  enabled: boolean;
  sortOrder: number;
  note: string;
};

const emptyForm = (): FormState => ({
  id: '',
  editing: false,
  titleJa: '',
  titles: {},
  freq: 'DAILY',
  byday: ['SU'],
  bymonthday: '1',
  hour: 6,
  minute: 0,
  enabled: true,
  sortOrder: 0,
  note: '',
});

/** Parse "1, 15" → [1, 15], keeping only valid 1–31 day numbers, in order. */
function parseMonthDays(input: string): number[] {
  return input
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31);
}

/** Compile the builder state into the stored `DTSTART…\nRRULE:…` ICS string. */
function compileRrule(form: FormState): string {
  const hh = String(form.hour).padStart(2, '0');
  const mm = String(form.minute).padStart(2, '0');
  const dtstart = `DTSTART;TZID=Asia/Tokyo:20200101T${hh}${mm}00`;
  let rule = `FREQ=${form.freq}`;
  if (form.freq === 'WEEKLY' && form.byday.length) {
    rule += `;BYDAY=${form.byday.join(',')}`;
  } else if (form.freq === 'MONTHLY') {
    const days = parseMonthDays(form.bymonthday);
    if (days.length) rule += `;BYMONTHDAY=${days.join(',')}`;
  }
  return `${dtstart}\nRRULE:${rule}`;
}

/** Populate the builder from a stored ICS string (regex is enough for the
 *  shapes this editor emits: FREQ + BYDAY/BYMONTHDAY + a DTSTART time). */
function parseRrule(
  ics: string,
): Pick<FormState, 'freq' | 'byday' | 'bymonthday' | 'hour' | 'minute'> {
  const freq = (/FREQ=([A-Z]+)/.exec(ics)?.[1] as Freq) ?? 'DAILY';
  const byday = (/BYDAY=([^;\r\n]+)/.exec(ics)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bymonthday = (/BYMONTHDAY=([^;\r\n]+)/.exec(ics)?.[1] ?? '').trim();
  const time = /T(\d{2})(\d{2})\d{2}/.exec(ics);
  return {
    freq: freq === 'WEEKLY' || freq === 'MONTHLY' ? freq : 'DAILY',
    byday: byday.length ? byday : ['SU'],
    bymonthday: bymonthday || '1',
    hour: time ? Number(time[1]) : 6,
    minute: time ? Number(time[2]) : 0,
  };
}

/** Human-readable schedule for a stored rule; blank on a rule we can't parse. */
function describeRule(rrule: string): string {
  try {
    return toText(new RRuleTemporal({ rruleString: rrule }));
  } catch {
    return '';
  }
}

export default function ResetsList() {
  const [resets, setResets] = useState<ResetMilestoneEntry[]>([]);
  const [languages, setLanguages] = useState<ResetLanguage[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const { resets, languages } = await getResets();
      setResets(resets);
      setLanguages(languages);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }

  function startNew() {
    setForm(emptyForm());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function startEdit(r: ResetMilestoneEntry) {
    setForm({
      id: r.id,
      editing: true,
      titleJa: r.titleJa,
      titles: { ...r.titles },
      enabled: r.enabled,
      sortOrder: r.sortOrder,
      note: r.note ?? '',
      ...parseRrule(r.rrule),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const id = form.id.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      alert('ID must be a slug like "daily" or "weekly-sun".');
      return;
    }
    if (!form.titleJa.trim()) {
      alert('Japanese name is required.');
      return;
    }
    if (form.freq === 'WEEKLY' && form.byday.length === 0) {
      alert('Pick at least one weekday for a weekly reset.');
      return;
    }
    if (
      form.freq === 'MONTHLY' &&
      parseMonthDays(form.bymonthday).length === 0
    ) {
      alert('Enter at least one day of the month (1–31).');
      return;
    }

    setSaving(true);
    try {
      await upsertReset({
        id,
        titleJa: form.titleJa.trim(),
        titles: form.titles,
        rrule: compileRrule(form),
        enabled: form.enabled,
        sortOrder: form.sortOrder,
        note: form.note.trim() || null,
      });
      setForm(emptyForm());
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save reset');
      console.error(err);
    }
    setSaving(false);
  }

  async function handleDelete(r: ResetMilestoneEntry) {
    if (!confirm(`Delete the "${r.titles.en ?? r.titleJa}" reset?`)) return;
    try {
      await deleteReset(r.id);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete reset');
      console.error(err);
    }
  }

  function toggleWeekday(code: string) {
    setForm((f) => ({
      ...f,
      byday: f.byday.includes(code)
        ? f.byday.filter((d) => d !== code)
        : [...f.byday, code],
    }));
  }

  const preview = describeRule(compileRrule(form));

  return (
    <div className="resets-page">
      <form className="reset-form" onSubmit={handleSave}>
        <div className="reset-form__row">
          <div className="form-group">
            <label htmlFor="reset-id">ID (slug)</label>
            <input
              id="reset-id"
              type="text"
              value={form.id}
              placeholder="weekly-sun"
              disabled={form.editing}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="reset-ja">Name — Japanese (source)</label>
            <input
              id="reset-ja"
              type="text"
              lang="ja"
              value={form.titleJa}
              placeholder="ウィークリーリセット"
              onChange={(e) => setForm({ ...form, titleJa: e.target.value })}
              required
            />
          </div>
        </div>

        {languages.length > 0 && (
          <div className="reset-form__row reset-form__langs">
            {languages.map((l) => (
              <div className="form-group" key={l.code}>
                <label htmlFor={`reset-title-${l.code}`}>
                  Name — {l.label} ({l.code})
                </label>
                <input
                  id={`reset-title-${l.code}`}
                  type="text"
                  value={form.titles[l.code] ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      titles: { ...form.titles, [l.code]: e.target.value },
                    })
                  }
                />
              </div>
            ))}
          </div>
        )}

        <fieldset className="reset-form__recur">
          <legend>Recurrence</legend>
          <div className="reset-form__row">
            <div className="form-group">
              <label htmlFor="reset-freq">Frequency</label>
              <select
                id="reset-freq"
                value={form.freq}
                onChange={(e) =>
                  setForm({ ...form, freq: e.target.value as Freq })
                }
              >
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
            <div className="form-group reset-form__time">
              <label htmlFor="reset-hour">Time (JST)</label>
              <div className="reset-form__time-inputs">
                <input
                  id="reset-hour"
                  type="number"
                  min={0}
                  max={23}
                  value={form.hour}
                  onChange={(e) =>
                    setForm({ ...form, hour: Number(e.target.value) })
                  }
                />
                <span>:</span>
                <input
                  aria-label="Minute"
                  type="number"
                  min={0}
                  max={59}
                  value={form.minute}
                  onChange={(e) =>
                    setForm({ ...form, minute: Number(e.target.value) })
                  }
                />
              </div>
            </div>
          </div>

          {form.freq === 'WEEKLY' && (
            <div className="form-group">
              <label>Weekdays</label>
              <div className="reset-form__weekdays">
                {WEEKDAYS.map((d) => (
                  <label key={d.code} className="reset-form__weekday">
                    <input
                      type="checkbox"
                      checked={form.byday.includes(d.code)}
                      onChange={() => toggleWeekday(d.code)}
                    />
                    {d.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {form.freq === 'MONTHLY' && (
            <div className="form-group">
              <label htmlFor="reset-monthdays">Days of month</label>
              <input
                id="reset-monthdays"
                type="text"
                value={form.bymonthday}
                placeholder="1, 15"
                onChange={(e) =>
                  setForm({ ...form, bymonthday: e.target.value })
                }
              />
            </div>
          )}

          <p className="reset-form__preview">
            {preview ? `Schedule: ${preview}` : 'Schedule: —'}
          </p>
        </fieldset>

        <div className="reset-form__row">
          <div className="form-group">
            <label htmlFor="reset-note">Note (admin only)</label>
            <input
              id="reset-note"
              type="text"
              value={form.note}
              placeholder="What resets — not shown on the calendar"
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
          <div className="form-group reset-form__narrow">
            <label htmlFor="reset-sort">Sort order</label>
            <input
              id="reset-sort"
              type="number"
              value={form.sortOrder}
              onChange={(e) =>
                setForm({ ...form, sortOrder: Number(e.target.value) })
              }
            />
          </div>
          <label className="reset-form__enabled">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving
              ? 'Saving…'
              : form.editing
                ? 'Save changes'
                : 'Create reset'}
          </button>
          {(form.editing || form.id || form.titleJa) && (
            <button type="button" className="btn-small" onClick={startNew}>
              {form.editing ? 'Cancel' : 'Clear'}
            </button>
          )}
        </div>
      </form>

      <p className="page-description">
        Recurring game resets (server cronjobs — not scrapeable). Each appears
        on the calendar as a milestone at its time in JST; resets that coincide
        are merged into one tick. Saving re-materializes the calendar
        immediately.
      </p>

      <div className="filters">
        <span className="count">{resets.length} resets</span>
        <button onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="loading">Loading…</p>
      ) : resets.length === 0 ? (
        <p>No resets defined.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name (EN)</th>
              <th>Japanese</th>
              <th>Schedule</th>
              <th>Enabled</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {resets.map((r) => (
              <tr key={r.id} className={r.enabled ? undefined : 'is-disabled'}>
                <td>
                  {r.titles.en ?? <span className="jp-text">{r.titleJa}</span>}
                </td>
                <td className="jp-text">{r.titleJa}</td>
                <td>
                  {describeRule(r.rrule) || <span className="muted">—</span>}
                </td>
                <td>{r.enabled ? 'Yes' : 'No'}</td>
                <td>
                  <button className="btn-small" onClick={() => startEdit(r)}>
                    Edit
                  </button>{' '}
                  <button
                    className="btn-small btn-danger"
                    onClick={() => handleDelete(r)}
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
