/**
 * Date utility functions for parsing Japanese time zone dates.
 */

/**
 * Parse a date string as JST and return Unix timestamp in seconds.
 * Input formats: "2024/01/15", "2024-01-15", "2024/01/15 10:30"
 */
export function parseJstDateToUnix(dateStr: string): number {
  if (!dateStr) return Math.floor(Date.now() / 1000);

  // Normalize separators
  const normalized = dateStr.replace(/\//g, '-').trim();

  // Try parsing with time: "2024-01-15 10:30"
  let match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    // Create date in JST (UTC+9) and convert to Unix timestamp
    const isoStr = `${year}-${month}-${day}T${hour}:${minute}:00+09:00`;
    return Math.floor(new Date(isoStr).getTime() / 1000);
  }

  // Try parsing date only: "2024-01-15"
  match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    const isoStr = `${year}-${month}-${day}T00:00:00+09:00`;
    return Math.floor(new Date(isoStr).getTime() / 1000);
  }

  // Fallback to current time
  return Math.floor(Date.now() / 1000);
}
