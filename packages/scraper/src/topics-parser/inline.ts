/**
 * Inline extraction — the piece the prescraper lacked (it flattened inline runs
 * to plain strings). Walks the inline DOM inside a text-bearing element and
 * produces a nested `Inline[]` in the @hiroba/richtext model:
 *
 *   <b><span style="color:#c03">赤い</span></b>  →  strong > color(#CC0033) > "赤い"
 *   <a href="…" target="_blank">こちら</a>        →  link{href, external}
 *   <span class="ico_newsystem">…</span>          →  badge{text:"New"}
 *   inline <img>                                   →  icon
 *
 * Whitespace: ASCII runs collapse to a single space; the ideographic space
 * (U+3000, meaningful in Japanese layout) is preserved. Adjacent text is merged
 * so the output is canonical (no adjacent bare strings) for the RTML round-trip.
 */

import { isTag, isText, type AnyNode, type Element } from 'domhandler';

import type { HexColor, Inline } from '@hiroba/richtext';

const classOf = (el: Element): string => el.attribs?.class ?? '';
const styleOf = (el: Element): string => el.attribs?.style ?? '';
const nameOf = (el: Element): string => el.name?.toLowerCase() ?? '';

const SITE_BASE = 'https://hiroba.dqx.jp';

/**
 * Resolve a root- or protocol-relative URL against the source site at parse time,
 * so blocks_ja holds absolute URLs. The renderer rewrites image URLs to our proxy
 * (rewriteImageSrc); links keep pointing at the source.
 */
export function absolutize(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${SITE_BASE}${url}`;
  return url; // #anchors, javascript:, mailto:, bare relative — leave as-is
}

const ICON_SRC_RE = /\/ico_[a-z0-9_]+\.(?:gif|png|jpe?g)/i;
const ICON_CLASS_RE = /\bimg_(?:2nd|3rd|4th|5th|smt|3ds)\b/;

/**
 * True for the small ordinal/platform glyph icons that belong inline
 * (`ico_2nd.gif`, `ico_smt.gif`, class `img_2nd`…). Everything else — TopicsImages,
 * banners, screenshots — is a block image.
 */
export function isInlineIcon(el: Element): boolean {
  return (
    ICON_SRC_RE.test(el.attribs?.src ?? '') ||
    ICON_CLASS_RE.test(el.attribs?.class ?? '')
  );
}

/**
 * Label to use for a sprite-icon badge whose source span carries no inner text
 * (the glyph-only platform/flag icons). Keyed by the `ico_<variant>` suffix; the
 * ordinals always ship their "Nth" text so they need no entry. `teian` keeps its
 * Japanese label — the translation pass renders it (e.g. "Suggestion Box").
 */
const BADGE_FALLBACK: Record<string, string> = {
  newsystem: 'New',
  new_s: 'New',
  checkmark: 'Check',
  smt: 'SP',
  '3ds': '3DS',
  teian: '提案広場',
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const NAMED_COLORS: Record<string, string> = {
  red: '#FF0000',
  blue: '#0000FF',
  green: '#008000',
  black: '#000000',
  white: '#FFFFFF',
  orange: '#FFA500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
};

/** Normalize a CSS color to a hex string, or undefined if not representable. */
function toHex(raw: string | undefined): HexColor | undefined {
  if (!raw) return undefined;
  const c = raw.trim().toLowerCase();
  if (HEX_RE.test(c)) return c.toUpperCase() as HexColor;
  if (c in NAMED_COLORS) return NAMED_COLORS[c] as HexColor;
  const rgb = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) {
    const h = (n: string) =>
      Math.min(255, parseInt(n, 10)).toString(16).padStart(2, '0');
    return `#${h(rgb[1])}${h(rgb[2])}${h(rgb[3])}`.toUpperCase() as HexColor;
  }
  return undefined;
}

/** Extract a hex color from an element's inline style or <font color>. */
function colorOf(el: Element): HexColor | undefined {
  const m = styleOf(el).match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
  if (m) return toHex(m[1]);
  if (nameOf(el) === 'font') return toHex(el.attribs?.color);
  return undefined;
}

function isBold(el: Element): boolean {
  const name = nameOf(el);
  if (name === 'b' || name === 'strong') return true;
  if (/\b(?:bold_red|txt_bold)\b/.test(classOf(el))) return true;
  return /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(styleOf(el));
}

