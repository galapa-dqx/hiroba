/**
 * PrimaryLanguageSelect — the sidebar-foot selector for the "primary
 * translation target language": the language the admin views translated content
 * in (currently the Images screen). Selection persists to localStorage and is
 * broadcast via the primary-language helper so reader islands update live.
 *
 * Only enabled languages are offered. If the stored language was disabled or
 * removed, we reconcile to the first enabled one on load.
 */

import { useEffect, useState } from 'react';

import { getLanguages, type LanguageEntry } from '../lib/api';
import {
  getPrimaryLanguage,
  setPrimaryLanguage,
  subscribePrimaryLanguage,
} from '../lib/primary-language';

export default function PrimaryLanguageSelect() {
  const [languages, setLanguages] = useState<LanguageEntry[]>([]);
  const [value, setValue] = useState(getPrimaryLanguage);

  // Reflect changes made elsewhere (e.g. another tab) into the control.
  useEffect(() => subscribePrimaryLanguage(setValue), []);

  useEffect(() => {
    let cancelled = false;
    getLanguages()
      .then(({ languages }) => {
        if (cancelled) return;
        const enabled = languages.filter((l) => l.enabled);
        setLanguages(enabled);
        // Reconcile a stale stored value against the current whitelist.
        const current = getPrimaryLanguage();
        if (enabled.length > 0 && !enabled.some((l) => l.code === current)) {
          setPrimaryLanguage(enabled[0].code);
        }
      })
      .catch((err) => console.error(err));
    return () => {
      cancelled = true;
    };
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setValue(e.target.value);
    setPrimaryLanguage(e.target.value);
  }

  return (
    <label className="lang-select">
      <span className="lang-select__label">Primary target language</span>
      <select
        value={value}
        onChange={handleChange}
        disabled={languages.length === 0}
        aria-label="Primary translation target language"
      >
        {/* Keep the stored value selectable even before the list loads. */}
        {languages.length === 0 ? (
          <option value={value}>{value}</option>
        ) : (
          languages.map((l) => (
            <option key={l.code} value={l.code} lang={l.code}>
              {l.nativeLabel} ({l.code})
            </option>
          ))
        )}
      </select>
    </label>
  );
}
