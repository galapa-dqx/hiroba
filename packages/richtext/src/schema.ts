/**
 * @hiroba/richtext — content model for rich-text DQX topics.
 *
 * A topic body is a tree of nodes in two tiers:
 *
 *   • Block  — block-level structure (paragraph, heading, image, table, infoBox…)
 *   • Inline — inline-level runs inside text (text, link, strong, color, badge…)
 *
 * Containment invariant (enforced by the generated validators below):
 *   • Inline nodes may only contain Inline children.  (Inline ⊂ Inline)
 *   • Block  nodes may contain Block *or* Inline children — a `ContentNode`.
 *
 * This mirrors the source DOM (scraped HTML) and the render target (HTML), so
 * parse and render are the same recursive walk. Text is the leaf: a bare string.
 *
 * Validation is by **typia**: the TypeScript types are the single source of
 * truth. Field-level constraints ride on the types as typia `tags` (hex pattern,
 * uint counts).
 *
 * Each node type below links 1–3 example topics from the scraped corpus
 * (https://hiroba.dqx.jp/sc/topics/detail/<id>/) — open them to see the source
 * construct the type is modelling. IDs were found by scanning the source HTML
 * (out/topic_content), not the derived block output.
 *
 * Differences from the prescraper's flat 18-type schema.json, justified by the
 * source-HTML census of the 3,306-topic corpus:
 *   • Inline formatting is preserved as nesting nodes instead of being flattened
 *     to plain strings:  bold_red → strong>color, inline <a> → link,
 *     <span style="color"> → color, ico_newsystem "New" → badge, ordinal icons → icon.
 *   • + divider           (lineType1 — an empty bordered <p>, 275 topics)
 *   • + list is first-class (was emitted 790× but missing from schema.json;
 *                            caution_list is folded in as list variant='caution')
 *   • section gains `dateline` (repurposes .news_date — a newspaper byline, not
 *     an event range) and `title`.
 *   • dropped `letter` (1 trivial caption → paragraph) and `date_range` as a type
 *     (event dates live in prose; the extract-events step handles them).
 *   • interview.answer is Block[] and question is Inline[] (fixes the empty
 *     tit_q / txt_itv_main pairing bug that dropped all interviews).
 */

import { type tags } from 'typia';

/** CSS hex color, e.g. "#CC0033" or "#333". */
export type HexColor = string &
  tags.Pattern<'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'>;
/** A positive integer count (span sizes, widths). */
export type Count = number & tags.Type<'uint32'> & tags.Minimum<1>;

/* ------------------------------------------------------------------ *
 * Inline tier
 * ------------------------------------------------------------------ */

/**
 * Plain text — the leaf node (present in every topic).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0060ef47b12160b9198302ebdb144dcf/
 */
export type TextNode = string;
/**
 * Hard line break (`<br>`, ubiquitous).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0060ef47b12160b9198302ebdb144dcf/
 */
export type BreakNode = {
  type: 'break';
};
/**
 * Bold run — source `bold_red` / `<b>` / font-weight (~97% of topics).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0188e8b8b014829e2fa0f430f0a95961/
 * @example https://hiroba.dqx.jp/sc/topics/detail/0060ef47b12160b9198302ebdb144dcf/
 */
export type StrongNode = {
  type: 'strong';
  children: Inline[];
};
/**
 * Italic run — source `<em>` / `<i>` / font-style:italic (rare).
 * @example https://hiroba.dqx.jp/sc/topics/detail/371bce7dc83817b7893bcdeed13799b5/
 * @example https://hiroba.dqx.jp/sc/topics/detail/3e195b0793297114c668f772c6e2d9ba/
 */
export type EmphasisNode = {
  type: 'emphasis';
  children: Inline[];
};
/**
 * Inline color — source `<span style="color:…">` (~90% of topics).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0084ae4bc24c0795d1e6a4f58444d39b/
 * @example https://hiroba.dqx.jp/sc/topics/detail/006f52e9102a8d3be2fe5614f42ba989/
 */
export type ColorNode = {
  type: 'color';
  value: HexColor;
  children: Inline[];
};
/**
 * Inline link — source in-prose `<a href>` (~90% of topics; the big fidelity win).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0060ef47b12160b9198302ebdb144dcf/
 * @example https://hiroba.dqx.jp/sc/topics/detail/006f52e9102a8d3be2fe5614f42ba989/
 */
