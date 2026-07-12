/**
 * RtmlEditor — a Lexical rich-text editor over the RTML block model.
 *
 * The component owns the Lexical composer + toolbar; conversion to and from
 * RTML lives in ./rtml-conversion. The parent pulls the edited tree out via
 * an imperative handle (`getBlocks()`) when saving.
 */

import { $isLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
} from '@lexical/list';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import {
  HorizontalRuleNode,
  INSERT_HORIZONTAL_RULE_COMMAND,
} from '@lexical/react/LexicalHorizontalRuleNode';
import { HorizontalRulePlugin } from '@lexical/react/LexicalHorizontalRulePlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import {
  $isHeadingNode,
  HeadingNode,
  type HeadingTagType,
} from '@lexical/rich-text';
import { $patchStyleText, $setBlocksType } from '@lexical/selection';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { mergeRegister } from '@lexical/utils';
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  type ElementFormatType,
  type TextFormatType,
} from 'lexical';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type JSX,
  type Ref,
} from 'react';

import type { Block } from '@hiroba/richtext';

import InlineNodeEditor from './InlineNodeEditor';
import {
  $exportBlocksFromEditor,
  $populateEditorFromBlocks,
} from './rtml-conversion';
import {
  $createRtmlHeadingNode,
  BadgeChipNode,
  EventWrapperNode,
  IconChipNode,
  PreservedBlockNode,
  PreservedRenderContext,
  RtmlButtonNode,
  RtmlHeadingNode,
  RtmlListNode,
  RtmlTableNode,
  TimeWrapperNode,
} from './rtml-nodes';

export type RtmlEditorHandle = {
  /** Serialize the current editor contents back to an RTML block tree. */
  getBlocks: () => Block[];
};

type BlockType = 'paragraph' | HeadingTagType | 'bullet' | 'number';

function HandleBridge({ handleRef }: { handleRef: Ref<RtmlEditorHandle> }) {
  const [editor] = useLexicalComposerContext();
  useImperativeHandle(
    handleRef,
    () => ({
      getBlocks: () => editor.getEditorState().read($exportBlocksFromEditor),
    }),
    [editor],
  );
  return null;
}

function Toolbar() {
  const [editor] = useLexicalComposerContext();
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [blockType, setBlockType] = useState<BlockType>('paragraph');
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isLink, setIsLink] = useState(false);

  useEffect(() => {
    function $updateToolbar() {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      setIsBold(selection.hasFormat('bold'));
      setIsItalic(selection.hasFormat('italic'));

      const anchorNode = selection.anchor.getNode();
      const parent = anchorNode.getParent();
      setIsLink($isLinkNode(parent) || $isLinkNode(anchorNode));

      const element =
        anchorNode.getKey() === 'root'
          ? anchorNode
          : anchorNode.getTopLevelElementOrThrow();
      if ($isListNode(element)) {
        setBlockType(element.getListType() === 'number' ? 'number' : 'bullet');
      } else if ($isHeadingNode(element)) {
        setBlockType(element.getTag());
      } else {
        setBlockType('paragraph');
      }
    }

    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read($updateToolbar);
      }),
      editor.registerCommand(
        CAN_UNDO_COMMAND,
        (payload) => {
          setCanUndo(payload);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        CAN_REDO_COMMAND,
        (payload) => {
          setCanRedo(payload);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor]);

  function changeBlockType(next: string) {
    if (next === 'bullet') {
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
      return;
    }
    if (next === 'number') {
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
      return;
    }
    if (blockType === 'bullet' || blockType === 'number') {
      editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    }
    editor.update(() => {
      const selection = $getSelection();
      if (next === 'paragraph') {
        $setBlocksType(selection, () => $createParagraphNode());
      } else {
        $setBlocksType(selection, () =>
          $createRtmlHeadingNode(next as HeadingTagType),
        );
      }
    });
  }

  function formatText(format: TextFormatType) {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  }

  function alignText(format: ElementFormatType) {
    editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, format);
  }

  function applyColor(color: string | null) {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $patchStyleText(selection, { color });
      }
    });
  }

  function toggleLink() {
    if (isLink) {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
      return;
    }
    const url = prompt('Link URL:');
    if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
  }

  return (
    <div className="rtml-toolbar">
      <button
        type="button"
        disabled={!canUndo}
        onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
        title="Undo"
      >
        ↺
      </button>
      <button
        type="button"
        disabled={!canRedo}
        onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
        title="Redo"
      >
        ↻
      </button>
      <span className="rtml-toolbar__sep" />
      <select
        value={blockType}
        onChange={(e) => changeBlockType(e.target.value)}
        title="Block type"
      >
        <option value="paragraph">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="h4">Heading 4</option>
        <option value="bullet">Bulleted list</option>
        <option value="number">Numbered list</option>
      </select>
      <span className="rtml-toolbar__sep" />
      <button
        type="button"
        className={isBold ? 'is-active' : ''}
        onClick={() => formatText('bold')}
        title="Bold"
      >
        <b>B</b>
      </button>
      <button
        type="button"
        className={isItalic ? 'is-active' : ''}
        onClick={() => formatText('italic')}
        title="Italic"
      >
        <i>I</i>
      </button>
      <label className="rtml-toolbar__color" title="Text color">
        A
        <input type="color" onChange={(e) => applyColor(e.target.value)} />
      </label>
      <button
        type="button"
        onClick={() => applyColor(null)}
        title="Clear text color"
      >
        A̶
      </button>
      <button
        type="button"
        className={isLink ? 'is-active' : ''}
        onClick={toggleLink}
        title={isLink ? 'Remove link' : 'Insert link'}
      >
        🔗
      </button>
      <span className="rtml-toolbar__sep" />
      <button
        type="button"
        onClick={() => alignText('left')}
        title="Align left"
      >
        ⇤
      </button>
      <button
        type="button"
        onClick={() => alignText('center')}
        title="Align center"
      >
        ↔
      </button>
      <button
        type="button"
        onClick={() => alignText('right')}
        title="Align right"
      >
        ⇥
      </button>
      <span className="rtml-toolbar__sep" />
      <button
        type="button"
        onClick={() =>
          editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined)
        }
        title="Insert divider"
      >
        ―
      </button>
    </div>
  );
}

