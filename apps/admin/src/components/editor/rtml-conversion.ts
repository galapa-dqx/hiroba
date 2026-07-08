/**
 * RTML ⇄ Lexical conversion for the article editor.
 *
 * Import maps the text tier onto native Lexical nodes (inline formatting
 * collapses onto TextNode format/style bits) and wraps everything else in
 * PreservedBlockNode so it round-trips verbatim. Export rebuilds the RTML
 * tree, nesting formats back as strong → emphasis → color in that order —
 * a canonical nesting, so a strong(color(text)) source re-exports the same
 * way it came in, just normalized.
 */

import { $createLinkNode, $isLinkNode } from '@lexical/link';
import {
  $createListItemNode,
  $isListItemNode,
  $isListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
} from '@lexical/react/LexicalHorizontalRuleNode';
import { $isHeadingNode } from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableRowNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellHeaderStates,
  type TableCellNode,
  type TableNode,
} from '@lexical/table';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
} from 'lexical';

import {
  isInline,
  type Block,
  type ContentNode,
  type Inline,
  type HeadingNode as RtmlHeading,
  type LinkNode as RtmlLink,
  type ListNode as RtmlList,
  type ParagraphNode as RtmlParagraph,
  type TableNode as RtmlTable,
  type TableCell as RtmlTableCell,
} from '@hiroba/richtext';

import {
  $createBadgeChipNode,
  $createEventWrapperNode,
  $createIconChipNode,
  $createPreservedBlockNode,
  $createRtmlButtonNode,
  $createRtmlHeadingNode,
  $createRtmlListNode,
  $createRtmlTableNode,
  $createTimeWrapperNode,
  BadgeChipNode,
  EventWrapperNode,
  IconChipNode,
  PreservedBlockNode,
  RtmlButtonNode,
  RtmlHeadingNode,
  RtmlListNode,
  RtmlTableNode,
  TimeWrapperNode,
} from './rtml-nodes';

/* ------------------------------------------------------------------ *
 * Import: RTML → Lexical
 * ------------------------------------------------------------------ */

type InlineFormat = { bold?: boolean; italic?: boolean; color?: string };

function $createInlineNodes(
  children: Inline[],
  fmt: InlineFormat,
): LexicalNode[] {
  const out: LexicalNode[] = [];
  for (const child of children) {
    if (typeof child === 'string') {
      const text = $createTextNode(child);
      if (fmt.bold) text.toggleFormat('bold');
      if (fmt.italic) text.toggleFormat('italic');
      if (fmt.color) text.setStyle(`color: ${fmt.color}`);
      out.push(text);
      continue;
    }
    switch (child.type) {
      case 'break':
        out.push($createLineBreakNode());
        break;
      case 'strong':
        out.push(...$createInlineNodes(child.children, { ...fmt, bold: true }));
        break;
      case 'emphasis':
        out.push(
          ...$createInlineNodes(child.children, { ...fmt, italic: true }),
        );
        break;
      case 'color':
        out.push(
          ...$createInlineNodes(child.children, { ...fmt, color: child.value }),
        );
        break;
      case 'link': {
        const link = $createLinkNode(child.href, {
          target: child.external ? '_blank' : null,
        });
        link.append(...$createInlineNodes(child.children, fmt));
        out.push(link);
        break;
      }
      case 'time': {
        const wrap = $createTimeWrapperNode(child.datetime);
        wrap.append(...$createInlineNodes(child.children, fmt));
        out.push(wrap);
        break;
      }
      case 'event': {
        const wrap = $createEventWrapperNode(child.id, child.start, child.end);
        wrap.append(...$createInlineNodes(child.children, fmt));
        out.push(wrap);
        break;
      }
      case 'badge':
        out.push($createBadgeChipNode(child));
        break;
      case 'icon':
        out.push($createIconChipNode(child));
        break;
    }
  }
  return out;
}

/** A list maps natively when each item is inline content, a single paragraph
 * (unwrapped into the item), or a single editable nested list. Items mixing
 * several blocks stay preserved — Lexical list items can't hold them. */