export type LinkNode = {
  type: 'link';
  href: string;
  /** true when the href points off-site (renderer adds rel/target) */
  external?: boolean;
  children: Inline[];
};
/**
 * Atomic inline label, e.g. the "New" chip — source `ico_newsystem` (688 topics).
 * @example https://hiroba.dqx.jp/sc/topics/detail/00ac8ed3b4327bdd4ebbebcb2ba10a00/
 * @example https://hiroba.dqx.jp/sc/topics/detail/0141a8aedb1b53970fac7c81dac79fbe/
 */
export type BadgeNode = {
  type: 'badge';
  text: string;
  variant?: string;
};
/**
 * Atomic inline image/glyph, e.g. platform/ordinal icons — source `ico_2nd`…`ico_5th`.
 * @example https://hiroba.dqx.jp/sc/topics/detail/0353ab4cbed5beae847a7ff6e220b5cf/
 * @example https://hiroba.dqx.jp/sc/topics/detail/052335232b11864986bb2fa20fa38748/
 */
export type IconNode = {
  type: 'icon';
  src: string;
  alt?: string;
};

export type Inline =
  | TextNode
  | BreakNode
  | StrongNode
  | EmphasisNode
  | ColorNode
  | LinkNode
  | BadgeNode
  | IconNode;

/* ------------------------------------------------------------------ *
 * Block tier
 * ------------------------------------------------------------------ */

export type Align = 'left' | 'center' | 'right';
export type InfoBoxVariant =
  | 'highlight'
  | 'quest'
  | 'terms'
  | 'cork'
  | 'statistics'
  | 'mini'
  | 'screenshot';

// --- text blocks (Inline children only) ---
/**
 * Body paragraph (ubiquitous).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0060ef47b12160b9198302ebdb144dcf/
 */
export type ParagraphNode = {
  type: 'paragraph';
  children: Inline[];
  align?: Align;
};
/**
 * Heading — source `title01`–`04`, `title_icon0x`, `title_quest`.
 * @example https://hiroba.dqx.jp/sc/topics/detail/0060ef47b12160b9198302ebdb144dcf/
 * @example https://hiroba.dqx.jp/sc/topics/detail/4558dbb6f6f8bb2e16d03b85bde76e2c/ (quest variant)
 */
export type HeadingNode = {
  type: 'heading';
  level: 1 | 2 | 3 | 4;
  children: Inline[];
  /** 'label' = decorative title_icon0x sub-label (downgraded from a real heading). */
  variant?: 'default' | 'icon' | 'quest' | 'label';
};
/**
 * CTA button — source `btn01`–`04`, `btn_square` (1,800+ topics).
 * @example https://hiroba.dqx.jp/sc/topics/detail/006f52e9102a8d3be2fe5614f42ba989/
 * @example https://hiroba.dqx.jp/sc/topics/detail/2b24d495052a8ce66358eb576b8912c8/ (vt2013 variant)
 */
export type ButtonNode = {
  type: 'button';
  href: string;
  children: Inline[];
  variant?: string;
};
/**
 * Horizontal divider — source `lineType1`, an empty bordered `<p>` (275 topics).
 * @example https://hiroba.dqx.jp/sc/topics/detail/020c8bfac8de160d4c5543b96d1fdede/
 * @example https://hiroba.dqx.jp/sc/topics/detail/02ae6a786bbf135d3d223cbc0e770b6e/
 */
export type DividerNode = {
  type: 'divider';
};

// --- media / leaf blocks ---
/** Responsive image variant (source `size1920`/`size1280`/…); occurs inside {@link ImageNode}. */
export type ImageSource = {
  src: string;
  minWidth?: Count;
};
/**
 * Block image — source `TopicsImages`/`newsImage` `<img>` (ubiquitous, 28k images).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0060ef47b12160b9198302ebdb144dcf/
 */
