/**
 * renderBlocks — a minimal, unstyled HTML renderer for the block tree, for
 * inspecting parsed/translated content (the fantasy theme comes later). Text is
 * escaped; we emit our own tags from structured data, so this is safe against the
 * scraped source (unlike the news path's `set:html`).
 *
 * `opts.imageSrc` rewrites image/icon URLs (pass `rewriteImageSrc` to serve from
 * R2 — the bucket's public host in the web app; defaults to identity so images
 * load straight from the CDN during inspection).
 */

import {
  isInline,
  type Block,
  type ContentNode,
  type Inline,
  type TableCell,
} from './schema';

/**
 * A resolved image: the `src` every browser gets, plus what a `<picture>`
 * tag wants — the raster's pixel dimensions (emitted as width/height so the
 * browser reserves the box before the bytes arrive) and alternate encodings,
 * most-preferred first. When `sources` is non-empty the renderer emits a
 * `<picture><source type srcset>` wrapper so supporting browsers take the
 * smaller variant and everything else falls back to `src` — every entry must
 * actually exist (the web app only passes recorded `image_sources` rows;
 * `<source>` does NOT fall back on a 404).
 */
export type ResolvedImage = {
  src: string;
  width?: number;
  height?: number;
  sources?: Array<{ src: string; type: string }>;
};