type RtmlEditorProps = {
  /** The block tree to load. Changing this prop after mount has no effect. */
  initialBlocks: Block[];
  onDirty?: () => void;
  /**
   * Rewrites image URLs in preserved-block previews (e.g. to serve a language's
   * localized rasters). Display-only — the stored blocks keep their source URLs.
   */
  imageSrc?: (src: string) => string;
};

const RtmlEditor = forwardRef<RtmlEditorHandle, RtmlEditorProps>(
  function RtmlEditor({ initialBlocks, onDirty, imageSrc }, ref): JSX.Element {
    const initialConfig = {
      namespace: 'rtml-editor',
      onError(error: Error) {
        console.error(error);
      },
      nodes: [
        HeadingNode,
        RtmlHeadingNode,
        {
          replace: HeadingNode,
          with: (node: HeadingNode) => new RtmlHeadingNode(node.getTag()),
          withKlass: RtmlHeadingNode,
        },
        ListNode,
        RtmlListNode,
        {
          replace: ListNode,
          with: (node: ListNode) =>
            new RtmlListNode(node.getListType(), node.getStart()),
          withKlass: RtmlListNode,
        },
        ListItemNode,
        TableNode,
        RtmlTableNode,
        {
          replace: TableNode,
          with: () => new RtmlTableNode(),
          withKlass: RtmlTableNode,
        },
        TableRowNode,
        TableCellNode,
        RtmlButtonNode,
        LinkNode,
        HorizontalRuleNode,
        TimeWrapperNode,
        EventWrapperNode,
        BadgeChipNode,
        IconChipNode,
        PreservedBlockNode,
      ],
      editorState: () => $populateEditorFromBlocks(initialBlocks),
    };

    const renderContext = useMemo(() => ({ imageSrc }), [imageSrc]);

    return (
      <PreservedRenderContext.Provider value={renderContext}>
        <LexicalComposer initialConfig={initialConfig}>
          <div className="rtml-editor">
            <Toolbar />
            <div className="rtml-editor__body">
              <RichTextPlugin
                contentEditable={
                  <ContentEditable
                    className="rtml-editor__content article-body"
                    aria-placeholder="Write…"
                    placeholder={
                      <div className="rtml-editor__placeholder">Write…</div>
                    }
                  />
                }
                ErrorBoundary={LexicalErrorBoundary}
              />
            </div>
            <HistoryPlugin />
            <ListPlugin />
            <LinkPlugin />
            <TablePlugin />
            <HorizontalRulePlugin />
            <InlineNodeEditor />
            {onDirty && (
              <OnChangePlugin
                ignoreSelectionChange
                onChange={(_state, _editor, _tags) => onDirty()}
              />
            )}
            <HandleBridge handleRef={ref} />
          </div>
        </LexicalComposer>
      </PreservedRenderContext.Provider>
    );
  },
);

export default RtmlEditor;