export type ImageNode = {
  type: 'image';
  src: string;
  alt?: string;
  variant?: string;
  /** When the image is wrapped in a link (a banner/thumbnail linking somewhere). */
  href?: string;
  /** true when {@link href} is off-site (renderer adds target/rel). */
  external?: boolean;
  /** responsive variants (size1920/1280/… in source) */
  sources?: ImageSource[];
  /**
   * Text baked into the image (event banners, decorative headings), one entry per
   * transcribed span. Extracted by the transcription pass and translated
   * in-context with the body. Serializes as `<figure><line>…</line>…</figure>` —
   * one `<line>` per span — so translation keeps the spans 1:1 and
   * `blocks_ja.text[i]` pairs with `blocks_en.text[i]` (for compositing the EN
   * text back onto the image later).
   */
  text?: string[];
};
/**
 * YouTube embed — source `<iframe src="youtube.com/embed/…">` (135 blocks).
 * @example https://hiroba.dqx.jp/sc/topics/detail/7143d7fbadfa4693b9eec507d9d37443/
 * @example https://hiroba.dqx.jp/sc/topics/detail/0070d23b06b1486a538c0eaa45dd167a/
 */
export type VideoNode = {
  type: 'video';
  provider: 'youtube' | 'other';
  src: string;
};
/**
 * Twitter/X widget — follow button, tweet, timeline, or hashtag (84 blocks).
 * @example https://hiroba.dqx.jp/sc/topics/detail/f87e955fd6b89f8963b6934beb077d6e/ (follow button)
 * @example https://hiroba.dqx.jp/sc/topics/detail/11b9842e0a271ff252c1903e7132cd68/ (hashtag)
 */
export type EmbedNode = {
  type: 'embed';
  provider: 'twitter';
  variant?: 'tweet' | 'timeline' | 'button' | 'hashtag';
  content?: string;
};

// --- container blocks (Block or Inline children) ---
/**
 * Decorative info box — source `brownroundBox`, `box_quest`, `box_terms`, … (4,900+ blocks).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0060ef47b12160b9198302ebdb144dcf/ (highlight)
 * @example https://hiroba.dqx.jp/sc/topics/detail/91378b331327b40e564390c43cd6b2be/ (screenshot)
 */
export type InfoBoxNode = {
  type: 'infoBox';
  variant: InfoBoxVariant;
  children: ContentNode[];
};
/**
 * "Astoltia Report" newspaper section — source `newspaper`; `dateline` is `.news_date`.
 * @example https://hiroba.dqx.jp/sc/topics/detail/1728efbda81692282ba642aafd57be3a/ (アストルティア通信 + dateline)
 * @example https://hiroba.dqx.jp/sc/topics/detail/04ecb1fa28506ccb6f72b12c0245ddbc/
 */
export type SectionNode = {
  type: 'section';
  variant?: 'newspaper' | 'report';
  title?: Inline[];
  /** publication byline, e.g. "アストルティア通信 2014年5月27日 発行" (.news_date) */
  dateline?: Inline[];
  children: ContentNode[];
};
/**
 * Collapsible section — source `ad_menu` + `btn_ad_menu` toggle (541 topics).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0084ae4bc24c0795d1e6a4f58444d39b/
 * @example https://hiroba.dqx.jp/sc/topics/detail/0141a8aedb1b53970fac7c81dac79fbe/
 */
export type AccordionNode = {
  type: 'accordion';
  summary: Inline[];
  children: ContentNode[];
};
/**
 * Speech bubble with speaker portrait — source `hukiBox` (rare, ~3 topics).
 * @example https://hiroba.dqx.jp/sc/topics/detail/598b3e71ec378bd83e0a727608b5db01/
 * @example https://hiroba.dqx.jp/sc/topics/detail/33e8075e9970de0cfea955afd4644bb2/
 */
export type SpeechBubbleNode = {
  type: 'speechBubble';
  speaker?: string;
  icon?: string;
  children: ContentNode[];
};
/**
 * Attributed message/quote — source `*_msgBox`/`inbox` (1 topic: 1st-anniversary voices).
 * @example https://hiroba.dqx.jp/sc/topics/detail/89f0fd5c927d466d6ec9a21b9ac34ffa/
 */
export type MessageBoxNode = {
  type: 'messageBox';
  name?: string;
  role?: string;
  children: ContentNode[];
};

// --- structured blocks (own child shapes) ---
/** One list item; occurs inside {@link ListNode}. */
export type ListItem = {
  children: ContentNode[];
};
/**
 * Ordered/unordered list; `variant:'caution'` = the ※ notice list (`tp_caution`).
 * @example https://hiroba.dqx.jp/sc/topics/detail/e515df0d202ae52fcebb14295743063b/ (link list)
 * @example https://hiroba.dqx.jp/sc/topics/detail/f7e6c85504ce6e82442c770f7c8606f0/ (caution)
 */
