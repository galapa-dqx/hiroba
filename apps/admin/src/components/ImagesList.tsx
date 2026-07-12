/**
 * ImagesList — the admin Images screen. Lists every stored image alongside its
 * translated equivalent for the primary target language, side by side:
 *
 *   • Left  — the mirrored source image + its transcribed Japanese spans.
 *   • Right — the localized image + translated spans once localization is done;
 *             for an in-progress (or not-yet-started) image, the pipeline step
 *             it's currently on; for a text-free image, a "nothing to localize"
 *             note.
 *
 * The language follows the sidebar's primary-language selector (see
 * ../lib/primary-language); changing it re-fetches from the top.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { PhaseState } from '@hiroba/shared';

import { getImages, getLanguages, type AdminImage } from '../lib/api';
import {
  getPrimaryLanguage,
  subscribePrimaryLanguage,
} from '../lib/primary-language';

const PAGE_SIZE = 24;

/**
 * Image source categories the screen can filter to. Only `banner` is a
 * first-class join today (banners.imageKey = images.key); topic/playguide
 * membership lives inside article block trees and isn't tagged yet, so those
 * aren't offered here. `all` is the unfiltered default.
 */
const SOURCE_FILTERS = [
  { key: 'all', label: 'All sources' },
  { key: 'banner', label: 'Banners' },
] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number]['key'];

type Step = { key: string; label: string; state: PhaseState };

/** The ordered pipeline steps for an image, with the current language's states. */
function imageSteps(img: AdminImage): Step[] {
  const steps: Step[] = [
    { key: 'mirror', label: 'Mirror', state: img.mirrorState },
    { key: 'transcribe', label: 'Transcribe', state: img.transcribeState },
  ];
  // Only text-bearing images are translated + localized.
  if (img.hasText) {
    steps.push(
      {
        key: 'text',
        label: 'Translate text',
        state: img.translation.textState ?? 'pending',
      },
      {
        key: 'url',
        label: 'Localize image',
        state: img.translation.urlState ?? 'pending',
      },
    );
  }
  return steps;
}

function StepGlyph({
  state,
  current,
}: {
  state: PhaseState;
  current: boolean;
}) {
  if (state === 'running' || (current && state === 'pending'))
    return <span className="wf-spinner" aria-label="in progress" />;
  const glyph = { done: '✓', failed: '✕', pending: '·', running: '' }[state];
  return (
    <span className="wf-glyph" aria-hidden="true">
      {glyph}
    </span>
  );
}

