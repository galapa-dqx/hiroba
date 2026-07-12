/**
 * InlineNodeEditor — a floating popover for the RTML nodes whose *text* is
 * edited inline but whose non-linguistic attributes can't be typed into the
 * document: {@link TimeWrapperNode} (datetime), {@link EventWrapperNode}
 * (event id / start / end) and {@link RtmlButtonNode} (href / variant).
 *
 * When the caret lands inside one of these, a small panel pins itself beneath
 * the node with a field per attribute. Edits are held in a local draft and
 * committed onto the node on blur, so no editor update fires mid-keystroke
 * (which would fight the popover for focus). The panel dismisses only when the
 * caret moves to unrelated content *inside* the document — never when focus
 * merely leaves the editor for the popover's own inputs.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';

import {
  EventWrapperNode,
  RtmlButtonNode,
  TimeWrapperNode,
} from './rtml-nodes';

/** The attribute snapshot for whichever editable node the caret sits in. */
type Target =
  | { kind: 'time'; key: NodeKey; datetime: string }
  | { kind: 'event'; key: NodeKey; id: string; start: string; end: string }
  | { kind: 'button'; key: NodeKey; href: string; variant: string };

/** Resolve the nearest editable-attribute ancestor of the current selection. */
function $findTarget(): Target | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const anchor = selection.anchor.getNode();
  for (const node of [anchor, ...anchor.getParents()]) {
    if (node instanceof TimeWrapperNode) {
      return { kind: 'time', key: node.getKey(), datetime: node.getDatetime() };
    }
    if (node instanceof EventWrapperNode) {
      return {
        kind: 'event',
        key: node.getKey(),
        id: node.getEventId(),
        start: node.getStart(),
        end: node.getEnd() ?? '',
      };
    }
    if (node instanceof RtmlButtonNode) {
      return {
        kind: 'button',
        key: node.getKey(),
        href: node.getHref(),
        variant: node.getVariant() ?? '',
      };
    }
  }
  return null;
}

export default function InlineNodeEditor(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [target, setTarget] = useState<Target | null>(null);

  // Track the selection. Pin to an editable node whenever the caret is inside
  // one; dismiss only when the caret is elsewhere *and still in the document*
  // (root has focus), so tabbing into the popover's inputs never closes it.
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      const found = editorState.read($findTarget);
      if (found) {
        setTarget(found);
        return;
      }
      const root = editor.getRootElement();
      const active = document.activeElement;
      if (root && active && root.contains(active)) setTarget(null);
    });
  }, [editor]);

  if (!target) return null;
  // Remount per node (key) so each panel seeds its draft from the fresh target.
  return (
    <Panel
      key={target.key}
      editor={editor}
      target={target}
      onDone={() => setTarget(null)}
    />
  );
}

function Panel({
  editor,
  target,
  onDone,
}: {
  editor: LexicalEditor;
  target: Target;
  onDone: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Target>(target);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Anchor to the node. Fixed positioning sidesteps the editor's overflow
  // clipping; recompute as the page scrolls or resizes. Prefer just below the
  // node, but flip above when it would overflow the viewport bottom (a CTA
  // button at the end of the article can't scroll any lower), and clamp to the
  // viewport so the panel is always reachable.
  useLayoutEffect(() => {
    function place() {
      const el = editor.getElementByKey(target.key);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const m = 8;
      const ph = panelRef.current?.offsetHeight ?? 200;
      const pw = panelRef.current?.offsetWidth ?? 320;
      let top = rect.bottom + 6;
      if (top + ph + m > window.innerHeight && rect.top - ph - 6 >= m) {
        top = rect.top - ph - 6;
      }
      top = Math.max(m, Math.min(top, window.innerHeight - ph - m));
      const left = Math.max(m, Math.min(rect.left, window.innerWidth - pw - m));
      setPos({ top, left });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [editor, target.key]);

  /** Write the current draft back onto the node. */
  function commit(next: Target) {
    editor.update(() => {
      const node = $getNodeByKey(next.key);
      if (next.kind === 'time' && node instanceof TimeWrapperNode) {
        node.setDatetime(next.datetime);
      } else if (next.kind === 'event' && node instanceof EventWrapperNode) {
        node.setEventId(next.id);
        node.setStart(next.start);
        node.setEnd(next.end);
      } else if (next.kind === 'button' && node instanceof RtmlButtonNode) {
        node.setHref(next.href);
        node.setVariant(next.variant);
      }
    });
  }

  /**
   * Commit and dismiss (✓ / Enter / Escape). Clearing the Lexical selection is
   * what makes the dismissal stick: the caret is otherwise still inside the
   * node, so the update listener would immediately re-open the panel.
   */
  function dismiss() {
    commit(draft);
    editor.update(() => $setSelection(null));
    onDone();
  }

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder?: string,
  ) => (
    <label className="rtml-inline-editor__field">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => commit(draft)}
      />
    </label>
  );

  return (
    <div
      ref={panelRef}
      className="rtml-inline-editor"
      // Rendered off-screen (not display:none, so it can still be measured)
      // until the layout effect computes an on-screen position.
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? undefined : 'hidden',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          dismiss();
        }
      }}
    >
      <div className="rtml-inline-editor__head">
        <span className="rtml-inline-editor__kind">
          {draft.kind === 'time'
            ? 'Time'
            : draft.kind === 'event'
              ? 'Event'
              : 'Button'}
        </span>
        <button
          type="button"
          className="rtml-inline-editor__close"
          // Commit before the button steals focus (mousedown precedes blur),
          // then commit-and-dismiss on the click.
          onMouseDown={() => commit(draft)}
          onClick={dismiss}
          title="Done"
        >
          ✓
        </button>
      </div>

      {draft.kind === 'time' &&
        field(
          'Datetime',
          draft.datetime,
          (v) => setDraft({ ...draft, datetime: v }),
          '2026-07-13T05:59:00+09:00 or 2026-07-13',
        )}

      {draft.kind === 'event' && (
        <>
          {field('Event id', draft.id, (v) => setDraft({ ...draft, id: v }))}
          {field(
            'Start',
            draft.start,
            (v) => setDraft({ ...draft, start: v }),
            '2026-07-13T05:59:00+09:00',
          )}
          {field(
            'End',
            draft.end,
            (v) => setDraft({ ...draft, end: v }),
            '(optional)',
          )}
        </>
      )}

      {draft.kind === 'button' && (
        <>
          {field(
            'Destination URL',
            draft.href,
            (v) => setDraft({ ...draft, href: v }),
            'https://…',
          )}
          {field(
            'Variant',
            draft.variant,
            (v) => setDraft({ ...draft, variant: v }),
            '(default)',
          )}
        </>
      )}
    </div>
  );
}
