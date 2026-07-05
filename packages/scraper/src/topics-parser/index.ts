/**
 * Topics body parser — ports prescraper's transformer.js + extractors to Cheerio,
 * targeting the @hiroba/richtext nested Block/Inline model.
 *
 * The old parser flattened inline formatting to strings; this one keeps it (see
 * ./inline). The extractor selectors and priority order (compound boxes first,
 * generic paragraph/image last) are preserved — that's the real domain knowledge
 * about the 2005-era source markup. `parseFlow` is the shared recursion: it groups
 * runs of inline content into paragraphs and dispatches block elements to the
 * priority-ordered extractor registry.
 */

import { load, type CheerioAPI } from 'cheerio';
import { isTag, isText, type AnyNode, type Element } from 'domhandler';

import type {
  Align,
  Block,
  ContentNode,
  InfoBoxVariant,
  Inline,
  RankingItem,
  StepItem,
  TableCell,
} from '@hiroba/richtext';

import { absolutize, isInlineIcon, parseInline, textOf } from './inline';

type Ctx = {
  $: CheerioAPI;
  processed: Set<Element>;
};

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

const cls = (el: Element): string => el.attribs?.class ?? '';
const nm = (el: Element): string => el.name?.toLowerCase() ?? '';
const attr = (el: Element, n: string): string | undefined => el.attribs?.[n];
const elChildren = (el: Element): Element[] =>
  (el.children ?? []).filter(isTag);
const q = (ctx: Ctx, el: Element, sel: string): Element | undefined =>
  ctx.$(el).find(sel).first()[0] as Element | undefined;
const qa = (ctx: Ctx, el: Element, sel: string): Element[] =>
  ctx.$(el).find(sel).toArray() as Element[];
const textTrim = (el: Element): string => textOf(el).trim();
const hasText = (el: Element): boolean =>
  textOf(el).replace(/[\s\u3000]+/g, '') !== '';

const BLOCK_TAGS = new Set([
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'section',
  'article',
]);
const INLINE_TAGS = new Set([
  'a',
  'b',
  'strong',
  'em',
  'i',
  'u',
  's',
  'small',
  'sup',
  'sub',
  'span',
  'font',
  'br',
  'mark',
  'ins',
  'del',
  'big',
  'tt',
  'code',
  'img', // routed inline only when it's a small icon (findBlockExtractor claims content images first)
]);

/** True if an inline run carries real content (not just spacing breaks/whitespace). */
const meaningfulInline = (nodes: Inline[]): boolean =>
  nodes.some((n) =>
    typeof n === 'string' ? n.trim() !== '' : n.type !== 'break',
  );

const hasBlockChildren = (el: Element): boolean =>
  elChildren(el).some((c) => BLOCK_TAGS.has(nm(c)));
const hasDirectText = (el: Element): boolean =>
  (el.children ?? []).some((c) => isText(c) && c.data.trim() !== '');

/** A full (non-icon) image, which is block-level even when it sits inside a <p>. */
const isContentImage = (el: Element): boolean =>
  nm(el) === 'img' && !isInlineIcon(el);
/** Does the subtree carry block media (a content image or an iframe) needing block extraction? */
const hasBlockMedia = (el: Element): boolean =>
  hasDescendant(el, (c) => isContentImage(c) || nm(c) === 'iframe');

function shouldSkip(el: Element): boolean {
  const name = nm(el);
  if (['br', 'hr', 'script', 'style', 'link', 'meta'].includes(name))
    return true;
  if (name === 'img' || name === 'iframe') return false;
  // Empty: no text, no media.
  if (
    !hasText(el) &&
    !el.children?.some(
      (c) => isTag(c) && (nm(c) === 'img' || nm(c) === 'iframe'),
    )
  ) {
    return (
      (el.children ?? []).filter(isTag).length === 0 ||
      !containsMedia(el, undefined)
    );
  }
  return false;
}
const containsMedia = (el: Element, _: unknown): boolean =>
  hasDescendant(el, (c) => nm(c) === 'img' || nm(c) === 'iframe');
function hasDescendant(el: Element, pred: (c: Element) => boolean): boolean {
  for (const c of elChildren(el)) {
    if (pred(c) || hasDescendant(c, pred)) return true;
  }
  return false;
}

