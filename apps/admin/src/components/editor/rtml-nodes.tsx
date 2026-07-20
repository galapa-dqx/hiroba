/**
 * Custom Lexical nodes for the RTML article editor.
 *
 * Text-tier RTML maps onto native Lexical nodes (paragraph, heading, list,
 * link, text formats). Everything Lexical can't express natively lives here:
 *
 * - RtmlHeadingNode — HeadingNode plus the RTML `variant`/`anchor` fields
 * - RtmlListNode — ListNode plus the RTML `variant` field
 * - RtmlTableNode — TableNode plus the RTML `variant` field (cells are plain
 *   Lexical TableCellNodes; header flags map onto headerState)
 * - RtmlButtonNode — block CTA with editable text; href/variant ride along
 * - TimeWrapperNode / EventWrapperNode — inline elements with editable text
 *   whose non-linguistic attributes (datetime, event id/start/end) ride along
 * - BadgeChipNode / IconChipNode — atomic inline decorations
 * - PreservedBlockNode — any block the editor doesn't edit natively (images,
 *   info boxes, interviews, …), carried verbatim as JSON and shown as a
 *   rendered preview card with a raw-JSON escape hatch
 */

import {
  ListNode,
  type ListType,
  type SerializedListNode,
} from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  HeadingNode,
  type HeadingTagType,
  type SerializedHeadingNode,
} from '@lexical/rich-text';
import { TableNode, type SerializedTableNode } from '@lexical/table';
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getNodeByKey,
  DecoratorNode,
  ElementNode,
  type EditorConfig,
  type NodeKey,
  type ParagraphNode,
  type RangeSelection,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { createContext, useContext, useMemo, useState, type JSX } from 'react';

import {
  imageKey,
  renderBlocks,
  type Block,
  type BadgeNode as RtmlBadge,
  type HeadingNode as RtmlHeading,
  type IconNode as RtmlIcon,
  type ListNode as RtmlList,
  type TableNode as RtmlTable,
} from '@hiroba/richtext';

import { resolveImageId } from '../../lib/api';

/* ------------------------------------------------------------------ *
 * PreservedRenderContext — display-only options for preserved-block previews
 * ------------------------------------------------------------------ */

/**
 * Options threaded into every {@link PreservedBlockView} preview so images can
 * render their localized (translated) raster on a translated tab. Display-only:
 * it rewrites the rendered `<img src>` and never touches the stored block, so
 * saving still round-trips the original source URL.
 */
type PreservedRenderContextValue = {
  /** Rewrites image/icon URLs (e.g. → `/img/l10n/<lang>/v<ts>/<key>`). */
  imageSrc?: (src: string) => string;
};

export const PreservedRenderContext =
  createContext<PreservedRenderContextValue>({});

/* ------------------------------------------------------------------ *
 * RtmlHeadingNode
 * ------------------------------------------------------------------ */

type SerializedRtmlHeadingNode = Spread<
  { variant?: RtmlHeading['variant']; anchor?: string },
  SerializedHeadingNode
>;

export class RtmlHeadingNode extends HeadingNode {
  __variant?: RtmlHeading['variant'];
  __anchor?: string;

  static getType(): string {
    return 'rtml-heading';
  }

  static clone(node: RtmlHeadingNode): RtmlHeadingNode {
    return new RtmlHeadingNode(
      node.__tag,
      node.__variant,
      node.__anchor,
      node.__key,
    );
  }

  constructor(
    tag: HeadingTagType,
    variant?: RtmlHeading['variant'],
    anchor?: string,
    key?: NodeKey,
  ) {
    super(tag, key);
    this.__variant = variant;
    this.__anchor = anchor;
  }

  getVariant(): RtmlHeading['variant'] | undefined {
    return this.getLatest().__variant;
  }

