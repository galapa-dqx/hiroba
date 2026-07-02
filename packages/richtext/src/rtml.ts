/**
 * RTML (Rich-Text Markup Language) — a compact, canonical serialization of the
 * block tree used for whole-document translation (see docs/plan.md §1, §5).
 *
 *   serializeToRtml({title, blocks})  →  markup string
 *   parseRtml(markup)                 →  {title, blocks}
 *
 * The round-trip is an identity: `parseRtml(serializeToRtml(doc)) ≡ doc`.
 *
 * Two rules make it robust against imperfect LLM output:
 *   1. Every human-readable string is *element content*; every non-linguistic
 *      value (href, src, color value, variant, …) is an *attribute*. So the model
 *      only ever rewrites text between tags.
 *   2. Serialization is *compact* — no whitespace between tags — because an HTML
 *      parser turns inter-tag whitespace into stray text nodes.
 *
 * Parsing uses htmlparser2 (forgiving, generic-tag, never throws). The vocabulary
 * dodges HTML's special-cased tags: void nodes map onto real void tags
 * (`<br> <hr> <img> <embed>`), custom atoms get explicit close tags
 * (`<icon></icon>`, `<video></video>`), and reserved names like `<title>` are
 * replaced by `<doctitle>`/`<sectiontitle>` (a raw `<title>` would be parsed as
 * RCDATA and swallow its markup).
 */

import { parseDocument } from 'htmlparser2';
import { isTag, isText, type ChildNode, type Document, type Element } from 'domhandler';

import { isInline } from './schema';
import type {
  Align,
  Block,
  ContentNode,
  ImageSource,
  Inline,
  InfoBoxVariant,
  ParagraphNode,
  HeadingNode,
  ButtonNode,
  ImageNode,
  VideoNode,
  EmbedNode,
  InfoBoxNode,
  SectionNode,
  AccordionNode,
  SpeechBubbleNode,
  MessageBoxNode,
  ListNode,
  TableNode,
  TableCell,
  InterviewNode,
  InterviewExchange,
  StepsNode,
  StepItem,
  RankingNode,
  RankingItem,
} from './schema';

/** A translatable document: the topic title plus its block tree. */
export interface RtmlDocument {
  title: string;
  blocks: Block[];
}

/* ------------------------------------------------------------------ *
 * Serialize: block tree → RTML
 * ------------------------------------------------------------------ */

const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** ` name="value"`, or `''` when the value is undefined. */
const attr = (name: string, value: string | number | undefined): string =>
  value === undefined ? '' : ` ${name}="${escAttr(String(value))}"`;

/** ` name` when `on` is true, else `''` (boolean attribute). */
const boolAttr = (name: string, on: boolean | undefined): string => (on ? ` ${name}` : '');

const inlines = (nodes: Inline[]): string => nodes.map(serializeInline).join('');
const blocks = (nodes: Block[]): string => nodes.map(serializeBlock).join('');
const contents = (nodes: ContentNode[]): string =>
  nodes.map((n) => (isInline(n) ? serializeInline(n) : serializeBlock(n))).join('');

function serializeInline(node: Inline): string {
  if (typeof node === 'string') return escText(node);
  switch (node.type) {
    case 'break':
      return '<br>';
    case 'strong':
      return `<strong>${inlines(node.children)}</strong>`;
    case 'emphasis':
      return `<em>${inlines(node.children)}</em>`;
    case 'color':
      return `<color${attr('value', node.value)}>${inlines(node.children)}</color>`;
    case 'link':
      return `<a${attr('href', node.href)}${boolAttr('external', node.external)}>${inlines(node.children)}</a>`;
    case 'badge':
      return `<badge${attr('variant', node.variant)}>${escText(node.text)}</badge>`;
    case 'icon':
      return `<icon${attr('src', node.src)}${attr('alt', node.alt)}></icon>`;
  }
}