function alignOf(el: Element): Align {
  const c = cls(el);
  const style = attr(el, 'style') ?? '';
  const a = attr(el, 'align') ?? '';
  if (
    c.includes('txt_center') ||
    a === 'center' ||
    /text-align\s*:\s*center/i.test(style)
  )
    return 'center';
  if (a === 'right' || /text-align\s*:\s*right/i.test(style)) return 'right';
  return 'left';
}

/**
 * A bare `<a id>`/`<a name>` jump target — an anchor with no visible content,
 * used to mark a section for in-page links (`<a href="#dra">` elsewhere). Returns
 * its id, or undefined for a normal link (one with text or a wrapped image).
 */
function bareAnchorId(el: Element): string | undefined {
  if (nm(el) !== 'a') return undefined;
  const id = attr(el, 'id') ?? attr(el, 'name');
  if (!id) return undefined;
  if (hasText(el) || hasDescendant(el, isContentImage)) return undefined;
  return id;
}

/* ------------------------------------------------------------------ *
 * Block extractors — { canExtract, extract }, priority order below.
 * ------------------------------------------------------------------ */

type Extractor = {
  name: string;
  canExtract: (el: Element) => boolean;
  extract: (el: Element, ctx: Ctx) => Block | Block[] | null;
};

function imageNode(el: Element): Block | null {
  const src = attr(el, 'src');
  if (!src) return null;
  const node: Block = { type: 'image', src: absolutize(src) };
  const alt = attr(el, 'alt');
  if (alt) node.alt = alt;
  const c = cls(el);
  const variant =
    c.includes('img_newspaper') || c.includes('newsImage')
      ? 'newspaper'
      : c.includes('img_2nd')
        ? '2nd'
        : c.includes('img_3rd')
          ? '3rd'
          : c.includes('img_smt')
            ? 'smt'
            : c.includes('img_3ds')
              ? '3ds'
              : undefined;
  if (variant) node.variant = variant;
  return node;
}

const heading: Extractor = {
  name: 'heading',
  canExtract: (el) =>
    ['h1', 'h2', 'h3', 'h4'].includes(nm(el)) ||
    /title0[1-4]|title_icon0[1-2]|iconTitle|title_quest/.test(cls(el)),
  extract: (el) => {
    const name = nm(el);
    const c = cls(el);
    let level: 1 | 2 | 3 | 4 = 2;
    if (name === 'h1' || c.includes('title01')) level = 1;
    else if (name === 'h3' || c.includes('title03')) level = 3;
    else if (name === 'h4' || c.includes('title04')) level = 4;
    else if (name === 'h2' || c.includes('title02')) level = 2;
    const children = parseInline(el.children);
    if (!children.length) return null;
    const block: Block = { type: 'heading', level, children };
    if (c.includes('title_icon') || c.includes('iconTitle'))
      block.variant = 'icon';
    else if (c.includes('title_quest')) block.variant = 'quest';
    // An anchor id/name placed directly on the heading (the modern in-page-link
    // form) — as opposed to a separate `<a id>` before it, which parseFlow lifts.
    const anchor = attr(el, 'id') ?? attr(el, 'name');
    if (anchor) block.anchor = anchor;
    return block;
  },
};

const button: Extractor = {
  name: 'button',
  canExtract: (el) =>
    /btn01|btn_square|btn_vt2013|btn_estore|btn_reservation/.test(cls(el)),
  extract: (el) => {
    const c = cls(el);
    const variant = c.includes('btn_square')
      ? 'square'
      : c.includes('btn_vt2013')
        ? 'vt2013'
        : c.includes('btn_estore')
          ? 'estore'
          : c.includes('btn_reservation')
            ? 'reservation'
            : undefined;
    const link =
      nm(el) === 'a' ? el : (elChildren(el).find((x) => nm(x) === 'a') ?? el);
    const href = absolutize(attr(link, 'href') ?? '');
    const children = parseInline(link.children);
    if (!children.length && !href) return null;
    const block: Block = { type: 'button', href, children };
    if (variant) block.variant = variant;
    return block;
  },
};

