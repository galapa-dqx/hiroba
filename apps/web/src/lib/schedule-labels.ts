/**
 * Resolve the boss/brigade name for the icon-only schedule events (防衛軍・深淵)
 * and fold it into the event title. Those events carry no readable name — the
 * name is baked into the icon image, which the workflow cron transcribes (Gemini
 * vision) and translates (glossary-aware) into the shared `images`/`translations`
 * tables. Here we read that back by image key, mirroring how article image alt
 * text is hydrated (`hydrateArticleImages`).
 */

import {
  getImagesByKeys,
  getImageTranslations,
  type Database,
  type EventWithTitle,
} from '@hiroba/db';
import { imageKey } from '@hiroba/richtext';

import { scheduleInfo } from './schedule';

/**
 * Mutate schedule events in place, appending the localized icon name to the
 * title (e.g. "アストルティア防衛軍" → "アストルティア防衛軍：華烈"). Falls back to
 * the Japanese transcription when a translation isn't ready, and leaves the
 * title untouched when the icon hasn't been transcribed yet.
 */
export async function labelScheduleIcons(
  db: Database,
  events: EventWithTitle[],
  language: string,
): Promise<void> {
  const keyByEvent = new Map<EventWithTitle, string>();
  const keys = new Set<string>();
  for (const event of events) {
    const iconUrl = scheduleInfo(event)?.iconUrl;
    if (!iconUrl) continue;
    const key = imageKey(iconUrl);
    if (!key) continue;
    keyByEvent.set(event, key);
    keys.add(key);
  }
  if (keys.size === 0) return;

  const images = await getImagesByKeys(db, [...keys]);
  const imageByKey = new Map(images.map((img) => [img.key, img]));
  const translated = await getImageTranslations(
    db,
    images.map((img) => img.id),
    language,
    'text',
  );

  for (const [event, key] of keyByEvent) {
    const img = imageByKey.get(key);
    if (!img) continue;
    const spans = parseSpans(translated.get(img.id)) ?? img.textsJa ?? [];
    const name = spans.join(' ').trim();
    if (!name) continue;
    // Compose onto the localized display title (titleEn is the merged
    // translation and wins over titleJa in the components), so an EN/FR viewer
    // gets "translated section：translated name".
    const base = event.titleEn ?? event.titleJa;
    event.titleEn = `${base}：${name}`;
  }
}

/** Translated image text is stored as a JSON array of spans. */
function parseSpans(value: string | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}
