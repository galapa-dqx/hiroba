/**
 * ImageEdit — the single-image admin screen. The source (mirrored original +
 * transcribed Japanese) sits on the left; a tab per enabled language on the
 * right lets the operator:
 *
 *   • edit the JA→target span pairs and save them,
 *   • regenerate the localized image with gpt-image-2 from those pairs, or
 *   • upload a hand-made image for that language.
 *
 * Saved spans only reach the rendered image on the next regeneration; an upload
 * (and a regeneration) is marked as a manual override the nightly pipeline
 * leaves alone. The localized preview is cache-busted after any change since the
 * R2 object is served immutable at a stable key.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { formatLocalDate } from '@hiroba/ui/format-date';

import {
  getImageDetail,
  regenerateImage,
  saveImageTranslation,
  uploadImage,
  type ImageDetail,
} from '../lib/api';
import { getPrimaryLanguage } from '../lib/primary-language';

type Props = { id: number };

export default function ImageEdit({ id }: Props) {
  const [detail, setDetail] = useState<ImageDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lang, setLang] = useState<string>('en');

  // Editable translated spans + dirty flag, keyed by language code.
  const [pairs, setPairs] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Bumped after a regenerate/upload to defeat the immutable image cache.
  const [bust, setBust] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // Refs mirror dirty state so an async reload never clobbers unsaved edits.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const loadDetail = useCallback(async () => {
    const d = await getImageDetail(id);
    setDetail(d);
    const spans = d.textsJa ?? [];
    setPairs((prev) => {
      const next = { ...prev };
      for (const l of d.languages) {
        // Preserve unsaved edits across a reload; otherwise seed from the saved
        // translation, padded/aligned to the source spans.
        if (dirtyRef.current[l.code]) continue;
        const existing = d.translations[l.code]?.texts ?? [];
        next[l.code] = spans.map((_, i) => existing[i] ?? '');
      }
      return next;
    });
    return d;
  }, [id]);

  useEffect(() => {
    // Default the active tab to the sidebar's primary language when it's one we
    // translate into; the language tabs still let the operator switch freely.
    const primary = getPrimaryLanguage();
    loadDetail()
      .then((d) => {
        if (d.languages.some((l) => l.code === primary)) setLang(primary);
        else if (d.languages[0]) setLang(d.languages[0].code);
      })
      .catch((err) => {
        console.error(err);
        setLoadError('Failed to load image. Does it exist?');
      });
  }, [loadDetail]);

  function setSpan(code: string, index: number, value: string) {
    setPairs((p) => {
      const arr = [...(p[code] ?? [])];
      arr[index] = value;
      return { ...p, [code]: arr };
    });
    setDirty((d) => (d[code] ? d : { ...d, [code]: true }));
    setStatus(null);
    setActionError(null);
  }

  async function save(announce = true): Promise<boolean> {
    if (!detail) return false;
    setSaving(true);
    setStatus(null);
    setActionError(null);
    try {
      await saveImageTranslation(id, lang, pairs[lang] ?? []);
      setDirty((d) => ({ ...d, [lang]: false }));
      if (announce)
        setStatus(
          'Translations saved — regenerate to apply them to the image.',
        );
      setSaving(false);
      return true;
    } catch (err) {
      console.error(err);
      setActionError(err instanceof Error ? err.message : 'Save failed.');
      setSaving(false);
      return false;
    }
  }

  async function regenerate() {
    if (!detail) return;
    // Regeneration reads the saved spans, so persist any pending edits first;
    // bail if that save fails rather than regenerate from stale text.
    if (dirtyRef.current[lang] && !(await save(false))) return;
    setRegenerating(true);
    setStatus(null);
    setActionError(null);
    try {
      const res = await regenerateImage(id, lang);
      await loadDetail();
      setBust((b) => b + 1);
      if (res.status === 'done') setStatus('Image regenerated.');
      else setActionError('Regeneration failed — see the error below.');
    } catch (err) {
      console.error(err);
      setActionError(
        err instanceof Error ? err.message : 'Regeneration failed.',
      );
    }
    setRegenerating(false);
  }

  async function upload() {
    if (!detail) return;
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setActionError('Choose an image file to upload first.');
      return;
    }
    setUploading(true);
    setStatus(null);
    setActionError(null);
    try {
      await uploadImage(id, lang, file);
      if (fileRef.current) fileRef.current.value = '';
      await loadDetail();
      setBust((b) => b + 1);
      setStatus('Image uploaded.');
    } catch (err) {
      console.error(err);
      setActionError(err instanceof Error ? err.message : 'Upload failed.');
    }
    setUploading(false);
  }

  if (loadError) return <p className="error">{loadError}</p>;
  if (!detail) return <p className="loading">Loading…</p>;

  const spans = detail.textsJa ?? [];
  const t = detail.translations[lang];
  const langLabel =
    detail.languages.find((l) => l.code === lang)?.nativeLabel ?? lang;
  const localizedSrc =
    t?.urlState === 'done' && t.localizedKey
      ? `/img/${t.localizedKey}?v=${bust}`
      : null;
  const busy = saving || regenerating || uploading;

  return (
    <div className="image-edit">
      <div className="article-edit__meta">
        <a href="/images">← Back to images</a>
        <span className="image-edit__key" title={detail.key}>
          {detail.key}
        </span>
        <span>updated {formatLocalDate(detail.updatedAt)}</span>
      </div>

      <div className="img-row image-edit__row">
        {/* Source — read-only */}
        <div className="img-side">
          <div className="img-side__head">Source · 日本語</div>
          <a
            className="img-side__frame"
            href={`/img/${detail.key}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              className="img-side__img"
              src={`/img/${detail.key}`}
              alt={detail.key}
              loading="lazy"
            />
          </a>
          {spans.length > 0 ? (
            <ul className="img-side__spans" lang="ja">
              {spans.map((s, i) => (
                <li key={i}>{s || <em className="muted">(empty)</em>}</li>
              ))}
            </ul>
          ) : (
            <p className="img-side__note muted">
              {detail.transcribeState === 'done'
                ? 'No Japanese text was transcribed.'
                : 'Not transcribed yet.'}
            </p>
          )}
        </div>

        {/* Localized preview for the active language */}
        <div className="img-side">
          <div className="img-side__head">{langLabel}</div>
          {localizedSrc ? (
            <>
              <a
                className="img-side__frame"
                href={localizedSrc}
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  className="img-side__img"
                  src={localizedSrc}
                  alt={`${detail.key} (${langLabel})`}
                />
              </a>
              <div className="image-edit__source-tag">
                {t?.urlModel === 'manual'
                  ? 'manual override'
                  : (t?.urlModel ?? 'generated')}
                {t?.translatedAt && ` · ${formatLocalDate(t.translatedAt)}`}
              </div>
            </>
          ) : (
            <p className="img-side__note muted">
              No localized image yet — regenerate or upload one.
            </p>
          )}
          {t?.error && <p className="img-side__error">{t.error}</p>}
        </div>
      </div>

      {/* Language tabs */}
      <div className="article-edit__tabs" role="tablist">
        {detail.languages.map((l) => (
          <button
            key={l.code}
            type="button"
            role="tab"
            aria-selected={l.code === lang}
            className={l.code === lang ? 'is-active' : ''}
            title={l.label}
            onClick={() => {
              setLang(l.code);
              setStatus(null);
              setActionError(null);
            }}
          >
            {l.nativeLabel}
            {dirty[l.code] && <span className="article-edit__dot" />}
          </button>
        ))}
      </div>

      {/* Editor for the active language */}
      <section className="image-edit__panel">
        {spans.length === 0 ? (
          <p className="img-side__note muted">
            This image has no transcribed text to translate. You can still
            upload a localized version below.
          </p>
        ) : (
          <div className="image-edit__pairs">
            <div className="image-edit__pairs-head">
              <span>Japanese</span>
              <span>{langLabel}</span>
            </div>
            {spans.map((ja, i) => (
              <div className="image-edit__pair" key={i}>
                <div className="image-edit__ja" lang="ja">
                  {ja || <em className="muted">(empty)</em>}
                </div>
                <input
                  type="text"
                  value={pairs[lang]?.[i] ?? ''}
                  placeholder="translation…"
                  onChange={(e) => setSpan(lang, i, e.target.value)}
                />
              </div>
            ))}
          </div>
        )}

        <div className="image-edit__actions">
          {spans.length > 0 && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => save()}
                disabled={busy || !dirty[lang]}
              >
                {saving ? 'Saving…' : 'Save translations'}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={regenerate}
                disabled={busy}
              >
                {regenerating ? 'Regenerating…' : 'Regenerate with gpt-image-2'}
              </button>
            </>
          )}
          <span className="image-edit__upload">
            <input ref={fileRef} type="file" accept="image/*" disabled={busy} />
            <button
              type="button"
              className="btn"
              onClick={upload}
              disabled={busy}
            >
              {uploading ? 'Uploading…' : 'Upload image'}
            </button>
          </span>
        </div>

        {status && <p className="image-edit__status">{status}</p>}
        {actionError && <p className="img-side__error">{actionError}</p>}
      </section>
    </div>
  );
}