const image: Extractor = {
  name: 'image',
  canExtract: (el) =>
    (nm(el) === 'img' && !isInlineIcon(el)) ||
    /img_newspaper|newsImage/.test(cls(el)),
  extract: (el, ctx) => {
    if (nm(el) === 'img') return imageNode(el);
    const img = q(ctx, el, 'img');
    if (!img) return null;
    // carry the container class onto the image for the variant
    const node = imageNode(img);
    if (node && node.type === 'image' && !node.variant) {
      const c = cls(el);
      if (c.includes('img_newspaper') || c.includes('newsImage'))
        node.variant = 'newspaper';
    }
    return node;
  },
};

// A link wrapping a full (content) image — a banner/thumbnail. Emit block
// image(s) carrying the link, rather than a tiny inline icon inside a link.
const linkedImage: Extractor = {
  name: 'linkedImage',
  canExtract: (el) => nm(el) === 'a' && hasDescendant(el, isContentImage),
  extract: (el, ctx) => {
    const href = absolutize(attr(el, 'href') ?? '');
    const external =
      /^https?:\/\//i.test(href) && !/hiroba\.dqx\.jp/i.test(href);
    const blocks: Block[] = [];
    for (const img of qa(ctx, el, 'img')) {
      if (!isContentImage(img)) continue;
      const node = imageNode(img);
      if (node && node.type === 'image') {
        if (href) node.href = href;
        if (external) node.external = true;
        blocks.push(node);
      }
    }
    return blocks.length ? blocks : null;
  },
};

/* ------------------------------------------------------------------ *
 * Captioned image — a centered image plus the caption that follows it.
 * ------------------------------------------------------------------ */

/** A centered wrapper: a <center>, or a div/p aligned center. */
const isCenteredContainer = (el: Element): boolean =>
  nm(el) === 'center' || alignOf(el) === 'center';

/** Off-site after absolutization (mirrors the inline link test). */
const isExternalHref = (href: string): boolean =>
  /^https?:\/\//i.test(href) && !/hiroba\.dqx\.jp/i.test(href);

/** Every content (non-icon) image in the subtree, in document order. */
function contentImagesIn(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (e: Element): void => {
    for (const c of elChildren(e)) {
      if (isContentImage(c)) out.push(c);
      else walk(c);
    }
  };
  walk(el);
  return out;
}

/** Concatenated text preceding `img` in document order within `el`. */
function textBeforeImage(el: Element, img: Element): string {
  let before = '';
  let done = false;
  const walk = (e: Element): void => {
    for (const c of e.children ?? []) {
      if (done) return;
      if (isText(c)) before += c.data;
      else if (isTag(c)) {
        if (c === img) {
          done = true;
          return;
        }
        walk(c);
      }
    }
  };
  walk(el);
  return before;
}

/** Trim leading/trailing hard breaks from an inline run (a caption's edges). */
function trimBreaks(nodes: Inline[]): Inline[] {
  const isBreak = (n: Inline): boolean =>
    typeof n !== 'string' && n.type === 'break';
  let a = 0;
  let b = nodes.length;
  while (a < b && isBreak(nodes[a])) a++;
  while (b > a && isBreak(nodes[b - 1])) b--;
  return nodes.slice(a, b);
}

/**
 * A node that must NOT be flattened into a caption: a block-level tag, an inline
 * wrapper around block media, or an element another extractor claims (a button,
 * twitter embed, …). Guards both caption shapes so a real table/button/list after
 * an image keeps its block structure instead of collapsing into caption text.
 */
function isBlockish(n: AnyNode): boolean {
  return (
    isTag(n) &&
    (!INLINE_TAGS.has(nm(n)) ||
      hasBlockMedia(n) ||
      findBlockExtractor(n) !== undefined)
  );
}

/** An inline-only <center> usable as a split caption (text, no block content). */
const isInlineCaption = (el: Element): boolean =>
  !hasBlockChildren(el) &&
  !hasDescendant(el, isContentImage) &&
  hasText(el) &&
  !(el.children ?? []).some(isBlockish);

/** Next element/non-blank-text sibling, skipping whitespace and spacing <br>. */
function nextSignificant(el: Element): AnyNode | undefined {
  let n: AnyNode | null | undefined = el.next;
  while (n) {
    if (isText(n)) {
      if (n.data.trim() !== '') return n;
    } else if (isTag(n)) {
      if (nm(n) !== 'br') return n;
    }
    n = n.next;
  }
  return undefined;
}