export type ListNode = {
  type: 'list';
  ordered: boolean;
  /** 'caution' folds in the old caution_list (※ notices). */
  variant?: 'default' | 'caution';
  items: ListItem[];
};
/** One table cell; occurs inside {@link TableNode}. */
export type TableCell = {
  children: ContentNode[];
  header?: boolean;
  colSpan?: Count;
  rowSpan?: Count;
};
/**
 * Table — source `contentsTable1`/`tp_table` (1,700+ topics).
 * @example https://hiroba.dqx.jp/sc/topics/detail/008bd5ad93b754d500338c253d9c1770/
 * @example https://hiroba.dqx.jp/sc/topics/detail/00a03ec6533ca7f5c644d198d815329c/
 */
export type TableNode = {
  type: 'table';
  variant?: 'default' | 'contents' | 'tp';
  headers?: TableCell[];
  rows: TableCell[][];
};
/** One Q&A pair; occurs inside {@link InterviewNode}. */
export type InterviewExchange = {
  question: Inline[];
  answer: Block[];
};
/**
 * Developer interview — source `box_interview` (5 topics; dropped by the old parser).
 * @example https://hiroba.dqx.jp/sc/topics/detail/115f89503138416a242f40fb7d7f338e/ (director interview)
 * @example https://hiroba.dqx.jp/sc/topics/detail/854d6fae5ee42911677c739ee1734486/
 */
export type InterviewNode = {
  type: 'interview';
  title?: string;
  writer?: string;
  exchanges: InterviewExchange[];
};
/** One step; occurs inside {@link StepsNode}. */
export type StepItem = {
  n?: number;
  children: Block[];
};
/**
 * Numbered / how-to steps — source `step1`–`5` / `howto` (~55 topics).
 * @example https://hiroba.dqx.jp/sc/topics/detail/01d8bae291b1e4724443375634ccfa0e/
 * @example https://hiroba.dqx.jp/sc/topics/detail/09b15d48a1514d8209b192a8b8f34e48/
 */
export type StepsNode = {
  type: 'steps';
  variant?: 'numbered' | 'howto';
  items: StepItem[];
};
/** One ranked entry; occurs inside {@link RankingNode}. */
export type RankingItem = {
  rank: number & tags.Type<'uint32'>;
  title: Inline[];
  count?: string;
};
/**
 * Ranking table — source `rankbox`/`ranking_area0x` (43 blocks; e.g. monster/vote counts).
 * @example https://hiroba.dqx.jp/sc/topics/detail/1ee3dfcd8a0645a25a35977997223d22/
 * @example https://hiroba.dqx.jp/sc/topics/detail/a0f3601dc682036423013a5d965db9aa/
 */
export type RankingNode = {
  type: 'ranking';
  variant?: 'default' | 'area';
  items: RankingItem[];
};

export type Block =
  | ParagraphNode
  | HeadingNode
  | ButtonNode
  | DividerNode
  | ImageNode
  | VideoNode
  | EmbedNode
  | InfoBoxNode
  | SectionNode
  | AccordionNode
  | SpeechBubbleNode
  | MessageBoxNode
  | ListNode
  | TableNode
  | InterviewNode
  | StepsNode
  | RankingNode;

/** Any node. Blocks may contain these; inline nodes may only contain `Inline`. */
export type ContentNode = Block | Inline;

/**
 * A full topic document (id + top-level blocks).
 * @example https://hiroba.dqx.jp/sc/topics/detail/0060ef47b12160b9198302ebdb144dcf/
 */
export type TopicDocument = {
  id: string;
  blocks: Block[];
};

/* ------------------------------------------------------------------ *
 * Discriminators & guards (plain TS, no runtime deps)
 * ------------------------------------------------------------------ */

export const INLINE_TYPES = [
  'break',
  'strong',
  'emphasis',
  'color',
  'link',
  'badge',
  'icon',
] as const;

const INLINE_SET: ReadonlySet<string> = new Set(INLINE_TYPES);

export const isInline = (node: ContentNode): node is Inline =>
  typeof node === 'string' || INLINE_SET.has(node.type);
export const isBlock = (node: ContentNode): node is Block => !isInline(node);