function isEditableList(block: RtmlList): boolean {
  return block.items.every((item) => {
    if (item.children.every(isInline)) return true;
    if (item.children.length !== 1) return false;
    const only = item.children[0];
    if (isInline(only)) return true;
    if (only.type === 'paragraph') return true;
    return only.type === 'list' && isEditableList(only);
  });
}

function $createListFromRtml(block: RtmlList): RtmlListNode {
  const list = $createRtmlListNode(
    block.ordered ? 'number' : 'bullet',
    block.variant,
  );
  for (const item of block.items) {
    const li = $createListItemNode();
    const only = item.children.length === 1 ? item.children[0] : null;
    if (only && !isInline(only) && only.type === 'paragraph') {
      li.append(...$createInlineNodes(only.children, {}));
    } else if (only && !isInline(only) && only.type === 'list') {
      li.append($createListFromRtml(only));
    } else {
      li.append(...$createInlineNodes(item.children as Inline[], {}));
    }
    list.append(li);
  }
  return list;
}

/** Fill a table cell (or any element) from RTML's mixed ContentNode list:
 * consecutive inlines group into one paragraph, blocks convert recursively. */
function $appendContentNodes(
  parent: TableCellNode | ListItemNode,
  children: ContentNode[],
): void {
  let inlineRun: Inline[] = [];
  const flush = () => {
    if (inlineRun.length === 0) return;
    const p = $createParagraphNode();
    p.append(...$createInlineNodes(inlineRun, {}));
    parent.append(p);
    inlineRun = [];
  };
  for (const child of children) {
    if (isInline(child)) {
      inlineRun.push(child);
    } else {
      flush();
      parent.append($createBlockNode(child));
    }
  }
  flush();
  // An empty cell still needs a paragraph to place the caret in.
  if (parent.getChildrenSize() === 0) parent.append($createParagraphNode());
}

function $createCellFromRtml(
  cell: RtmlTableCell,
  headerState: number,
): TableCellNode {
  // ROW marks membership in the table's `headers` row; COLUMN carries the
  // per-cell `header` flag. They compose bitwise, so a flagged cell inside
  // the headers row keeps both and round-trips exactly.
  const state =
    headerState |
    (cell.header
      ? TableCellHeaderStates.COLUMN
      : TableCellHeaderStates.NO_STATUS);
  const cellNode = $createTableCellNode(state, cell.colSpan ?? 1);
  if (cell.rowSpan && cell.rowSpan > 1) cellNode.setRowSpan(cell.rowSpan);
  $appendContentNodes(cellNode, cell.children);
  return cellNode;
}

function $createTableFromRtml(block: RtmlTable): RtmlTableNode {
  const table = $createRtmlTableNode(block.variant);
  if (block.headers) {
    const row = $createTableRowNode();
    for (const cell of block.headers) {
      row.append($createCellFromRtml(cell, TableCellHeaderStates.ROW));
    }
    table.append(row);
  }
  for (const cells of block.rows) {
    const row = $createTableRowNode();
    for (const cell of cells) {
      row.append($createCellFromRtml(cell, TableCellHeaderStates.NO_STATUS));
    }
    table.append(row);
  }
  return table;
}

function $createBlockNode(block: Block): LexicalNode {
  switch (block.type) {
    case 'paragraph': {
      const p = $createParagraphNode();
      if (block.align) p.setFormat(block.align);
      p.append(...$createInlineNodes(block.children, {}));
      return p;
    }
    case 'heading': {
      const h = $createRtmlHeadingNode(
        `h${block.level}`,
        block.variant,
        block.anchor,
      );
      h.append(...$createInlineNodes(block.children, {}));
      return h;
    }
    case 'divider':
      return $createHorizontalRuleNode();
    case 'list':
      if (isEditableList(block)) return $createListFromRtml(block);
      return $createPreservedBlockNode(block);
    case 'button': {
      const btn = $createRtmlButtonNode(block.href, block.variant);
      btn.append(...$createInlineNodes(block.children, {}));
      return btn;
    }
    case 'table':
      return $createTableFromRtml(block);
    default:
      return $createPreservedBlockNode(block);
  }
}

/** Replace the editor contents with the given RTML block tree. Must run
 * inside an editor.update() (or as the initial editor state builder). */
