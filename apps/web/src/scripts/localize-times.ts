/**
 * Rewrite article-body `<time class="rt-time">` elements (workflow-inserted
 * timestamp annotations) into the viewer's local timezone.
 *
 * The server renders the human-readable JST phrase as the element text with the
 * machine value in `datetime`. Values with a time component are instants and
 * get localized; date-only values (`2026-07-13`) are calendar dates with no
 * instant — converting one across zones is meaningless, so they keep their
 * text. The original JST rendering stays discoverable via the title tooltip.
 */

import { formatJst, formatLocalDateTime } from '@hiroba/ui/format-date';

import { localizeTimes } from './time-pref';

/**
 * Rewrite one <time> element's text into the viewer's zone, keeping the JST
 * rendering in the title tooltip. Also used by the events rail for its timed
 * events.
 */
export function localizeTimeElement(el: HTMLTimeElement): void {
  const dt = el.getAttribute('datetime');
  if (!dt) return;
  const date = new Date(dt);
  if (Number.isNaN(date.getTime())) return;
  el.title = `${formatJst(date)} JST`;
  el.textContent = formatLocalDateTime(date);
}

export function localizeArticleTimes(root: ParentNode = document): void {
  if (!localizeTimes()) return; // viewer chose JST — keep the SSR baseline
  const els = root.querySelectorAll<HTMLTimeElement>('time.rt-time[datetime]');
  for (const el of els) {
    const dt = el.getAttribute('datetime');
    if (!dt || !dt.includes('T')) continue;
    localizeTimeElement(el);
  }
}

localizeArticleTimes();
