import { useEffect, useRef, useState } from 'react';

import type { Block } from '@hiroba/richtext';
import CategoryDot from '@hiroba/ui/CategoryDot';
import { formatLocalDate } from '@hiroba/ui/format-date';

import {
  getArticle,
  updateArticleSource,
  updateArticleTranslation,
  type ArticleDetail,
  type ArticleKind,
} from '../lib/api';
import RtmlEditor, { type RtmlEditorHandle } from './editor/RtmlEditor';

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

  useEffect(() => {
    getArticle(kind, id)
      .then((a) => {
        setArticle(a);
        setTitleJa(a.titleJa);
        setTitleEn(a.en.title ?? '');
      })
      .catch((err) => {
        console.error(err);
        setLoadError('Failed to load article. Does it exist?');
      });
  }, [kind, id]);

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
          <p className="article-edit__empty">
            No body fetched yet — run the workflow from the list page first.
          </p>
        )}
        <div className="article-edit__save">
          <button
            type="button"
            onClick={saveJa}
            disabled={saving || !dirty.ja || !titleJa.trim()}
          >
            {saving ? 'Saving…' : 'Save Japanese'}
          </button>
        </div>
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
          <p className="article-edit__empty">
            No English translation yet — run the workflow from the list page to
            generate one, then edit it here.
          </p>
        )}
        <div className="article-edit__save">
          <button type="button" onClick={saveEn} disabled={saving || !dirty.en}>
            {saving ? 'Saving…' : 'Save English'}
          </button>
        </div>
      </section>

      {status && <p className="article-edit__status">{status}</p>}
    </div>
  );
}