export function $populateEditorFromBlocks(blocks: Block[]): void {
  const root = $getRoot();
  root.clear();
  for (const block of blocks) {
    root.append($createBlockNode(block));
  }
  if (root.getChildrenSize() === 0) {
    root.append($createParagraphNode());
  }
}

/* ------------------------------------------------------------------ *
 * Export: Lexical → RTML
 * ------------------------------------------------------------------ */

/** Pull a `color: …` value out of a Lexical text-node style string,
 * normalizing rgb()/rgba() (which browsers sometimes substitute) to hex. */
function extractColor(style: string): string | undefined {
  const match = /(?:^|;)\s*color:\s*([^;]+)/.exec(style);
  if (!match) return undefined;
  const value = match[1].trim();
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) return value;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (rgb) {
    const hex = rgb
      .slice(1, 4)
      .map((c) => Math.min(255, Number(c)).toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  }
  return undefined;
}

/** Push an inline onto the list, merging adjacent plain strings so the
 * exported tree stays canonical (RTML never has two neighboring text nodes). */
function appendInline(out: Inline[], inline: Inline): void {
  const last = out[out.length - 1];
  if (typeof inline === 'string' && typeof last === 'string') {
    out[out.length - 1] = last + inline;
    return;
  }
  out.push(inline);
}

function $exportInlineNode(node: LexicalNode): Inline[] {
  if ($isTextNode(node)) {
    const text = node.getTextContent();
    if (!text) return [];
    let inline: Inline = text;
    const color = extractColor(node.getStyle());
    if (color) inline = { type: 'color', value: color, children: [inline] };
    if (node.hasFormat('italic')) {
      inline = { type: 'emphasis', children: [inline] };
    }
    if (node.hasFormat('bold')) inline = { type: 'strong', children: [inline] };
    return [inline];
  }
  if ($isLineBreakNode(node)) return [{ type: 'break' }];
  if ($isLinkNode(node)) {
    const link: RtmlLink = {
      type: 'link',
      href: node.getURL(),
      children: $exportInlines(node),
    };
    if (node.getTarget() === '_blank') link.external = true;
    return [link];
  }
  if (node instanceof TimeWrapperNode) {
    return [
      {
        type: 'time',
        datetime: node.getDatetime(),
        children: $exportInlines(node),
      },
    ];
  }
  if (node instanceof EventWrapperNode) {
    const end = node.getEnd();
    return [
      {
        type: 'event',
        id: node.getEventId(),
        start: node.getStart(),
        ...(end ? { end } : {}),
        children: $exportInlines(node),
      },
    ];
  }
  if (node instanceof BadgeChipNode) return [node.getBadge()];
  if (node instanceof IconChipNode) return [node.getIcon()];
  // Unknown inline element (e.g. pasted markup): flatten to its children.
  if ($isElementNode(node)) return $exportInlines(node);
  const text = node.getTextContent();
  return text ? [text] : [];
}

function $exportInlines(element: ElementNode): Inline[] {
  const out: Inline[] = [];
  for (const child of element.getChildren()) {
    for (const inline of $exportInlineNode(child)) {
      appendInline(out, inline);
    }
  }
  return out;
}

function $exportList(list: ListNode): RtmlList {
  const items: RtmlList['items'] = [];
  for (const li of list.getChildren()) {
    if (!$isListItemNode(li)) continue;
    const children: ContentNode[] = [];
    for (const child of li.getChildren()) {
      if ($isListNode(child)) {
        children.push($exportList(child));
      } else {
        for (const inline of $exportInlineNode(child)) {
          if (typeof inline === 'string' || children.every(isInline)) {
            appendInline(children as Inline[], inline);
          } else {
            children.push(inline);
          }
        }
      }
    }
    items.push({ children });
  }
  const block: RtmlList = {
    type: 'list',
    ordered: list.getListType() === 'number',
    items,
  };
  if (list instanceof RtmlListNode) {
    const variant = list.getVariant();
    if (variant) block.variant = variant;
  }
  return block;
}

/** Cell contents: a lone unaligned paragraph unwraps back to inline children
 * (the inverse of $appendContentNodes); anything richer exports as blocks. */
