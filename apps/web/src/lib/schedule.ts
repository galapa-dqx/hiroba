/**
 * Helpers for the scraped つよさ予報 "schedule" events on the calendar. These
 * carry `sourceType='schedule'` and encode their content key (and, for the
 * icon-only sections, the icon URL) in `sourceId`: "panigarm" or
 * "defense#https://…/12.png". The icon-only sections have no readable name, so
 * the event title is a section label and the icon identifies the brigade/boss.
 */

/** The upstream page schedule events link out to. */
export const TSUYOSA_URL = 'https://hiroba.dqx.jp/sc/tokoyami/';

/** Content keys dense enough to hide behind a toggle (24–48 bars/day). */
const DENSE_CONTENT = new Set(['defense', 'metal']);

export type ScheduleInfo = {
  content: string;
  iconUrl: string | null;
  /** 防衛軍 / メタルーキー — hidden by default behind the schedule toggle. */
  dense: boolean;
};

/** Decode a schedule event's `sourceId`; null for non-schedule events. */
export function scheduleInfo(e: {
  sourceType: string | null;
  sourceId: string | null;
}): ScheduleInfo | null {
  if (e.sourceType !== 'schedule' || !e.sourceId) return null;
  const hash = e.sourceId.indexOf('#');
  const content = hash === -1 ? e.sourceId : e.sourceId.slice(0, hash);
  const iconUrl = hash === -1 ? null : e.sourceId.slice(hash + 1);
  return { content, iconUrl, dense: DENSE_CONTENT.has(content) };
}