  getAnchor(): string | undefined {
    return this.getLatest().__anchor;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    // Mirror renderBlocks' rt-h-{variant} class so the shared article-body
    // styles apply in the editor (plain headings stay class-less — the
    // stylesheet keys its default heading looks off :not([class])).
    if (this.__variant && this.__variant !== 'default') {
      dom.classList.add(`rt-h-${this.__variant}`);
    }
    return dom;
  }

  exportJSON(): SerializedRtmlHeadingNode {
    return {
      ...super.exportJSON(),
      type: 'rtml-heading',
      variant: this.__variant,
      anchor: this.__anchor,
    };
  }

  static importJSON(json: SerializedRtmlHeadingNode): RtmlHeadingNode {
    return $createRtmlHeadingNode(
      json.tag,
      json.variant,
      json.anchor,
    ).updateFromJSON(json);
  }
}

export function $createRtmlHeadingNode(
  tag: HeadingTagType,
  variant?: RtmlHeading['variant'],
  anchor?: string,
): RtmlHeadingNode {
  return $applyNodeReplacement(new RtmlHeadingNode(tag, variant, anchor));
}

/* ------------------------------------------------------------------ *
 * RtmlListNode — ListNode plus the RTML variant
 * ------------------------------------------------------------------ */

type SerializedRtmlListNode = Spread<
  { variant?: RtmlList['variant'] },
  SerializedListNode
>;

export class RtmlListNode extends ListNode {
  __variant?: RtmlList['variant'];

  static getType(): string {
    return 'rtml-list';
  }

  static clone(node: RtmlListNode): RtmlListNode {
    return new RtmlListNode(
      node.__listType,
      node.__start,
      node.__variant,
      node.__key,
    );
  }

  constructor(
    listType: ListType,
    start: number,
    variant?: RtmlList['variant'],
    key?: NodeKey,
  ) {
    super(listType, start, key);
    this.__variant = variant;
  }

  getVariant(): RtmlList['variant'] | undefined {
    return this.getLatest().__variant;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    // Mirror renderBlocks' rt-list-{variant} class for WYSIWYG parity.
    if (this.__variant && this.__variant !== 'default') {
      dom.classList.add(`rt-list-${this.__variant}`);
    }
    return dom;
  }

  exportJSON(): SerializedRtmlListNode {
    return {
      ...super.exportJSON(),
      type: 'rtml-list',
      variant: this.__variant,
    };
  }

  static importJSON(json: SerializedRtmlListNode): RtmlListNode {
    return $createRtmlListNode(json.listType, json.variant).updateFromJSON(
      json,
    );
  }
}

export function $createRtmlListNode(
  listType: ListType,
  variant?: RtmlList['variant'],
): RtmlListNode {
  return $applyNodeReplacement(new RtmlListNode(listType, 1, variant));
}

/* ------------------------------------------------------------------ *
 * RtmlTableNode — TableNode plus the RTML variant
 * ------------------------------------------------------------------ */

type SerializedRtmlTableNode = Spread<
  { variant?: RtmlTable['variant'] },
  SerializedTableNode
>;

export class RtmlTableNode extends TableNode {
  __variant?: RtmlTable['variant'];

  static getType(): string {
    return 'rtml-table';
  }

  static clone(node: RtmlTableNode): RtmlTableNode {
    return new RtmlTableNode(node.__variant, node.__key);
  }

  constructor(variant?: RtmlTable['variant'], key?: NodeKey) {
    super(key);
    this.__variant = variant;
  }

  getVariant(): RtmlTable['variant'] | undefined {
    return this.getLatest().__variant;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    // The ledger look from article-body.css. The layout/contents variants
    // keep their grid rendering in the editor (data-variant='layout' turns
    // cells into display:block, which would fight table editing), so the
    // variant is preserved in the model but not painted here.
    const table = dom.tagName === 'TABLE' ? dom : dom.querySelector('table');
    table?.classList.add('rt-table');
    return dom;
  }

  exportJSON(): SerializedRtmlTableNode {
    return {
      ...super.exportJSON(),
      type: 'rtml-table',
      variant: this.__variant,
    };
  }