export type RenderOptions = {
  /** Rewrites image/icon URLs; may also return dimensions and alternate
   *  encodings (see {@link ResolvedImage}). A plain string means "just a src". */
  imageSrc?: (src: string) => string | ResolvedImage;
  /**
   * Rewrites link/button/image `href`s (pass `rewriteArticleHref` to point
   * article cross-links at our own routes; defaults to identity).
   */
  linkHref?: (href: string) => string;
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');

export function renderBlocks(
  blocks: Block[],
  opts: RenderOptions = {},
): string {
  const rewrite = opts.imageSrc ?? ((s: string) => s);
  const resolve = (s: string): ResolvedImage => {
    const out = rewrite(s);
    return typeof out === 'string' ? { src: out } : out;
  };
  /** An <img> tag, wrapped in <picture> when alternate encodings exist. */
  const imgTag = (
    source: ResolvedImage,
    attrs: string,
    alt: string,
  ): string => {
    const dims =
      source.width && source.height
        ? ` width="${source.width}" height="${source.height}"`
        : '';
    const img = `<img ${attrs} src="${escAttr(source.src)}" alt="${escAttr(alt)}"${dims}>`;
    if (!source.sources?.length) return img;
    const alternates = source.sources
      .map(
        (s) => `<source type="${escAttr(s.type)}" srcset="${escAttr(s.src)}">`,
      )
      .join('');
    return `<picture>${alternates}${img}</picture>`;
  };
  const href = opts.linkHref ?? ((h: string) => h);

  const inlines = (nodes: Inline[]): string => nodes.map(inline).join('');
  const contents = (nodes: ContentNode[]): string =>
    nodes.map((n) => (isInline(n) ? inline(n) : block(n))).join('');
  const blocksHtml = (nodes: Block[]): string => nodes.map(block).join('');

  function inline(node: Inline): string {
    if (typeof node === 'string') return esc(node);
    switch (node.type) {
      case 'break':
        return '<br>';
      case 'strong':
        return `<strong>${inlines(node.children)}</strong>`;
      case 'emphasis':
        return `<em>${inlines(node.children)}</em>`;
      case 'color':
        return `<span style="color:${escAttr(node.value)}">${inlines(node.children)}</span>`;
      case 'link': {
        const rel = node.external
          ? ' target="_blank" rel="noopener noreferrer"'
          : '';
        return `<a href="${escAttr(href(node.href))}"${rel}>${inlines(node.children)}</a>`;
      }
      case 'badge':
        return `<span class="rt-badge"${node.variant ? ` data-variant="${escAttr(node.variant)}"` : ''}>${esc(node.text)}</span>`;
      case 'icon':
        return imgTag(resolve(node.src), `class="rt-icon"`, node.alt ?? '');
      case 'time':
        // Children are the human-readable JST text; a client script rewrites
        // datetime-bearing ones to the viewer's timezone (date-only values stay).
        return `<time class="rt-time" datetime="${escAttr(node.datetime)}">${inlines(node.children)}</time>`;
      case 'event': {
        const end = node.end ? ` data-event-end="${escAttr(node.end)}"` : '';
        return `<span class="rt-event" data-event-id="${escAttr(node.id)}" data-event-start="${escAttr(node.start)}"${end}>${inlines(node.children)}</span>`;
      }
    }
  }

  function cell(c: TableCell): string {
    const tag = c.header ? 'th' : 'td';
    const cs = c.colSpan ? ` colspan="${c.colSpan}"` : '';
    const rs = c.rowSpan ? ` rowspan="${c.rowSpan}"` : '';
    return `<${tag}${cs}${rs}>${contents(c.children)}</${tag}>`;
  }

  function block(node: Block): string {
    switch (node.type) {
      case 'paragraph': {
        const style =
          node.align && node.align !== 'left'
            ? ` style="text-align:${node.align}"`
            : '';
        return `<p${style}>${inlines(node.children)}</p>`;
      }
      case 'heading': {
        // The anchor id makes `#<anchor>` scroll to this section (source jump target).
        const id = node.anchor ? ` id="${escAttr(node.anchor)}"` : '';
        const cls = node.variant ? ` class="rt-h-${node.variant}"` : '';
        return `<h${node.level}${id}${cls}>${inlines(node.children)}</h${node.level}>`;
      }
      case 'button':
        return `<a class="rt-button"${node.variant ? ` data-variant="${escAttr(node.variant)}"` : ''} href="${escAttr(href(node.href))}">${inlines(node.children)}</a>`;
      case 'divider':
        return '<hr>';
      case 'image': {
        // The in-image text (localized into the image itself) rides as alt for
        // accessibility; hydrate `text` with the displayed language's spans.
        const alt = node.text?.length ? node.text.join(' ') : (node.alt ?? '');
        const img = imgTag(
          resolve(node.src),
          `class="rt-image"${node.variant ? ` data-variant="${escAttr(node.variant)}"` : ''}`,
          alt,
        );
        const rel = node.external
          ? ' target="_blank" rel="noopener noreferrer"'
          : '';
        const media = node.href
          ? `<a class="rt-image-link" href="${escAttr(href(node.href))}"${rel}>${img}</a>`
          : img;
        if (!node.caption) return media;
        // A captioned image is a <figure> so the image and its <figcaption>
        // center and wrap together as one unit.
        return `<figure class="rt-figure">${media}<figcaption class="rt-caption">${inlines(node.caption)}</figcaption></figure>`;
      }
      case 'video': {
        const media = `<div class="rt-video"><iframe src="${escAttr(node.src)}" allowfullscreen loading="lazy"></iframe></div>`;
        if (!node.caption) return media;
        // Same figure treatment as a captioned image, so the embed and its
        // <figcaption> center and wrap together as one unit.
        return `<figure class="rt-figure">${media}<figcaption class="rt-caption">${inlines(node.caption)}</figcaption></figure>`;
      }
      case 'embed':
        return `<div class="rt-embed" data-provider="${escAttr(node.provider)}"${node.variant ? ` data-variant="${escAttr(node.variant)}"` : ''}>${node.content ? esc(node.content) : ''}</div>`;
      case 'infoBox':
        // A table of contents is navigation, not a decorative aside.
        if (node.variant === 'toc')
          return `<nav class="rt-toc" aria-label="Contents">${contents(node.children)}</nav>`;
        return `<div class="rt-infobox" data-variant="${escAttr(node.variant)}">${contents(node.children)}</div>`;
      case 'section':
        return (
          `<section class="rt-section"${node.variant ? ` data-variant="${escAttr(node.variant)}"` : ''}>` +
          (node.title
            ? `<div class="rt-section-title">${inlines(node.title)}</div>`
            : '') +
          (node.dateline
            ? `<div class="rt-dateline">${inlines(node.dateline)}</div>`
            : '') +
          `${contents(node.children)}</section>`
        );
      case 'accordion':
        return `<details class="rt-accordion"><summary>${inlines(node.summary)}</summary>${contents(node.children)}</details>`;
      case 'speechBubble':
        return (
          `<div class="rt-speech">` +
          (node.icon
            ? imgTag(resolve(node.icon), `class="rt-speech-icon"`, '')
            : '') +
          (node.speaker !== undefined
            ? `<div class="rt-speaker">${esc(node.speaker)}</div>`
            : '') +
          `<div class="rt-speech-body">${contents(node.children)}</div></div>`
        );
      case 'messageBox':
        return (
          `<div class="rt-message">` +
          (node.name !== undefined
            ? `<div class="rt-name">${esc(node.name)}</div>`
            : '') +
          (node.role !== undefined
            ? `<div class="rt-role">${esc(node.role)}</div>`
            : '') +
          `<div class="rt-message-body">${contents(node.children)}</div></div>`
        );
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        const cls = node.variant ? ` class="rt-list-${node.variant}"` : '';
        return `<${tag}${cls}>${node.items.map((it) => `<li>${contents(it.children)}</li>`).join('')}</${tag}>`;
      }
      case 'table': {
        const head = node.headers
          ? `<thead><tr>${node.headers.map(cell).join('')}</tr></thead>`
          : '';
        const body = `<tbody>${node.rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('')}</tbody>`;
        return `<table class="rt-table"${node.variant ? ` data-variant="${escAttr(node.variant)}"` : ''}>${head}${body}</table>`;
      }
      case 'interview': {
        const head =
          (node.title
            ? `<div class="rt-interview-title">${esc(node.title)}</div>`
            : '') +
          (node.writer
            ? `<div class="rt-writer">${esc(node.writer)}</div>`
            : '');
        const qas = node.exchanges
          .map(
            (e) =>
              `<div class="rt-qa"><div class="rt-q">${inlines(e.question)}</div><div class="rt-a">${blocksHtml(e.answer)}</div></div>`,
          )
          .join('');
        return `<div class="rt-interview">${head}${qas}</div>`;
      }
      case 'steps':
        return `<ol class="rt-steps"${node.variant ? ` data-variant="${escAttr(node.variant)}"` : ''}>${node.items.map((s) => `<li${s.n ? ` value="${s.n}"` : ''}>${blocksHtml(s.children)}</li>`).join('')}</ol>`;
      case 'ranking':
        return `<ol class="rt-ranking"${node.variant ? ` data-variant="${escAttr(node.variant)}"` : ''}>${node.items
          .map(
            (i) =>
              `<li value="${i.rank}"><span class="rt-rank-title">${inlines(i.title)}</span>${i.count ? `<span class="rt-rank-count">${esc(i.count)}</span>` : ''}</li>`,
          )
          .join('')}</ol>`;
    }
  }

  return blocksHtml(blocks);
}
