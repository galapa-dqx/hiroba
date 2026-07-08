import { useCallback, useEffect, useRef, useState } from 'react';

import type { Block } from '@hiroba/richtext';
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
import RtmlEditor, { type RtmlEditorHandle } from './editor/RtmlEditor';
import RunCard from './RunCard';

const RUN_POLL_MS = 2500;

type Props = {
  kind: ArticleKind;
  id: string;
};

type Lang = 'ja' | 'en';

function hirobaUrl(kind: ArticleKind, id: string): string {
  return kind === 'topic'
    ? `https://hiroba.dqx.jp/sc/topics/detail/${id}/`
    : `https://hiroba.dqx.jp/sc/news/detail/${id}`;
}

export default function ArticleEdit({ kind, id }: Props) {
  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Lang>('ja');

  const [titleJa, setTitleJa] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [dirty, setDirty] = useState<Record<Lang, boolean>>({
    ja: false,
    en: false,
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const jaEditor = useRef<RtmlEditorHandle>(null);
  const enEditor = useRef<RtmlEditorHandle>(null);

  // Workflow tracking (for the empty states' "Run Workflow" button).
  const [run, setRun] = useState<WorkflowRunEntry | null>(null);
  const [trackingRun, setTrackingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // Accept settled runs only if they started after our trigger — the registry
  // keeps yesterday's settled runs, which must not end tracking instantly.
  const minStartMs = useRef<number | null>(null);

  // Refs mirror the dirty/title state so async reloads never clobber edits.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const loadArticle = useCallback(
    async (opts: { keepDirtyTitles?: boolean } = {}) => {
      const a = await getArticle(kind, id);
      setArticle(a);
      if (!opts.keepDirtyTitles || !dirtyRef.current.ja) setTitleJa(a.titleJa);
      if (!opts.keepDirtyTitles || !dirtyRef.current.en) {
        setTitleEn(a.en.title ?? '');
      }
      return a;
    },
    [kind, id],
  );

  useEffect(() => {
    loadArticle()
      .then((a) => {
        // If the pipeline is already running for this article (e.g. triggered
        // from the list page), pick it up and track it.
        if (!a.blocksJa || !a.en.blocks) {
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

  function markDirty(lang: Lang) {
    setDirty((d) => (d[lang] ? d : { ...d, [lang]: true }));
    setStatus(null);
  }

  function markClean(lang: Lang) {
    setDirty((d) => ({ ...d, [lang]: false }));
  }

  async function saveJa() {
    if (!article) return;
    setSaving(true);
    setStatus(null);
    try {
      const patch: { titleJa: string; blocksJa?: Block[] } = { titleJa };
      if (article.blocksJa && jaEditor.current) {
        patch.blocksJa = jaEditor.current.getBlocks();
      }
      await updateArticleSource(kind, id, patch);
      markClean('ja');
      setStatus('Japanese source saved.');
    } catch (err) {
      console.error(err);
      setStatus('Save failed. Check console.');
    }
    setSaving(false);
  }

  async function saveEn() {
    if (!article) return;
    setSaving(true);
    setStatus(null);
    try {
      const patch: { title?: string; blocks?: Block[] } = {};
      if (titleEn.trim()) patch.title = titleEn;
      if (article.en.blocks && enEditor.current) {
        patch.blocks = enEditor.current.getBlocks();
      }
      if (!patch.title && !patch.blocks) {
        setStatus('Nothing to save for English yet.');
        setSaving(false);
        return;
      }
      await updateArticleTranslation(kind, id, 'en', patch);
      markClean('en');
      setStatus('English translation saved.');
    } catch (err) {
      console.error(err);
      setStatus('Save failed. Check console.');
    }
    setSaving(false);
  }

  if (loadError) {
    return <p className="error">{loadError}</p>;
  }
  if (!article) {
    return <p className="loading">Loading…</p>;
  }

  const listHref = kind === 'topic' ? '/topics' : '/news';

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
        <span>{formatLocalDate(article.publishedAt)}</span>
        <a href={hirobaUrl(kind, id)} target="_blank" rel="noopener noreferrer">
          View original on Hiroba ↗
        </a>
        {article.en.translatedAt && (
          <span className="article-edit__translated-at">
            translated {formatLocalDate(article.en.translatedAt)}
          </span>
        )}
      </div>

      <div className="article-edit__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ja'}
          className={tab === 'ja' ? 'is-active' : ''}
          onClick={() => setTab('ja')}
        >
          日本語 (source){dirty.ja && <span className="article-edit__dot" />}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'en'}
          className={tab === 'en' ? 'is-active' : ''}
          onClick={() => setTab('en')}
        >
          English{dirty.en && <span className="article-edit__dot" />}
        </button>
        <span className="article-edit__actions">
          {status && <span className="article-edit__status">{status}</span>}
          <button
            type="button"
            className="article-edit__save"
            onClick={tab === 'ja' ? saveJa : saveEn}
            disabled={
              saving || !dirty[tab] || (tab === 'ja' && !titleJa.trim())
            }
          >
            {saving
              ? 'Saving…'
              : tab === 'ja'
                ? 'Save Japanese'
                : 'Save English'}
          </button>
        </span>
      </div>

      <section className="article-edit__panel" hidden={tab !== 'ja'}>
        <label className="article-edit__title">
          Title (Japanese)
          <input
            type="text"
            value={titleJa}
            onChange={(e) => {
              setTitleJa(e.target.value);
              markDirty('ja');
            }}
          />
        </label>
        {article.blocksJa ? (
          <RtmlEditor
            ref={jaEditor}
            initialBlocks={article.blocksJa as Block[]}
            onDirty={() => markDirty('ja')}
          />
        ) : (
          emptyState('No body fetched yet — run the workflow to fetch it.')
        )}
      </section>

      <section className="article-edit__panel" hidden={tab !== 'en'}>
        <label className="article-edit__title">
          Title (English)
          <input
            type="text"
            value={titleEn}
            onChange={(e) => {
              setTitleEn(e.target.value);
              markDirty('en');
            }}
            placeholder={article.en.title ? undefined : 'Not translated yet'}
          />
        </label>
        {article.en.blocks ? (
          <RtmlEditor
            ref={enEditor}
            initialBlocks={article.en.blocks as Block[]}
            onDirty={() => markDirty('en')}
          />
        ) : (
          emptyState(
            'No English translation yet — run the workflow to generate one.',
          )
        )}
      </section>
    </div>
  );
}