  static importJSON(json: SerializedRtmlTableNode): RtmlTableNode {
    return $createRtmlTableNode(json.variant).updateFromJSON(json);
  }
}

export function $createRtmlTableNode(
  variant?: RtmlTable['variant'],
): RtmlTableNode {
  return $applyNodeReplacement(new RtmlTableNode(variant));
}

/* ------------------------------------------------------------------ *
 * RtmlButtonNode — block CTA with editable text
 * ------------------------------------------------------------------ */

type SerializedRtmlButtonNode = Spread<
  { href: string; variant?: string },
  SerializedElementNode
>;

export class RtmlButtonNode extends ElementNode {
  __href: string;
  __variant?: string;

  static getType(): string {
    return 'rtml-button';
  }

  static clone(node: RtmlButtonNode): RtmlButtonNode {
    return new RtmlButtonNode(node.__href, node.__variant, node.__key);
  }

  constructor(href: string, variant?: string, key?: NodeKey) {
    super(key);
    this.__href = href;
    this.__variant = variant;
  }

  getHref(): string {
    return this.getLatest().__href;
  }

  setHref(href: string): void {
    this.getWritable().__href = href;
  }

  getVariant(): string | undefined {
    return this.getLatest().__variant;
  }

  setVariant(variant: string | undefined): void {
    this.getWritable().__variant = variant || undefined;
  }

  canBeEmpty(): boolean {
    return false;
  }

  createDOM(): HTMLElement {
    // Styled by article-body.css exactly like the rendered <a class="rt-button">;
    // a div here so clicks edit instead of navigating.
    const el = document.createElement('div');
    el.className = 'rt-button';
    if (this.__variant) el.dataset.variant = this.__variant;
    el.title = `→ ${this.__href}`;
    return el;
  }

  updateDOM(prevNode: RtmlButtonNode, dom: HTMLElement): boolean {
    if (prevNode.__href !== this.__href) dom.title = `→ ${this.__href}`;
    if (prevNode.__variant !== this.__variant) {
      if (this.__variant) dom.dataset.variant = this.__variant;
      else delete dom.dataset.variant;
    }
    return false;
  }

  // Enter at the end escapes into a fresh paragraph instead of splitting
  // the CTA into two buttons (same behavior as headings).
  insertNewAfter(
    _selection: RangeSelection,
    restoreSelection = true,
  ): ParagraphNode {
    const paragraph = $createParagraphNode();
    this.insertAfter(paragraph, restoreSelection);
    return paragraph;
  }

  collapseAtStart(): boolean {
    const paragraph = $createParagraphNode();
    paragraph.append(...this.getChildren());
    this.replace(paragraph);
    return true;
  }

  exportJSON(): SerializedRtmlButtonNode {
    return {
      ...super.exportJSON(),
      type: 'rtml-button',
      href: this.__href,
      variant: this.__variant,
    };
  }

  static importJSON(json: SerializedRtmlButtonNode): RtmlButtonNode {
    return $createRtmlButtonNode(json.href, json.variant).updateFromJSON(json);
  }
}

export function $createRtmlButtonNode(
  href: string,
  variant?: string,
): RtmlButtonNode {
  return $applyNodeReplacement(new RtmlButtonNode(href, variant));
}

/* ------------------------------------------------------------------ *
 * TimeWrapperNode — inline <time> with editable text
 * ------------------------------------------------------------------ */

type SerializedTimeWrapperNode = Spread<
  { datetime: string },
  SerializedElementNode
>;

export class TimeWrapperNode extends ElementNode {
  __datetime: string;

  static getType(): string {
    return 'rtml-time';
  }

  static clone(node: TimeWrapperNode): TimeWrapperNode {
    return new TimeWrapperNode(node.__datetime, node.__key);
  }

  constructor(datetime: string, key?: NodeKey) {
    super(key);
    this.__datetime = datetime;
  }

  isInline(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return false;
  }

