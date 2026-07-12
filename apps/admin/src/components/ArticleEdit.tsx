import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { imageKey, rewriteImageSrc, type Block } from '@hiroba/richtext';
import { isRunActive, type WorkflowRunEntry } from '@hiroba/shared';
import CategoryDot from '@hiroba/ui/CategoryDot';
import { formatLocalDate } from '@hiroba/ui/format-date';

import {
  getArticle,
  getWorkflowRuns,
  triggerArticleWorkflow,
  updateArticleSource,
  updateArticleTranslation,
  type ArticleDetail,
  type ArticleKind,
} from '../lib/api';
import { getPrimaryLanguage } from '../lib/primary-language';
import RtmlEditor, { type RtmlEditorHandle } from './editor/RtmlEditor';
import RunCard from './RunCard';

const RUN_POLL_MS = 2500;

/** The Japanese source tab — every enabled language code is a tab alongside it. */
const SOURCE_TAB = 'ja';

type Props = {
  kind: ArticleKind;
  id: string;
};

function hirobaUrl(kind: ArticleKind, id: string): string {
  return kind === 'topic'
    ? `https://hiroba.dqx.jp/sc/topics/detail/${id}/`
    : kind === 'playguide'
      ? `https://hiroba.dqx.jp/sc/public/playguide/${id}`
      : `https://hiroba.dqx.jp/sc/news/detail/${id}`;
}