function isItalic(el: Element): boolean {
  const name = nameOf(el);
  if (name === 'em' || name === 'i') return true;
  return /font-style\s*:\s*italic/i.test(styleOf(el));
}

/** Off-site after absolutization: an http(s) URL whose host isn't the source site. */
function isExternalLink(href: string): boolean {
  return /^https?:\/\//i.test(href) && !/hiroba\.dqx\.jp/i.test(href);
}

/** Collapse ASCII whitespace runs to one space; keep U+3000 (ideographic space). */
const normText = (s: string): string => s.replace(/[ \t\r\n\f\v]+/g, ' ');

/**
 * Merge adjacent strings and trim the outer edges — canonical inline output.
 * Edge whitespace includes U+3000: a mid-text ideographic space is a meaningful
 * separator (kept by {@link normText}), but at a run's start/end it's only the
 * source's decorative indentation (e.g. the leading U+3000 on `title0x`
 * headings) and, unlike an ASCII space, the browser won't collapse it — so we
 * strip it.
 */
function canonicalize(nodes: Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const n of nodes) {
    const last = merged[merged.length - 1];
    if (typeof n === 'string' && typeof last === 'string')
      merged[merged.length - 1] = last + n;
    else merged.push(n);
  }
  if (typeof merged[0] === 'string')
    merged[0] = merged[0].replace(/^[ \u3000]+/, '');
  const li = merged.length - 1;
  if (typeof merged[li] === 'string')
    merged[li] = (merged[li] as string).replace(/[ \u3000]+$/, '');
  return merged.filter((n) => n !== '');
}

/** Parse a list of DOM child nodes into a canonical inline run. */
export function parseInline(nodes: AnyNode[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    if (isText(n)) out.push(normText(n.data));
    else if (isTag(n)) pushElement(n, out);
  }
  return canonicalize(out);
}

function pushElement(el: Element, out: Inline[]): void {
  const name = nameOf(el);

  if (name === 'br') {
    out.push({ type: 'break' });
    return;
  }
  if (name === 'img') {
    const src = el.attribs?.src;
    if (src) {
      const icon: Inline = { type: 'icon', src: absolutize(src) };
      if (el.attribs?.alt) icon.alt = el.attribs.alt;
      out.push(icon);
    }
    return;
  }
  // Sprite-icon spans → a badge. These are `<span class="ico_*">label</span>`
  // whose visible glyph is a CSS background GIF and whose inner text (hidden by
  // `text-indent:-9999em` in the source) is the label. Unlike the `<img>` ordinal
  // icons (kept inline as image nodes above), a sprite span has no <img> to key,
  // so we keep the label as a translatable chip instead of mirroring the sprite:
  // the "New"/"Check" flags, the expansion-pack ordinals (ico_1st…ico_8th), the
  // platform glyphs (ico_smt/ico_3ds), and the Suggestion Box mark (ico_teian).
  const badge = classOf(el).match(
    /\bico_(newsystem|new_s|checkmark|[1-8](?:st|nd|rd|th)|smt|3ds|teian)\b/,
  );
  if (badge) {
    const variant = badge[1];
    const text = textOf(el).trim() || BADGE_FALLBACK[variant] || variant;
    out.push({ type: 'badge', text, variant });
    return;
  }
  if (name === 'a') {
    const href = absolutize(el.attribs?.href ?? '');
    const link: Inline = {
      type: 'link',
      href,
      children: parseInline(el.children),
    };
    if (isExternalLink(href)) link.external = true;
    out.push(link);
    return;
  }

  // Formatting wrappers: bold / italic / color, composed as strong > em > color > text.
  const color = colorOf(el);
  const bold = isBold(el);
  const italic = isItalic(el);
  let inner = parseInline(el.children);
  if (color) inner = [{ type: 'color', value: color, children: inner }];
  if (italic) inner = [{ type: 'emphasis', children: inner }];
  if (bold) inner = [{ type: 'strong', children: inner }];

  // A plain wrapper (<span>, <u>, <small>, unknown) with no formatting is unwrapped.
  out.push(...inner);
}

/** Concatenated visible text of an element (used for badge/label leaves). */
export function textOf(el: Element): string {
  let s = '';
  for (const c of el.children ?? []) {
    if (isText(c)) s += c.data;
    else if (isTag(c)) s += textOf(c);
  }
  return s;
}