  getDatetime(): string {
    return this.getLatest().__datetime;
  }

  setDatetime(datetime: string): void {
    this.getWritable().__datetime = datetime;
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'rtml-wrap rtml-wrap--time';
    el.title = `time: ${this.__datetime}`;
    return el;
  }

  updateDOM(prevNode: TimeWrapperNode, dom: HTMLElement): boolean {
    if (prevNode.__datetime !== this.__datetime) {
      dom.title = `time: ${this.__datetime}`;
    }
    return false;
  }

  exportJSON(): SerializedTimeWrapperNode {
    return {
      ...super.exportJSON(),
      type: 'rtml-time',
      datetime: this.__datetime,
    };
  }

  static importJSON(json: SerializedTimeWrapperNode): TimeWrapperNode {
    return $createTimeWrapperNode(json.datetime).updateFromJSON(json);
  }
}

export function $createTimeWrapperNode(datetime: string): TimeWrapperNode {
  return $applyNodeReplacement(new TimeWrapperNode(datetime));
}

/* ------------------------------------------------------------------ *
 * EventWrapperNode — inline event annotation with editable text
 * ------------------------------------------------------------------ */

type SerializedEventWrapperNode = Spread<
  { eventId: string; start: string; end?: string },
  SerializedElementNode
>;

export class EventWrapperNode extends ElementNode {
  __eventId: string;
  __start: string;
  __end?: string;

  static getType(): string {
    return 'rtml-event';
  }

  static clone(node: EventWrapperNode): EventWrapperNode {
    return new EventWrapperNode(
      node.__eventId,
      node.__start,
      node.__end,
      node.__key,
    );
  }

  constructor(eventId: string, start: string, end?: string, key?: NodeKey) {
    super(key);
    this.__eventId = eventId;
    this.__start = start;
    this.__end = end;
  }

  isInline(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return false;
  }

  getEventId(): string {
    return this.getLatest().__eventId;
  }

  setEventId(eventId: string): void {
    this.getWritable().__eventId = eventId;
  }

  getStart(): string {
    return this.getLatest().__start;
  }

  setStart(start: string): void {
    this.getWritable().__start = start;
  }

  getEnd(): string | undefined {
    return this.getLatest().__end;
  }

  setEnd(end: string | undefined): void {
    this.getWritable().__end = end || undefined;
  }

  private title(): string {
    return `event ${this.__eventId}: ${this.__start}${this.__end ? ` → ${this.__end}` : ''}`;
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'rtml-wrap rtml-wrap--event';
    el.title = this.title();
    return el;
  }

  updateDOM(prevNode: EventWrapperNode, dom: HTMLElement): boolean {
    if (
      prevNode.__eventId !== this.__eventId ||
      prevNode.__start !== this.__start ||
      prevNode.__end !== this.__end
    ) {
      dom.title = this.title();
    }
    return false;
  }

  exportJSON(): SerializedEventWrapperNode {
    return {
      ...super.exportJSON(),
      type: 'rtml-event',
      eventId: this.__eventId,
      start: this.__start,
      end: this.__end,
    };
  }

  static importJSON(json: SerializedEventWrapperNode): EventWrapperNode {
    return $createEventWrapperNode(
      json.eventId,
      json.start,
      json.end,
    ).updateFromJSON(json);
  }
}

export function $createEventWrapperNode(
  eventId: string,
  start: string,
  end?: string,
): EventWrapperNode {
  return $applyNodeReplacement(new EventWrapperNode(eventId, start, end));
}

/* ------------------------------------------------------------------ *
 * BadgeChipNode / IconChipNode — atomic inline decorations
 * ------------------------------------------------------------------ */

type SerializedBadgeChipNode = Spread<
  { badge: RtmlBadge },
  SerializedLexicalNode
>;

export class BadgeChipNode extends DecoratorNode<JSX.Element> {
  __badge: RtmlBadge;

  static getType(): string {
    return 'rtml-badge';
  }