export default function ArticleEdit({ kind, id }: Props) {
  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Active tab: SOURCE_TAB or an enabled language code. Defaults to the sidebar's
  // primary target language once the article loads (if that language is enabled);
  // `didInitTab` keeps that a one-time default so it never fights a manual switch.
  const [tab, setTab] = useState<string>(SOURCE_TAB);
  const didInitTab = useRef(false);

  // Title text + dirty flag, keyed by tab (SOURCE_TAB and each language code).
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // One editor handle per tab, populated by stable per-key callback refs so the
  // save handlers can pull each tab's edited tree out on demand.
  const editorHandles = useRef<Record<string, RtmlEditorHandle | null>>({});
  const refSetters = useRef<
    Record<string, (h: RtmlEditorHandle | null) => void>
  >({});
  function handleRef(key: string) {
    if (!refSetters.current[key]) {
      refSetters.current[key] = (h) => {
        editorHandles.current[key] = h;
      };
    }
    return refSetters.current[key];
  }

  // Workflow tracking (for the empty states' "Run Workflow" button).
  const [run, setRun] = useState<WorkflowRunEntry | null>(null);
  const [trackingRun, setTrackingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // Accept settled runs only if they started after our trigger — the registry
  // keeps yesterday's settled runs, which must not end tracking instantly.
  const minStartMs = useRef<number | null>(null);

  // Refs mirror the dirty state so async reloads never clobber edits.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const loadArticle = useCallback(
    async (opts: { keepDirtyTitles?: boolean } = {}) => {
      const a = await getArticle(kind, id);
      setArticle(a);
      setTitles((prev) => {
        const next = { ...prev };
        if (!opts.keepDirtyTitles || !dirtyRef.current[SOURCE_TAB]) {
          next[SOURCE_TAB] = a.titleJa;
        }
        for (const lang of a.languages) {
          if (!opts.keepDirtyTitles || !dirtyRef.current[lang.code]) {
            next[lang.code] = a.translations[lang.code]?.title ?? '';
          }
        }
        return next;
      });
      return a;
    },
    [kind, id],
  );

  useEffect(() => {
    loadArticle()
      .then((a) => {
        // Open on the primary target language's tab when it's one of this
        // article's enabled languages — otherwise stay on the source tab.
        if (!didInitTab.current) {
          didInitTab.current = true;
          const primary = getPrimaryLanguage();
          if (a.languages.some((l) => l.code === primary)) {
            setTab(primary);
          }
        }

        // If the pipeline is already running for this article (e.g. triggered
        // from the list page), pick it up and track it.
        const anyUntranslated = a.languages.some(
          (l) => !a.translations[l.code]?.blocks,
        );
        if (!a.blocksJa || anyUntranslated) {
          getWorkflowRuns()
            .then(({ runs }) => {
              const active = runs.find(
                (r) =>
                  r.itemType === kind &&
                  r.itemId === id &&
                  isRunActive(r.status),
              );
              if (active) {
                setRun(active);
                setTrackingRun(true);
              }
            })
            .catch(() => {});
        }
      })
      .catch((err) => {
        console.error(err);
        setLoadError('Failed to load article. Does it exist?');
      });
  }, [kind, id, loadArticle]);

  async function runWorkflow() {
    setRunError(null);
    setRun(null);
    try {
      // Small skew allowance: the run's startedAt is stamped server-side.
      minStartMs.current = Date.now() - 60_000;
      await triggerArticleWorkflow(kind, id);
      setTrackingRun(true);
    } catch (err) {
      console.error(err);
      setRunError('Failed to start the workflow. Check console.');
    }
  }

  useEffect(() => {
    if (!trackingRun) return;
    let cancelled = false;

    async function poll() {
      if (document.hidden) return;
      try {
        const { runs } = await getWorkflowRuns();
        if (cancelled) return;
        const mine = runs
          .filter((r) => r.itemType === kind && r.itemId === id)
          .filter(
            (r) =>
              isRunActive(r.status) ||
              minStartMs.current === null ||
              Date.parse(r.startedAt) >= minStartMs.current,
          )
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (!mine) return; // registry may lag right after the trigger
        setRun(mine);
        if (!isRunActive(mine.status)) {
          setTrackingRun(false);
          if (mine.status === 'complete') {
            await loadArticle({ keepDirtyTitles: true });
            if (!cancelled) setRun(null);
          }
        }
      } catch (err) {
        console.error(err);
      }
    }

    poll();
    const timer = setInterval(poll, RUN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [trackingRun, kind, id, loadArticle]);

  function markDirty(key: string) {
    setDirty((d) => (d[key] ? d : { ...d, [key]: true }));
    setStatus(null);
  }

  function markClean(key: string) {
    setDirty((d) => ({ ...d, [key]: false }));
  }

  function setTitle(key: string, value: string) {
    setTitles((t) => ({ ...t, [key]: value }));
    markDirty(key);
  }

  async function saveJa() {
    if (!article) return;
    const titleJa = titles[SOURCE_TAB] ?? '';
    setSaving(true);
    setStatus(null);
    try {
      const patch: { titleJa: string; blocksJa?: Block[] } = { titleJa };
      const handle = editorHandles.current[SOURCE_TAB];
      if (article.blocksJa && handle) {
        patch.blocksJa = handle.getBlocks();
      }
      await updateArticleSource(kind, id, patch);
      markClean(SOURCE_TAB);
      setStatus('Japanese source saved.');
    } catch (err) {
      console.error(err);
      setStatus('Save failed. Check console.');
    }
    setSaving(false);
  }

  async function saveTranslation(lang: string) {
    if (!article) return;
    const label = article.languages.find((l) => l.code === lang)?.label ?? lang;
    const title = (titles[lang] ?? '').trim();
    setSaving(true);
    setStatus(null);
    try {
      const patch: { title?: string; blocks?: Block[] } = {};
      if (title) patch.title = title;
      const handle = editorHandles.current[lang];
      if (article.translations[lang]?.blocks && handle) {
        patch.blocks = handle.getBlocks();
      }
      if (!patch.title && !patch.blocks) {
        setStatus(`Nothing to save for ${label} yet.`);
        setSaving(false);
        return;
      }
      await updateArticleTranslation(kind, id, lang, patch);
      markClean(lang);
      setStatus(`${label} translation saved.`);
    } catch (err) {
      console.error(err);
      setStatus('Save failed. Check console.');
    }
    setSaving(false);
  }

  // One image-URL rewriter per tab: the Japanese source and each language serve
  // originals from our own /img route; a language additionally swaps in its
  // localized raster (`/img/l10n/<lang>/<key>`) for every image it localized.
  const imageSrcByTab = useMemo<Record<string, (src: string) => string>>(() => {
    const map: Record<string, (src: string) => string> = {
      [SOURCE_TAB]: (src) => rewriteImageSrc(src, '/img'),
    };
    for (const lang of article?.languages ?? []) {
      const localized = new Set(
        article?.translations[lang.code]?.localizedImageKeys ?? [],
      );
      map[lang.code] = (src) => {
        const key = imageKey(src);
        const base =
          key && localized.has(key) ? `/img/l10n/${lang.code}` : '/img';
        return rewriteImageSrc(src, base);
      };
    }
    return map;
  }, [article]);

  if (loadError) {
    return <p className="error">{loadError}</p>;
  }
  if (!article) {
    return <p className="loading">Loading…</p>;
  }

  const listHref =
    kind === 'topic'
      ? '/topics'
      : kind === 'playguide'
        ? '/playguide'
        : '/news';
  const activeTranslatedAt =
    tab !== SOURCE_TAB ? article.translations[tab]?.translatedAt : null;

  // Empty-state body: while a run is tracked its live card shows here; once
  // it completes, loadArticle() swaps in the editor. A settled failure keeps
  // the card visible (diagnostics) with the button offered as a retry.
  const emptyState = (message: string) => (
    <>
      {run && <RunCard run={run} />}
      {trackingRun && !run && (
        <p className="article-edit__empty">Starting workflow…</p>
      )}
      {!trackingRun && (
        <div className="article-edit__empty">
          <p>{message}</p>
          <button type="button" onClick={runWorkflow}>
            {run ? 'Retry Workflow' : 'Run Workflow'}
          </button>
          {runError && <p className="article-edit__run-error">{runError}</p>}
        </div>
      )}
    </>
  );

  return (
    <div className="article-edit">
      <div className="article-edit__meta">
        <a href={listHref}>← Back to list</a>
        {article.category && (
          <span className={`category-badge ${article.category}`}>
            <CategoryDot category={article.category} />
            {article.category}
          </span>
        )}
        {article.publishedAt && (
          <span>{formatLocalDate(article.publishedAt)}</span>
        )}
        <a href={hirobaUrl(kind, id)} target="_blank" rel="noopener noreferrer">
          View original on Hiroba ↗
        </a>
        {activeTranslatedAt && (
          <span className="article-edit__translated-at">
            translated {formatLocalDate(activeTranslatedAt)}
          </span>
        )}
      </div>

      <div className="article-edit__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === SOURCE_TAB}
          className={tab === SOURCE_TAB ? 'is-active' : ''}
          onClick={() => setTab(SOURCE_TAB)}
        >
          日本語 (source)
          {dirty[SOURCE_TAB] && <span className="article-edit__dot" />}
        </button>
        {article.languages.map((lang) => (
          <button
            key={lang.code}
            type="button"
            role="tab"
            aria-selected={tab === lang.code}
            className={tab === lang.code ? 'is-active' : ''}
            title={lang.label}
            onClick={() => setTab(lang.code)}
          >
            {lang.nativeLabel}
            {dirty[lang.code] && <span className="article-edit__dot" />}
          </button>
        ))}
        <span className="article-edit__actions">
          {status && <span className="article-edit__status">{status}</span>}
          <button
            type="button"
            className="article-edit__save"
            onClick={tab === SOURCE_TAB ? saveJa : () => saveTranslation(tab)}
            disabled={
              saving ||
              !dirty[tab] ||
              (tab === SOURCE_TAB && !(titles[SOURCE_TAB] ?? '').trim())
            }
          >
            {saving
              ? 'Saving…'
              : tab === SOURCE_TAB
                ? 'Save Japanese'
                : `Save ${article.languages.find((l) => l.code === tab)?.nativeLabel ?? tab}`}
          </button>
        </span>
      </div>

      <section className="article-edit__panel" hidden={tab !== SOURCE_TAB}>
        <label className="article-edit__title">
          Title (Japanese)
          <input
            type="text"
            value={titles[SOURCE_TAB] ?? ''}
            onChange={(e) => setTitle(SOURCE_TAB, e.target.value)}
          />
        </label>
        {article.blocksJa ? (
          <RtmlEditor
            ref={handleRef(SOURCE_TAB)}
            initialBlocks={article.blocksJa as Block[]}
            imageSrc={imageSrcByTab[SOURCE_TAB]}
            onDirty={() => markDirty(SOURCE_TAB)}
          />
        ) : (
          emptyState('No body fetched yet — run the workflow to fetch it.')
        )}
      </section>

      {article.languages.map((lang) => {
        const translation = article.translations[lang.code];
        return (
          <section
            key={lang.code}
            className="article-edit__panel"
            hidden={tab !== lang.code}
          >
            <label className="article-edit__title">
              Title ({lang.label})
              <input
                type="text"
                value={titles[lang.code] ?? ''}
                onChange={(e) => setTitle(lang.code, e.target.value)}
                placeholder={
                  translation?.title ? undefined : 'Not translated yet'
                }
              />
            </label>
            {translation?.blocks ? (
              <RtmlEditor
                ref={handleRef(lang.code)}
                initialBlocks={translation.blocks as Block[]}
                imageSrc={imageSrcByTab[lang.code]}
                onDirty={() => markDirty(lang.code)}
              />
            ) : (
              emptyState(
                `No ${lang.label} translation yet — run the workflow to generate one.`,
              )
            )}
          </section>
        );
      })}
    </div>
  );
}