type CaptionMatch = { img: Element; caption: Inline[]; sibling?: Element };

/**
 * Recognize the two shapes of a captioned image and return the image + caption:
 *   • combined — `<center><img>…caption…</center>`   (caption trails in the box)
 *   • split    — `<div align=center><img></div><center>caption</center>`
 * Requires a single, *leading* content image — text before it means the box is
 * prose that happens to contain an image (the brownroundBox case in parse.test),
 * not a caption. Trailing *block* content (a table/list/button after the image)
 * means it's a layout container, not a figure, so we bail there too and let it
 * recurse normally rather than flatten the block into caption text.
 */
function matchCaptionedImage(el: Element): CaptionMatch | null {
  if (!isCenteredContainer(el)) return null;
  const imgs = contentImagesIn(el);
  if (imgs.length !== 1) return null;
  const img = imgs[0];
  if (textBeforeImage(el, img).trim() !== '') return null;

  // Locate the direct child of `el` that holds the image. The image must be that
  // child directly, or wrapped only in an inline element (an <a> banner, a
  // <span>) — never reached *through* a structural wrapper like a table cell or
  // list item, where lifting the image out would strand the rest of the
  // structure. That wrapper must also carry no stray text of its own.
  const kids = el.children ?? [];
  const wrapIdx = kids.findIndex(
    (k) => k === img || (isTag(k) && hasDescendant(k, (c) => c === img)),
  );
  const wrapper = kids[wrapIdx];
  if (isTag(wrapper) && wrapper !== img) {
    if (!INLINE_TAGS.has(nm(wrapper)) || textOf(wrapper).trim() !== '')
      return null;
  }

  // Combined: a purely-inline caption trailing the image in the same box.
  const after = kids.slice(wrapIdx + 1);
  if (after.some(isBlockish)) return null;
  const trailing = trimBreaks(parseInline(after));
  if (meaningfulInline(trailing)) return { img, caption: trailing };

  // Split: the image sits alone in its box; a sibling <center> holds the caption.
  const sib = nextSignificant(el);
  if (sib && isTag(sib) && nm(sib) === 'center' && isInlineCaption(sib)) {
    const caption = trimBreaks(parseInline(sib.children));
    if (meaningfulInline(caption)) return { img, caption, sibling: sib };
  }
  return null;
}

const captionedImage: Extractor = {
  name: 'captionedImage',
  canExtract: (el) => matchCaptionedImage(el) !== null,
  extract: (el, ctx) => {
    const match = matchCaptionedImage(el);
    if (!match) return null;
    const node = imageNode(match.img);
    if (!node || node.type !== 'image') return null;
    // A banner wrapped in <a> inside the centered box carries its link.
    const a = ctx.$(match.img).closest('a')[0] as Element | undefined;
    if (a && a !== el) {
      const href = absolutize(attr(a, 'href') ?? '');
      if (href) {
        node.href = href;
        if (isExternalHref(href)) node.external = true;
      }
    }
    node.caption = match.caption;
    if (match.sibling) markProcessed(ctx, match.sibling);
    return node;
  },
};

const divider: Extractor = {
  name: 'divider',
  canExtract: (el) => /lineType1/.test(cls(el)),
  extract: () => ({ type: 'divider' }),
};

const video: Extractor = {
  name: 'video',
  canExtract: (el) =>
    nm(el) === 'iframe' && /youtube|youtu\.be/.test(attr(el, 'src') ?? ''),
  extract: (el) => {
    const src = attr(el, 'src');
    if (!src) return null;
    return { type: 'video', provider: 'youtube', src };
  },
};

const embed: Extractor = {
  name: 'embed',
  canExtract: (el) =>
    /twitter-tweet|twitter-timeline|twitter-.*-button|hashtag/.test(cls(el)),
  extract: (el) => {
    const c = cls(el);
    const variant = c.includes('twitter-timeline')
      ? 'timeline'
      : c.includes('button')
        ? 'button'
        : c.includes('hashtag')
          ? 'hashtag'
          : 'tweet';
    const block: Block = { type: 'embed', provider: 'twitter', variant };
    const content = textTrim(el) || attr(el, 'href');
    if (content) block.content = content;
    return block;
  },
};