  static clone(node: BadgeChipNode): BadgeChipNode {
    return new BadgeChipNode(node.__badge, node.__key);
  }

  constructor(badge: RtmlBadge, key?: NodeKey) {
    super(key);
    this.__badge = badge;
  }

  isInline(): boolean {
    return true;
  }

  getBadge(): RtmlBadge {
    return this.getLatest().__badge;
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'rtml-inline-chip';
    return el;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    // Same class + data-variant renderBlocks emits, so the shared
    // article-body.css styles it exactly like the public site.
    return (
      <span
        className="rt-badge"
        data-variant={this.__badge.variant}
        title="badge (preserved)"
      >
        {this.__badge.text}
      </span>
    );
  }

  exportJSON(): SerializedBadgeChipNode {
    return {
      ...super.exportJSON(),
      type: 'rtml-badge',
      badge: this.__badge,
    };
  }

  static importJSON(json: SerializedBadgeChipNode): BadgeChipNode {
    return $createBadgeChipNode(json.badge);
  }
}

export function $createBadgeChipNode(badge: RtmlBadge): BadgeChipNode {
  return $applyNodeReplacement(new BadgeChipNode(badge));
}

type SerializedIconChipNode = Spread<{ icon: RtmlIcon }, SerializedLexicalNode>;

export class IconChipNode extends DecoratorNode<JSX.Element> {
  __icon: RtmlIcon;

  static getType(): string {
    return 'rtml-icon';
  }

  static clone(node: IconChipNode): IconChipNode {
    return new IconChipNode(node.__icon, node.__key);
  }

  constructor(icon: RtmlIcon, key?: NodeKey) {
    super(key);
    this.__icon = icon;
  }

  isInline(): boolean {
    return true;
  }

  getIcon(): RtmlIcon {
    return this.getLatest().__icon;
  }

  createDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'rtml-inline-chip';
    return el;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return (
      <img
        className="rt-icon"
        src={this.__icon.src}
        alt={this.__icon.alt ?? ''}
        title="icon (preserved)"
      />
    );
  }

  exportJSON(): SerializedIconChipNode {
    return {
      ...super.exportJSON(),
      type: 'rtml-icon',
      icon: this.__icon,
    };
  }

  static importJSON(json: SerializedIconChipNode): IconChipNode {
    return $createIconChipNode(json.icon);
  }
}

export function $createIconChipNode(icon: RtmlIcon): IconChipNode {
  return $applyNodeReplacement(new IconChipNode(icon));
}

/* ------------------------------------------------------------------ *
 * PreservedBlockNode — verbatim JSON block with preview card
 * ------------------------------------------------------------------ */

type SerializedPreservedBlockNode = Spread<
  { block: Block },
  SerializedLexicalNode
>;

export class PreservedBlockNode extends DecoratorNode<JSX.Element> {
  __block: Block;

  static getType(): string {
    return 'rtml-preserved';
  }

  static clone(node: PreservedBlockNode): PreservedBlockNode {
    return new PreservedBlockNode(node.__block, node.__key);
  }

  constructor(block: Block, key?: NodeKey) {
    super(key);
    this.__block = block;
  }

  isInline(): boolean {
    return false;
  }

  getBlock(): Block {
    return this.getLatest().__block;
  }

  setBlock(block: Block): void {
    this.getWritable().__block = block;
  }

  createDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'rtml-preserved';
    return el;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return <PreservedBlockView nodeKey={this.getKey()} block={this.__block} />;
  }

  exportJSON(): SerializedPreservedBlockNode {
    return {
      ...super.exportJSON(),
      type: 'rtml-preserved',
      block: this.__block,
    };
  }

  static importJSON(json: SerializedPreservedBlockNode): PreservedBlockNode {
    return $createPreservedBlockNode(json.block);
  }
}

export function $createPreservedBlockNode(block: Block): PreservedBlockNode {
  return $applyNodeReplacement(new PreservedBlockNode(block));
}

