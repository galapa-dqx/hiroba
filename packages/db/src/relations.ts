import { defineRelations } from 'drizzle-orm';

import * as schema from './schema';

/**
 * Relational-query config for `db.query.*` (RQBv2).
 *
 * The `title` relations encode the localized-title join every list surface
 * uses: `translations` keyed by (item_type, item_id, language, field), with
 * `item_type`/`field` baked in here and `language` supplied per query
 * (`with: { title: { where: { language } } }`). The translations PK makes the
 * pair one-to-one once language is filtered, so the relation never multiplies
 * rows.
 *
 * Deliberately NOT filtered on `state`: a running re-translation keeps its
 * previous value, which is still the best thing to render
 * (stale-while-revalidate). A row whose value is null (never translated, or
 * first translation still in flight) flattens to `titleEn: null` via
 * `withTitleEn` — same outcome as no row at all.
 */
export const relations = defineRelations(schema, (r) => ({
  newsItems: {
    title: r.one.translations({
      from: r.newsItems.id,
      to: r.translations.itemId,
      where: { itemType: 'news', field: 'title' },
      optional: true,
    }),
  },
  topics: {
    title: r.one.translations({
      from: r.topics.id,
      to: r.translations.itemId,
      where: { itemType: 'topic', field: 'title' },
      optional: true,
    }),
  },
  playguides: {
    title: r.one.translations({
      from: r.playguides.id,
      to: r.translations.itemId,
      where: { itemType: 'playguide', field: 'title' },
      optional: true,
    }),
  },
  events: {
    title: r.one.translations({
      from: r.events.id,
      to: r.translations.itemId,
      where: { itemType: 'event', field: 'title' },
      optional: true,
    }),
    // Provenance rows — every article this event was extracted from, not just
    // its primary source (events.source_id).
    sources: r.many.eventSources({
      from: r.events.id,
      to: r.eventSources.eventId,
    }),
  },
}));

/**
 * Flatten a row's `title` relation into the flat `titleEn` column shape the
 * web components consume (null ⇒ render titleJa).
 */
export function withTitleEn<
  T extends { title: { value: string | null } | null },
>(row: T): Omit<T, 'title'> & { titleEn: string | null } {
  const { title, ...rest } = row;
  return { ...rest, titleEn: title?.value ?? null };
}
