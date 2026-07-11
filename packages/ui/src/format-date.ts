/**
 * Client-side date formatting for the Hiroba UIs.
 *
 * The API serializes all point-in-time values as ISO-8601 UTC instant strings
 * (e.g. "2026-06-26T12:00:00Z"); the web app also passes epoch milliseconds from
 * Temporal instants. These helpers accept either (plus a native Date) and render
 * in the viewer's local timezone or in JST (Asia/Tokyo).
 *
 * This module is intentionally dependency-free so it stays cheap in the client
 * bundle's date code path.
 */

const JST_TZ = 'Asia/Tokyo';

/** Anything `new Date()` accepts: an ISO instant string, epoch ms, or a Date. */
type DateInput = string | number | Date;

/** Short calendar date ("Jun 26, 2026") in the viewer's local zone. Defaults to
 *  en-US; pass a BCP-47 `locale` (the active UI language) to localize it. */
export function formatShortDate(value: DateInput, locale = 'en-US'): string {
  return new Date(value).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Format a UTC instant as date + time in the viewer's local zone. */
export function formatLocal(value: DateInput): string {
  return new Date(value).toLocaleString();
}

/** Short date + time ("Jun 26, 2026, 9:00 PM") in the viewer's local zone.
 *  Defaults to en-US; pass a BCP-47 `locale` to localize it. */
export function formatLocalDateTime(
  value: DateInput,
  locale = 'en-US',
): string {
  return new Date(value).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Format a UTC instant as a date in the viewer's local zone. */
export function formatLocalDate(value: DateInput): string {
  return new Date(value).toLocaleDateString();
}

/** Format a UTC instant as a JST (Asia/Tokyo) calendar date. Defaults to en-US;
 *  pass a BCP-47 `locale` to localize the month/format. */
export function formatJstDate(value: DateInput, locale = 'en-US'): string {
  return new Date(value).toLocaleDateString(locale, {
    timeZone: JST_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Format a UTC instant as JST (Asia/Tokyo) date + time. Defaults to en-US;
 *  pass a BCP-47 `locale` to localize the month/format. */
export function formatJst(value: DateInput, locale = 'en-US'): string {
  return new Date(value).toLocaleString(locale, {
    timeZone: JST_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Human-readable "x ago" for a UTC instant in the past. */
export function formatRelativePast(value: DateInput): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / (60 * 1000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/** Human-readable "how long until" duration for a future UTC instant. */
export function formatUntil(value: DateInput): string {
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

/** Human-readable "how long ago" duration for an overdue UTC instant. */
export function formatOverdue(value: DateInput): string {
  const diff = Date.now() - new Date(value).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}