/** "infoBox" → "Info box" */
function humanizeType(type: string): string {
  const spaced = type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function PreservedBlockView({
  nodeKey,
  block,
}: {
  nodeKey: NodeKey;
  block: Block;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const { imageSrc } = useContext(PreservedRenderContext);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [openingImage, setOpeningImage] = useState(false);

  // For image blocks whose src maps to a stored image, offer a jump to that
  // image's edit screen. Non-mirrorable images (off-site, data: URIs) have no
  // library row, so no key and no button.
  const imgKey = block.type === 'image' ? imageKey(block.src) : null;

  async function openImageEditor() {
    if (!imgKey) return;
    setOpeningImage(true);
    try {
      const id = await resolveImageId(imgKey);
      if (id == null) {
        alert(
          "This image isn't in the image library yet — it's mirrored the first time the workflow runs on this article.",
        );
      } else {
        window.open(`/images/${id}`, '_blank', 'noopener');
      }
    } catch (err) {
      console.error(err);
      alert('Could not look up this image. Check the console.');
    }
    setOpeningImage(false);
  }

  const previewHtml = useMemo(() => {
    try {
      return renderBlocks([block], { imageSrc });
    } catch (err) {
      return `<p class="rtml-preserved__render-error">Preview failed: ${err instanceof Error ? err.message : String(err)}</p>`;
    }
  }, [block, imageSrc]);

  function withNode(fn: (node: PreservedBlockNode) => void) {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node instanceof PreservedBlockNode) fn(node);
    });
  }

  function moveUp() {
    withNode((node) => {
      const prev = node.getPreviousSibling();
      if (prev) prev.insertBefore(node);
    });
  }

  function moveDown() {
    withNode((node) => {
      const next = node.getNextSibling();
      if (next) next.insertAfter(node);
    });
  }

  function remove() {
    if (!confirm(`Remove this ${humanizeType(block.type)} block?`)) return;
    withNode((node) => node.remove());
  }

  function openJson() {
    setJsonText(JSON.stringify(block, null, 2));
    setJsonError(null);
    setJsonOpen(true);
  }

  function applyJson() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      setJsonError('Block must be an object with a string "type" field.');
      return;
    }
    withNode((node) => node.setBlock(parsed as Block));
    setJsonOpen(false);
  }

  return (
    <div className="rtml-preserved__card">
      <div className="rtml-preserved__bar">
        <span className="rtml-preserved__type">{humanizeType(block.type)}</span>
        <span className="rtml-preserved__hint">preserved as-is</span>
        <span className="rtml-preserved__actions">
          {imgKey && (
            <button
              type="button"
              className="rtml-preserved__edit-image"
              onClick={openImageEditor}
              disabled={openingImage}
              title="Open this image's edit page"
            >
              {openingImage ? '…' : '✎ Edit image'}
            </button>
          )}
          <button type="button" onClick={moveUp} title="Move up">
            ↑
          </button>
          <button type="button" onClick={moveDown} title="Move down">
            ↓
          </button>
          <button
            type="button"
            onClick={jsonOpen ? () => setJsonOpen(false) : openJson}
          >
            {jsonOpen ? 'Close JSON' : 'Edit JSON'}
          </button>
          <button
            type="button"
            className="rtml-preserved__remove"
            onClick={remove}
            title="Remove block"
          >
            ✕
          </button>
        </span>
      </div>
      {jsonOpen ? (
        <div className="rtml-preserved__json">
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            spellCheck={false}
            rows={Math.min(20, jsonText.split('\n').length + 1)}
          />
          {jsonError && <p className="rtml-preserved__error">{jsonError}</p>}
          <div className="rtml-preserved__json-actions">
            <button type="button" onClick={applyJson}>
              Apply
            </button>
            <button type="button" onClick={() => setJsonOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          className="rtml-preserved__preview article-body"
          // Links inside the preview must not navigate away from the editor.
          onClickCapture={(e) => e.preventDefault()}
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      )}
    </div>
  );
}