const list: Extractor = {
  name: 'list',
  canExtract: (el) => nm(el) === 'ul' || nm(el) === 'ol',
  extract: (el, ctx) => {
    const items = elChildren(el)
      .filter((li) => nm(li) === 'li')
      .map((li) => ({ children: parseItemContent(li, ctx) }))
      .filter((it) => it.children.length > 0);
    if (!items.length) return null;
    return { type: 'list', ordered: nm(el) === 'ol', items };
  },
};

const cautionList: Extractor = {
  name: 'cautionList',
  canExtract: (el) => /tp_caution|tp_list/.test(cls(el)),
  extract: (el, ctx) => {
    const variant = cls(el).includes('tp_caution') ? 'caution' : 'default';
    const lis = qa(ctx, el, 'li');
    let items: { children: ContentNode[] }[];
    if (lis.length > 0) {
      items = lis.map((li) => ({ children: parseItemContent(li, ctx) }));
    } else {
      items = splitByBreak(el.children).map((group) => ({
        children: parseInline(group) as ContentNode[],
      }));
    }
    items = items.filter((it) => it.children.length > 0);
    if (!items.length) return null;
    const block: Block = { type: 'list', ordered: false, items };
    if (variant === 'caution') block.variant = 'caution';
    return block;
  },
};

const table: Extractor = {
  name: 'table',
  canExtract: (el) => nm(el) === 'table',
  extract: (el, ctx) => {
    const c = cls(el);
    const variant = c.includes('contentsTable1')
      ? 'contents'
      : c.includes('tp_table')
        ? 'tp'
        : undefined;

    const block: Block = { type: 'table', rows: [] };
    if (variant) block.variant = variant;

    const thead = q(ctx, el, 'thead');
    if (thead) {
      const hr = q(ctx, thead, 'tr');
      if (hr) {
        const headers = elChildren(hr)
          .filter((c2) => nm(c2) === 'th' || nm(c2) === 'td')
          .map((cell) => parseCell(cell, ctx));
        if (headers.length) block.headers = headers;
      }
    }

    const body = q(ctx, el, 'tbody') ?? el;
    for (const tr of qa(ctx, body, 'tr')) {
      if (ctx.$(tr).closest('thead').length) continue;
      const cells = elChildren(tr)
        .filter((c2) => nm(c2) === 'th' || nm(c2) === 'td')
        .map((cell) => parseCell(cell, ctx));
      if (cells.length) block.rows.push(cells);
    }

    if (!block.rows.length && !block.headers) return null;
    return block;
  },
};

function parseCell(cell: Element, ctx: Ctx): TableCell {
  const isBlockish =
    hasBlockChildren(cell) || elChildren(cell).some(isContentImage);
  const out: TableCell = {
    children: isBlockish
      ? parseFlow(cell, ctx)
      : (parseInline(cell.children) as ContentNode[]),
  };
  if (nm(cell) === 'th') out.header = true;
  const cs = attr(cell, 'colspan');
  const rs = attr(cell, 'rowspan');
  if (cs && Number(cs) > 1) out.colSpan = Number(cs);
  if (rs && Number(rs) > 1) out.rowSpan = Number(rs);
  return out;
}

const infoBox: Extractor = {
  name: 'infoBox',
  canExtract: (el) =>
    /brownroundBox|box01|box_quest(?!_set)|box_terms(?!_set)|box_cork(?!_set)|box_mi|box_ss/.test(
      cls(el),
    ),
  extract: (el, ctx) => {
    const c = cls(el);
    const variant: InfoBoxVariant = c.includes('box_quest')
      ? 'quest'
      : c.includes('box_terms')
        ? 'terms'
        : c.includes('box_cork')
          ? 'cork'
          : c.includes('box01')
            ? 'statistics'
            : c.includes('box_mi')
              ? 'mini'
              : c.includes('box_ss')
                ? 'screenshot'
                : 'highlight';
    const container =
      q(ctx, el, '.box_quest_set2, .box_terms_set2, .box_cork_set2, .brb_f') ??
      q(ctx, el, '.box_quest_set1, .box_terms_set1, .box_cork_set1, .brb_h') ??
      el;
    return {
      type: 'infoBox',
      variant,
      children: parseFlow(container, ctx) as ContentNode[],
    };
  },
};