function serializeBlock(node: Block): string {
  switch (node.type) {
    case 'paragraph':
      return `<p${attr('align', node.align)}>${inlines(node.children)}</p>`;
    case 'heading':
      return `<h${node.level}${attr('variant', node.variant)}>${inlines(node.children)}</h${node.level}>`;
    case 'button':
      return `<button${attr('href', node.href)}${attr('variant', node.variant)}>${inlines(node.children)}</button>`;
    case 'divider':
      return '<hr>';
    case 'image':
      return `<img${attr('src', node.src)}${attr('alt', node.alt)}${attr('variant', node.variant)}${
        node.sources ? attr('sources', JSON.stringify(node.sources)) : ''
      }>`;
    case 'video':
      return `<video${attr('provider', node.provider)}${attr('src', node.src)}></video>`;
    case 'embed':
      return `<embed${attr('provider', node.provider)}${attr('variant', node.variant)}${attr('content', node.content)}>`;
    case 'infoBox':
      return `<infobox${attr('variant', node.variant)}>${contents(node.children)}</infobox>`;
    case 'section':
      return (
        `<section${attr('variant', node.variant)}>` +
        (node.title ? `<sectiontitle>${inlines(node.title)}</sectiontitle>` : '') +
        (node.dateline ? `<dateline>${inlines(node.dateline)}</dateline>` : '') +
        `${contents(node.children)}</section>`
      );
    case 'accordion':
      return `<accordion><summary>${inlines(node.summary)}</summary>${contents(node.children)}</accordion>`;
    case 'speechBubble':
      return (
        `<speech${attr('icon', node.icon)}>` +
        (node.speaker !== undefined ? `<speaker>${escText(node.speaker)}</speaker>` : '') +
        `${contents(node.children)}</speech>`
      );
    case 'messageBox':
      return (
        `<message>` +
        (node.name !== undefined ? `<name>${escText(node.name)}</name>` : '') +
        (node.role !== undefined ? `<role>${escText(node.role)}</role>` : '') +
        `${contents(node.children)}</message>`
      );
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const items = node.items.map((it) => `<li>${contents(it.children)}</li>`).join('');
      return `<${tag}${attr('variant', node.variant)}>${items}</${tag}>`;
    }
    case 'table':
      return serializeTable(node);
    case 'interview':
      return serializeInterview(node);
    case 'steps': {
      const items = node.items.map((s) => `<step${attr('n', s.n)}>${blocks(s.children)}</step>`).join('');
      return `<steps${attr('variant', node.variant)}>${items}</steps>`;
    }
    case 'ranking': {
      const items = node.items
        .map((i) => `<rank${attr('n', i.rank)}${attr('count', i.count)}>${inlines(i.title)}</rank>`)
        .join('');
      return `<ranking${attr('variant', node.variant)}>${items}</ranking>`;
    }
  }
}

function serializeCell(c: TableCell): string {
  const tag = c.header ? 'th' : 'td';
  return `<${tag}${attr('colspan', c.colSpan)}${attr('rowspan', c.rowSpan)}>${contents(c.children)}</${tag}>`;
}

function serializeTable(node: TableNode): string {
  let out = `<table${attr('variant', node.variant)}>`;
  if (node.headers) out += `<thead><tr>${node.headers.map(serializeCell).join('')}</tr></thead>`;
  out += `<tbody>${node.rows.map((r) => `<tr>${r.map(serializeCell).join('')}</tr>`).join('')}</tbody>`;
  return out + '</table>';
}

function serializeInterview(node: InterviewNode): string {
  const exchanges = node.exchanges
    .map(
      (e) =>
        `<exchange><question>${inlines(e.question)}</question><answer>${blocks(e.answer)}</answer></exchange>`,
    )
    .join('');
  return (
    `<interview>` +
    (node.title !== undefined ? `<inttitle>${escText(node.title)}</inttitle>` : '') +
    (node.writer !== undefined ? `<writer>${escText(node.writer)}</writer>` : '') +
    `${exchanges}</interview>`
  );
}

/** Serialize a topic document (title + block tree) to RTML. */
export function serializeToRtml(doc: RtmlDocument): string {
  return `<doctitle>${escText(doc.title)}</doctitle>${doc.blocks.map(serializeBlock).join('')}`;
}

/* ------------------------------------------------------------------ *
 * Parse: RTML → block tree
 * ------------------------------------------------------------------ */

const INLINE_TAGS: ReadonlySet<string> = new Set(['br', 'strong', 'em', 'color', 'a', 'badge', 'icon']);

const childEls = (el: Element | Document, name?: string): Element[] =>
  el.children.filter((c): c is Element => isTag(c) && (name === undefined || c.name === name));

const childEl = (el: Element | Document, name: string): Element | undefined => childEls(el, name)[0];

/** Concatenated text of all descendants — for plain-string fields. */
function textOf(el: Element): string {
  let s = '';
  for (const c of el.children) {
    if (isText(c)) s += c.data;
    else if (isTag(c)) s += textOf(c);
  }
  return s;
}

function parseInlines(nodes: ChildNode[]): Inline[] {
  const out: Inline[] = [];
  for (const c of nodes) {
    if (isText(c)) out.push(c.data);
    else if (isTag(c)) out.push(parseInlineTag(c));
  }
  return out;
}