/** The in-progress / not-yet-localized right column: which step it's on. */
function StepList({ img }: { img: AdminImage }) {
  const steps = imageSteps(img);
  const currentIdx = steps.findIndex((s) => s.state !== 'done');
  return (
    <ul className="wf-substeps img-side__steps">
      {steps.map((s, i) => (
        <li key={s.key} className={`is-${s.state}`}>
          <StepGlyph state={s.state} current={i === currentIdx} />
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

function Spans({ spans, lang }: { spans: string[]; lang?: string }) {
  const visible = spans.filter((s) => s.trim() !== '');
  if (visible.length === 0) return null;
  return (
    <ul className="img-side__spans" lang={lang}>
      {visible.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

function ImageRow({ img, langLabel }: { img: AdminImage; langLabel: string }) {
  const { translation: t } = img;
  const localized = t.urlState === 'done' && t.localizedKey;
  const settledNoText = img.transcribeState === 'done' && !img.hasText;

  return (
    <article className="img-row">
      <div className="img-side">
        <div className="img-side__head">Source · 日本語</div>
        <a
          className="img-side__frame"
          href={`/img/${img.key}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            className="img-side__img"
            src={`/img/${img.key}`}
            alt={img.key}
            loading="lazy"
          />
        </a>
        {img.textsJa ? (
          <Spans spans={img.textsJa} lang="ja" />
        ) : (
          <p className="img-side__note muted">Not transcribed yet.</p>
        )}
        <div className="img-side__key" title={img.key}>
          {img.key}
        </div>
      </div>

      <div className="img-side">
        <div className="img-side__head">
          <span>{langLabel}</span>
          <a className="img-side__edit" href={`/images/${img.id}`}>
            Edit ↗
          </a>
        </div>
        {localized ? (
          <>
            <a
              className="img-side__frame"
              href={`/img/${t.localizedKey}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                className="img-side__img"
                src={`/img/${t.localizedKey}`}
                alt={`${img.key} (${langLabel})`}
                loading="lazy"
              />
            </a>
            {t.texts && <Spans spans={t.texts} />}
          </>
        ) : settledNoText ? (
          <p className="img-side__note muted">
            No Japanese text — nothing to localize.
          </p>
        ) : (
          <>
            <StepList img={img} />
            {t.texts && <Spans spans={t.texts} />}
            {t.error && <p className="img-side__error">{t.error}</p>}
          </>
        )}
      </div>
    </article>
  );
}

export default function ImagesList() {
  const [lang, setLang] = useState('en');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [items, setItems] = useState<AdminImage[]>([]);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyText, setOnlyText] = useState(false);
  const [source, setSource] = useState<SourceFilter>('all');

  // A token so a slow in-flight request for an old language can't clobber a
  // newer one's results.
  const reqRef = useRef(0);

  // Follow the sidebar's primary-language selector.
  useEffect(() => {
    setLang(getPrimaryLanguage());
    return subscribePrimaryLanguage(setLang);
  }, []);

  // Resolve native labels for the active-language column heading.
  useEffect(() => {
    getLanguages()
      .then(({ languages }) =>
        setLabels(
          Object.fromEntries(languages.map((l) => [l.code, l.nativeLabel])),
        ),
      )
      .catch((err) => console.error(err));
  }, []);

  const load = useCallback(
    async (nextCursor: number | undefined) => {
      const token = ++reqRef.current;
      const first = nextCursor === undefined;
      if (first) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const res = await getImages({
          lang,
          limit: PAGE_SIZE,
          cursor: nextCursor,
          onlyText,
          source: source === 'all' ? undefined : source,
        });
        if (token !== reqRef.current) return; // superseded
        setItems((prev) => (first ? res.items : [...prev, ...res.items]));
        setHasMore(res.hasMore);
        setCursor(res.nextCursor);
      } catch (err) {
        if (token !== reqRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load images');
      } finally {
        if (token === reqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [lang, onlyText, source],
  );

  // (Re)load from the top whenever the language or a filter changes.
  useEffect(() => {
    load(undefined);
  }, [load]);

  const langLabel = labels[lang] ?? lang;
  // Filtering is server-side (see getImages); `items` is already the matching
  // set for the loaded pages.
  const shown = items;

  return (
    <div className="images-list">
      <div className="filters">
        <div className="img-source-filter" role="group" aria-label="Source">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`img-source-filter__btn${
                source === f.key ? ' is-active' : ''
              }`}
              aria-pressed={source === f.key}
              onClick={() => setSource(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label>
          <input
            type="checkbox"
            checked={onlyText}
            onChange={(e) => setOnlyText(e.target.checked)}
          />
          Only images with text
        </label>
        <span className="count">
          Viewing <strong>{langLabel}</strong> · {shown.length} shown
        </span>
      </div>

      {error && <div className="error-state">{error}</div>}

      {loading ? (
        <p className="loading">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="empty-state">
          {source === 'banner' && onlyText
            ? 'No banner images with Japanese text.'
            : source === 'banner'
              ? 'No banner images.'
              : onlyText
                ? 'No images with Japanese text.'
                : 'No images stored yet.'}
        </div>
      ) : (
        <div className="img-grid">
          {shown.map((img) => (
            <ImageRow key={img.id} img={img} langLabel={langLabel} />
          ))}
        </div>
      )}

      {hasMore && !loading && (
        <div className="page-actions">
          <button
            className="btn"
            onClick={() => load(cursor)}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