const section: Extractor = {
  name: 'section',
  canExtract: (el) =>
    /newspaper/.test(cls(el)) && !/newspaper_[hf]/.test(cls(el)),
  extract: (el, ctx) => {
    const variant = /tit_newspaper_report/.test(cls(el))
      ? 'report'
      : 'newspaper';
    const container =
      q(ctx, el, '.newspaper_f') ?? q(ctx, el, '.newspaper_h') ?? el;

    const block: Block = { type: 'section', variant, children: [] };
    const titleEl = q(ctx, el, '.tit_newspaper, .tit_newspaper_report');
    if (titleEl) {
      block.title = parseInline(titleEl.children);
      markProcessed(ctx, titleEl);
    }
    const dateEl = q(ctx, el, '.news_date');
    if (dateEl) {
      block.dateline = parseInline(dateEl.children);
      markProcessed(ctx, dateEl);
    }
    block.children = parseFlow(container, ctx) as ContentNode[];
    return block;
  },
};

const accordion: Extractor = {
  name: 'accordion',
  canExtract: (el) => /ad_menu/.test(cls(el)),
  extract: (el, ctx) => {
    const btn = q(ctx, el, '.btn_ad_menu');
    const summary: Inline[] = btn ? parseInline(btn.children) : [];
    if (btn) markProcessed(ctx, btn);
    const wrap = q(ctx, el, '.wrap_table');
    const children = wrap ? (parseFlow(wrap, ctx) as ContentNode[]) : [];
    if (!summary.length && !children.length) return null;
    return { type: 'accordion', summary, children };
  },
};

const speechBubble: Extractor = {
  name: 'speechBubble',
  canExtract: (el) => /hukiBox/.test(cls(el)),
  extract: (el, ctx) => {
    const iconEl = q(ctx, el, '.huki_icon img') ?? q(ctx, el, 'img');
    const speakerEl = q(ctx, el, '.huki_name, .speaker');
    const textEl =
      q(ctx, el, '.huki_f') ??
      q(ctx, el, '.huki_h') ??
      q(ctx, el, '.huki') ??
      el;

    const block: Block = { type: 'speechBubble', children: [] };
    if (speakerEl) {
      block.speaker = textTrim(speakerEl);
      markProcessed(ctx, speakerEl);
    }
    if (iconEl) {
      const src = attr(iconEl, 'src');
      if (src) block.icon = absolutize(src);
      markProcessed(ctx, iconEl);
    }
    block.children = parseFlow(textEl, ctx) as ContentNode[];
    return block;
  },
};

const messageBox: Extractor = {
  name: 'messageBox',
  canExtract: (el) => /msg030802_msgBox|inbox/.test(cls(el)),
  extract: (el, ctx) => {
    const nameEl = q(ctx, el, '.msg030802_name, .name');
    const jobEl = q(ctx, el, '.msg030802_job, .job');
    const contentEl = q(ctx, el, '.msg030802_content, .content') ?? el;

    const block: Block = { type: 'messageBox', children: [] };
    if (nameEl) {
      block.name = textTrim(nameEl);
      markProcessed(ctx, nameEl);
    }
    if (jobEl) {
      block.role = textTrim(jobEl);
      markProcessed(ctx, jobEl);
    }
    block.children = parseFlow(contentEl, ctx) as ContentNode[];
    return block;
  },
};

const interview: Extractor = {
  name: 'interview',
  canExtract: (el) => /box_interview/.test(cls(el)),
  extract: (el, ctx) => {
    const block: Block = { type: 'interview', exchanges: [] };
    const titleEl = q(ctx, el, '.tit_interview');
    if (titleEl) block.title = textTrim(titleEl);
    const writerEl = q(ctx, el, '.txt_itv_writer');
    if (writerEl) block.writer = textTrim(writerEl);

    // Walk .tit_q / .tit_a / .txt_itv_main in document order, pairing Q with following A(s).
    const parts = qa(ctx, el, '.tit_q, .tit_a, .txt_itv_main');
    let current: { question: Inline[]; answer: Block[] } | null = null;
    for (const p of parts) {
      if (/tit_q/.test(cls(p))) {
        if (current && current.question.length) block.exchanges.push(current);
        current = { question: parseInline(p.children), answer: [] };
      } else if (current) {
        current.answer.push(...(parseFlow(p, ctx) as Block[]));
      }
    }
    if (current && current.question.length) block.exchanges.push(current);
    if (!block.exchanges.length) return null;
    return block;
  },
};