function parseInlineTag(el: Element): Inline {
  const a = el.attribs;
  switch (el.name) {
    case 'br':
      return { type: 'break' };
    case 'strong':
      return { type: 'strong', children: parseInlines(el.children) };
    case 'em':
      return { type: 'emphasis', children: parseInlines(el.children) };
    case 'color':
      return { type: 'color', value: a.value, children: parseInlines(el.children) };
    case 'a': {
      const n: Inline = { type: 'link', href: a.href, children: parseInlines(el.children) };
      if ('external' in a) n.external = true;
      return n;
    }
    case 'badge': {
      const n: Inline = { type: 'badge', text: textOf(el) };
      if (a.variant !== undefined) n.variant = a.variant;
      return n;
    }
    case 'icon': {
      const n: Inline = { type: 'icon', src: a.src };
      if (a.alt !== undefined) n.alt = a.alt;
      return n;
    }
    default:
      throw new Error(`Unknown inline tag <${el.name}>`);
  }
}

/** Mixed block-or-inline children (container content). */
function parseContent(nodes: ChildNode[]): ContentNode[] {
  const out: ContentNode[] = [];
  for (const c of nodes) {
    // Drop whitespace-only text between elements — it's formatting an LLM may
    // have inserted, never meaningful container content. Genuine inline text
    // inside a <p>/<strong>/… is kept by parseInlines (which preserves all text).
    if (isText(c)) {
      if (c.data.trim() !== '') out.push(c.data);
    } else if (isTag(c)) {
      out.push(INLINE_TAGS.has(c.name) ? parseInlineTag(c) : parseBlock(c));
    }
  }
  return out;
}

/** Block-only children (interview answers, step bodies, top level). */
function parseBlocks(nodes: ChildNode[]): Block[] {
  const out: Block[] = [];
  for (const c of nodes) if (isTag(c)) out.push(parseBlock(c));
  return out;
}

function parseBlock(el: Element): Block {
  const a = el.attribs;
  switch (el.name) {
    case 'p': {
      const n: ParagraphNode = { type: 'paragraph', children: parseInlines(el.children) };
      if (a.align !== undefined) n.align = a.align as Align;
      return n;
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4': {
      const n: HeadingNode = {
        type: 'heading',
        level: Number(el.name[1]) as HeadingNode['level'],
        children: parseInlines(el.children),
      };
      if (a.variant !== undefined) n.variant = a.variant as HeadingNode['variant'];
      return n;
    }
    case 'button': {
      const n: ButtonNode = { type: 'button', href: a.href, children: parseInlines(el.children) };
      if (a.variant !== undefined) n.variant = a.variant;
      return n;
    }
    case 'hr':
      return { type: 'divider' };
    case 'img': {
      const n: ImageNode = { type: 'image', src: a.src };
      if (a.alt !== undefined) n.alt = a.alt;
      if (a.variant !== undefined) n.variant = a.variant;
      if (a.sources !== undefined) n.sources = JSON.parse(a.sources) as ImageSource[];
      return n;
    }
    case 'video':
      return { type: 'video', provider: a.provider as VideoNode['provider'], src: a.src };
    case 'embed': {
      const n: EmbedNode = { type: 'embed', provider: a.provider as EmbedNode['provider'] };
      if (a.variant !== undefined) n.variant = a.variant as EmbedNode['variant'];
      if (a.content !== undefined) n.content = a.content;
      return n;
    }
    case 'infobox': {
      const n: InfoBoxNode = { type: 'infoBox', variant: a.variant as InfoBoxVariant, children: parseContent(el.children) };
      return n;
    }
    case 'section':
      return parseSection(el);
    case 'accordion':
      return parseAccordion(el);
    case 'speech':
      return parseSpeech(el);
    case 'message':
      return parseMessage(el);
    case 'ul':
    case 'ol': {
      const n: ListNode = {
        type: 'list',
        ordered: el.name === 'ol',
        items: childEls(el, 'li').map((li) => ({ children: parseContent(li.children) })),
      };
      if (a.variant !== undefined) n.variant = a.variant as ListNode['variant'];
      return n;
    }
    case 'table':
      return parseTable(el);
    case 'interview':
      return parseInterview(el);
    case 'steps': {
      const n: StepsNode = {
        type: 'steps',
        items: childEls(el, 'step').map((s) => {
          const item: StepItem = { children: parseBlocks(s.children) };
          if (s.attribs.n !== undefined) item.n = Number(s.attribs.n);
          return item;
        }),
      };
      if (a.variant !== undefined) n.variant = a.variant as StepsNode['variant'];
      return n;
    }
    case 'ranking': {
      const n: RankingNode = {
        type: 'ranking',
        items: childEls(el, 'rank').map((r) => {
          const item: RankingItem = { rank: Number(r.attribs.n), title: parseInlines(r.children) };
          if (r.attribs.count !== undefined) item.count = r.attribs.count;
          return item;
        }),
      };
      if (a.variant !== undefined) n.variant = a.variant as RankingNode['variant'];
      return n;
    }
    default:
      throw new Error(`Unknown block tag <${el.name}>`);
  }
}