function $exportCellChildren(cell: TableCellNode): ContentNode[] {
  const kids = cell.getChildren();
  if (
    kids.length === 1 &&
    $isParagraphNode(kids[0]) &&
    !kids[0].getFormatType()
  ) {
    return $exportInlines(kids[0]);
  }
  const out: ContentNode[] = [];
  for (const kid of kids) {
    const block = $exportBlock(kid);
    if (block) out.push(block);
  }
  return out;
}

function $exportTable(table: TableNode): RtmlTable {
  const lexRows = table.getChildren().filter($isTableRowNode);
  const allCells = lexRows.map((row) =>
    row.getChildren().filter($isTableCellNode),
  );

  // A first row of ROW-header cells came from (and goes back to) `headers`;
  // COLUMN-header cells inside body rows round-trip as per-cell `header` flags.
  const firstRowIsHeader =
    allCells.length > 0 &&
    allCells[0].length > 0 &&
    allCells[0].every((cell) => cell.hasHeaderState(TableCellHeaderStates.ROW));

  const exportCell = (cell: TableCellNode) => {
    const out: RtmlTableCell = { children: $exportCellChildren(cell) };
    if (cell.hasHeaderState(TableCellHeaderStates.COLUMN)) {
      out.header = true;
    }
    const colSpan = cell.getColSpan();
    const rowSpan = cell.getRowSpan();
    if (colSpan > 1) out.colSpan = colSpan as RtmlTableCell['colSpan'];
    if (rowSpan > 1) out.rowSpan = rowSpan as RtmlTableCell['rowSpan'];
    return out;
  };

  const bodyCells = firstRowIsHeader ? allCells.slice(1) : allCells;
  const block: RtmlTable = {
    type: 'table',
    rows: bodyCells.map((cells) => cells.map(exportCell)),
  };
  if (firstRowIsHeader) {
    block.headers = allCells[0].map(exportCell);
  }
  if (table instanceof RtmlTableNode) {
    const variant = table.getVariant();
    if (variant) block.variant = variant;
  }
  return block;
}

function $exportBlock(node: LexicalNode): Block | null {
  if (node instanceof PreservedBlockNode) return node.getBlock();
  if ($isHorizontalRuleNode(node)) return { type: 'divider' };
  if ($isHeadingNode(node)) {
    const level = Number(node.getTag().slice(1));
    const heading: RtmlHeading = {
      type: 'heading',
      level: (level >= 1 && level <= 4 ? level : 2) as RtmlHeading['level'],
      children: $exportInlines(node),
    };
    if (node instanceof RtmlHeadingNode) {
      const variant = node.getVariant();
      const anchor = node.getAnchor();
      if (variant) heading.variant = variant;
      if (anchor) heading.anchor = anchor;
    }
    return heading;
  }
  if ($isListNode(node)) return $exportList(node);
  if ($isTableNode(node)) return $exportTable(node);
  if (node instanceof RtmlButtonNode) {
    const button: Block = {
      type: 'button',
      href: node.getHref(),
      children: $exportInlines(node),
    };
    const variant = node.getVariant();
    if (variant) button.variant = variant;
    return button;
  }
  if ($isParagraphNode(node)) {
    const paragraph: RtmlParagraph = {
      type: 'paragraph',
      children: $exportInlines(node),
    };
    const format = node.getFormatType();
    if (format === 'left' || format === 'center' || format === 'right') {
      paragraph.align = format;
    }
    return paragraph;
  }
  // Unknown element (e.g. a pasted quote): degrade to a paragraph.
  if ($isElementNode(node)) {
    return { type: 'paragraph', children: $exportInlines(node) };
  }
  const text = node.getTextContent();
  return text ? { type: 'paragraph', children: [text] } : null;
}

/** Serialize the current editor contents back to an RTML block tree. Must
 * run inside an editorState.read(). Trailing empty paragraphs (an editing
 * artifact) are trimmed. */
export function $exportBlocksFromEditor(): Block[] {
  const blocks: Block[] = [];
  for (const child of $getRoot().getChildren()) {
    const block = $exportBlock(child);
    if (block) blocks.push(block);
  }
  while (blocks.length > 0) {
    const last = blocks[blocks.length - 1];
    if (last.type === 'paragraph' && last.children.length === 0) blocks.pop();
    else break;
  }
  return blocks;
}
