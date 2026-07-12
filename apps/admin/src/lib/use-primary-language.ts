/**
 * React hook mirroring the sidebar's primary target language into a component.
 * Seeds from localStorage on mount, then tracks same-tab + cross-tab changes so
 * a list re-fetches (or a title re-renders) the moment the selector changes.
 */

import { useEffect, useState } from 'react';

import {
  getPrimaryLanguage,
  subscribePrimaryLanguage,
} from './primary-language';

export function usePrimaryLanguage(): string {
  const [lang, setLang] = useState(getPrimaryLanguage);
  useEffect(() => {
    setLang(getPrimaryLanguage());
    return subscribePrimaryLanguage(setLang);
  }, []);
  return lang;
}