/** Split a container's children into named special elements + the rest (content). */
function partition(el: Element, special: ReadonlySet<string>): { specials: Map<string, Element>; rest: ChildNode[] } {
  const specials = new Map<string, Element>();
  const rest: ChildNode[] = [];
  for (const c of el.children) {
    if (isTag(c) && special.has(c.name) && !specials.has(c.name)) specials.set(c.name, c);
    else rest.push(c);
  }
  return { specials, rest };
}

function parseSection(el: Element): SectionNode {
  const { specials, rest } = partition(el, new Set(['sectiontitle', 'dateline']));
  const n: SectionNode = { type: 'section', children: parseContent(rest) };
  if (el.attribs.variant !== undefined) n.variant = el.attribs.variant as SectionNode['variant'];
  const t = specials.get('sectiontitle');
  if (t) n.title = parseInlines(t.children);
  const d = specials.get('dateline');
  if (d) n.dateline = parseInlines(d.children);
  return n;
}

function parseAccordion(el: Element): AccordionNode {
  const { specials, rest } = partition(el, new Set(['summary']));
  const s = specials.get('summary');
  return { type: 'accordion', summary: s ? parseInlines(s.children) : [], children: parseContent(rest) };
}

function parseSpeech(el: Element): SpeechBubbleNode {
  const { specials, rest } = partition(el, new Set(['speaker']));
  const n: SpeechBubbleNode = { type: 'speechBubble', children: parseContent(rest) };
  if (el.attribs.icon !== undefined) n.icon = el.attribs.icon;
  const sp = specials.get('speaker');
  if (sp) n.speaker = textOf(sp);
  return n;
}

function parseMessage(el: Element): MessageBoxNode {
  const { specials, rest } = partition(el, new Set(['name', 'role']));
  const n: MessageBoxNode = { type: 'messageBox', children: parseContent(rest) };
  const name = specials.get('name');
  if (name) n.name = textOf(name);
  const role = specials.get('role');
  if (role) n.role = textOf(role);
  return n;
}

function parseCell(c: Element): TableCell {
  const cell: TableCell = { children: parseContent(c.children) };
  if (c.name === 'th') cell.header = true;
  if (c.attribs.colspan !== undefined) cell.colSpan = Number(c.attribs.colspan);
  if (c.attribs.rowspan !== undefined) cell.rowSpan = Number(c.attribs.rowspan);
  return cell;
}

const isCell = (el: Element): boolean => el.name === 'th' || el.name === 'td';

function parseTable(el: Element): TableNode {
  const n: TableNode = { type: 'table', rows: [] };
  if (el.attribs.variant !== undefined) n.variant = el.attribs.variant as TableNode['variant'];
  const thead = childEl(el, 'thead');
  if (thead) {
    const tr = childEl(thead, 'tr');
    if (tr) n.headers = childEls(tr).filter(isCell).map(parseCell);
  }
  const body = childEl(el, 'tbody') ?? el;
  for (const tr of childEls(body, 'tr')) n.rows.push(childEls(tr).filter(isCell).map(parseCell));
  return n;
}

function parseInterview(el: Element): InterviewNode {
  const n: InterviewNode = { type: 'interview', exchanges: [] };
  const t = childEl(el, 'inttitle');
  if (t) n.title = textOf(t);
  const w = childEl(el, 'writer');
  if (w) n.writer = textOf(w);
  for (const ex of childEls(el, 'exchange')) {
    const q = childEl(ex, 'question');
    const ans = childEl(ex, 'answer');
    const exchange: InterviewExchange = {
      question: q ? parseInlines(q.children) : [],
      answer: ans ? parseBlocks(ans.children) : [],
    };
    n.exchanges.push(exchange);
  }
  return n;
}

/** Parse a RTML document back into a topic document (title + block tree). */
export function parseRtml(markup: string): RtmlDocument {
  const root = parseDocument(markup, {
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    decodeEntities: true,
    // Tolerate the model self-closing a custom atom (`<icon .../>`) instead of
    // using an explicit close tag; without this htmlparser2 treats it as an open
    // element and swallows the following siblings.
    recognizeSelfClosing: true,
  });
  let title = '';
  const blockNodes: Element[] = [];
  for (const c of root.children) {
    if (isTag(c) && c.name === 'doctitle') title = textOf(c);
    else if (isTag(c)) blockNodes.push(c);
  }
  return { title, blocks: blockNodes.map(parseBlock) };
}
