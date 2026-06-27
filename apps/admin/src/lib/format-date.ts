/**
 * Client-side date formatting for the admin UI.
 *
 * The API serializes all point-in-time values as ISO-8601 UTC instant strings
 * (e.g. "2026-06-26T12:00:00Z"). These helpers parse them with the native Date
 * and render either in the viewer's local timezone or in JST (Asia/Tokyo).
 *
 * This module is intentionally dependency-free so it stays out of nothing but
 * the client bundle's date code path.
 */

const JST_TZ = 'Asia/Tokyo';

/** Format a UTC instant ISO string as date + time in the viewer's local zone. */
export function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Format a UTC instant ISO string as a date in the viewer's local zone. */
export function formatLocalDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** Format a UTC instant ISO string as a JST (Asia/Tokyo) calendar date. */
export function formatJstDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: JST_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Format a UTC instant ISO string as JST (Asia/Tokyo) date + time. */
export function formatJst(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: JST_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Human-readable "x ago" for a UTC instant ISO string in the past. */
export function formatRelativePast(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
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

/** Human-readable "how long ago" duration for an overdue UTC instant ISO string. */
export function formatOverdue(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}
