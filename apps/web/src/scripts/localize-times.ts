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

import { formatJst } from '@hiroba/ui/format-date';

export function localizeArticleTimes(root: ParentNode = document): void {
  const els = root.querySelectorAll<HTMLTimeElement>('time.rt-time[datetime]');
  for (const el of els) {
    const dt = el.getAttribute('datetime');
    if (!dt || !dt.includes('T')) continue;
    const date = new Date(dt);
    if (Number.isNaN(date.getTime())) continue;
    el.title = `${formatJst(date)} JST`;
    el.textContent = date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}

localizeArticleTimes();