const ranking: Extractor = {
  name: 'ranking',
  canExtract: (el) => /rankbox|ranking_area0[1-2]/.test(cls(el)),
  extract: (el, ctx) => {
    const variant = /ranking_area/.test(cls(el)) ? 'area' : undefined;
    const titleEls = qa(ctx, el, '.mst, .title');
    const items: RankingItem[] = [];
    titleEls.forEach((t, i) => {
      const parent = (t.parent as Element | null) ?? el;
      const rankEl = q(ctx, parent, '.rank, .num_count');
      const countEl = q(ctx, parent, '.count');
      const rank = rankEl ? parseInt(textTrim(rankEl), 10) || i + 1 : i + 1;
      const item: RankingItem = { rank, title: parseInline(t.children) };
      if (countEl && textTrim(countEl)) item.count = textTrim(countEl);
      if (item.title.length) items.push(item);
    });
    if (!items.length) {
      const t = parseInline(el.children);
      if (t.length) items.push({ rank: 1, title: t });
    }
    if (!items.length) return null;
    const block: Block = { type: 'ranking', items };
    if (variant) block.variant = variant;
    return block;
  },
};

const steps: Extractor = {
  name: 'steps',
  canExtract: (el) => /step[1-5]|howto/.test(cls(el)),
  extract: (el, ctx) => {
    const variant = /howto/.test(cls(el)) ? 'howto' : 'numbered';
    // Group sibling step1..5 under a single steps block; dedup via processed set.
    const parent = (el.parent as Element | null) ?? el;
    let stepEls = qa(ctx, parent, '.step1, .step2, .step3, .step4, .step5');
    if (!stepEls.length) stepEls = [el];
    if (stepEls[0] !== el && stepEls.includes(el)) return null; // a later sibling — first one emitted the block
    const items: StepItem[] = stepEls.map((s) => {
      const m = cls(s).match(/step([1-5])/);
      const item: StepItem = { children: parseFlow(s, ctx) as Block[] };
      if (m) item.n = Number(m[1]);
      if (s !== el) markProcessed(ctx, s);
      return item;
    });
    const block: Block = { type: 'steps', items };
    if (variant === 'howto') block.variant = 'howto';
    return block;
  },
};

// Priority order (compound/container first, generic last). Excludes paragraph
// (handled as the fallback in processBlockElement).
const BLOCK_EXTRACTORS: Extractor[] = [
  section,
  infoBox,
  accordion,
  interview,
  speechBubble,
  messageBox,
  ranking,
  steps,
  table,
  cautionList,
  list,
  heading,
  button,
  captionedImage,
  linkedImage,
  divider,
  video,
  embed,
  image,
];

const findBlockExtractor = (el: Element): Extractor | undefined =>
  BLOCK_EXTRACTORS.find((e) => e.canExtract(el));

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

function markProcessed(ctx: Ctx, el: Element): void {
  ctx.processed.add(el);
  for (const c of elChildren(el)) markProcessed(ctx, c);
}

/** Split a node list at <br> boundaries into groups (for br-delimited lists). */
function splitByBreak(nodes: AnyNode[]): AnyNode[][] {
  const groups: AnyNode[][] = [];
  let cur: AnyNode[] = [];
  for (const n of nodes) {
    if (isTag(n) && nm(n) === 'br') {
      groups.push(cur);
      cur = [];
    } else {
      cur.push(n);
    }
  }
  groups.push(cur);
  return groups;
}

/** List-item / simple-container content: inline unless it has block-level children. */
function parseItemContent(el: Element, ctx: Ctx): ContentNode[] {
  if (hasBlockChildren(el) || elChildren(el).some(isContentImage))
    return parseFlow(el, ctx);
  return parseInline(el.children) as ContentNode[];
}

/**
 * The shared recursion: iterate a container's child nodes, accumulating inline
 * runs into paragraphs and dispatching block elements to their extractor.
 */
function parseFlow(el: Element, ctx: Ctx): Block[] {
  const out: Block[] = [];
  let inlineRun: AnyNode[] = [];
  // A bare <a id> jump target waiting to be lifted onto the next heading.
  let pendingAnchor: string | undefined;

  const flush = () => {
    if (inlineRun.length === 0) return;
    const inl = parseInline(inlineRun);
    inlineRun = [];
    if (meaningfulInline(inl)) out.push({ type: 'paragraph', children: inl });
  };

  const emitBlock = (node: Element) => {
    flush();
    const before = out.length;
    processBlockElement(node, out, ctx);
    if (pendingAnchor !== undefined) {
      // Lift the anchor onto a heading; against anything else it's dropped
      // rather than left as a stray empty-link paragraph.
      const first = out[before];
      if (first?.type === 'heading' && first.anchor === undefined)
        first.anchor = pendingAnchor;
      pendingAnchor = undefined;
    }
  };

  for (const node of el.children ?? []) {
    if (isText(node)) {
      inlineRun.push(node);
      continue;
    }
    if (!isTag(node)) continue;
    if (ctx.processed.has(node)) continue;

    const anchorId = bareAnchorId(node);
    if (anchorId !== undefined) {
      pendingAnchor = anchorId;
      continue;
    }

    if (findBlockExtractor(node)) {
      emitBlock(node);
    } else if (INLINE_TAGS.has(nm(node)) && !hasBlockMedia(node)) {
      inlineRun.push(node);
    } else {
      emitBlock(node);
    }
  }
  flush();
  return out;
}

function processBlockElement(el: Element, out: Block[], ctx: Ctx): void {
  if (ctx.processed.has(el)) return;

  // A matched extractor wins over shouldSkip (e.g. an empty lineType1 divider).
  const ex = findBlockExtractor(el);
  if (ex) {
    ctx.processed.add(el);
    const res = ex.extract(el, ctx);
    if (res) out.push(...(Array.isArray(res) ? res : [res]));
    return;
  }

  if (shouldSkip(el)) return;

  const name = nm(el);

  // Recurse into any element carrying block media (a content image / iframe) or
  // block-level children, so the media becomes a block and surrounding text
  // becomes paragraphs. Catches <p>, <div>, <center>, <blockquote>, and other
  // wrappers; small inline icons (ico_*) aren't block media and stay inline.
  if (hasBlockMedia(el) || hasBlockChildren(el)) {
    ctx.processed.add(el);
    out.push(...parseFlow(el, ctx));
    return;
  }

  // Leaf text paragraph.
  if (name === 'p' && !hasBlockChildren(el)) {
    ctx.processed.add(el);
    const children = parseInline(el.children);
    if (meaningfulInline(children)) {
      const p: Block = { type: 'paragraph', children };
      const align = alignOf(el);
      if (align !== 'left') p.align = align;
      out.push(p);
    }
    return;
  }

  // Leaf text div/span (direct text, no block children).
  if (
    (name === 'div' || name === 'span') &&
    hasDirectText(el) &&
    !hasBlockChildren(el)
  ) {
    ctx.processed.add(el);
    const children = parseInline(el.children);
    if (meaningfulInline(children)) {
      const p: Block = { type: 'paragraph', children };
      const align = alignOf(el);
      if (align !== 'left') p.align = align;
      out.push(p);
    }
    return;
  }

  // Container: recurse.
  if (BLOCK_TAGS.has(name)) {
    out.push(...parseFlow(el, ctx));
    return;
  }

  // Anything else with inline content → paragraph.
  const children = parseInline([el]);
  if (meaningfulInline(children)) out.push({ type: 'paragraph', children });
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Parse a content-root element into blocks. */
export function parseTopicContent($: CheerioAPI, root: Element): Block[] {
  return parseFlow(root, { $, processed: new Set() });
}

/** Parse a full or partial topic HTML document into blocks. */
export function parseTopicBody(html: string): Block[] {
  const $ = load(html);
  const root =
    ($('.newsContent > div')[0] as Element | undefined) ??
    ($('.newsContent')[0] as Element | undefined) ??
    ($('#contentArea .cttBox')[0] as Element | undefined) ??
    ($('#contentArea')[0] as Element | undefined) ??
    ($('body')[0] as Element | undefined);
  if (!root) return [];
  return parseTopicContent($, root);
}
