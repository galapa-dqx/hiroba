/**
 * Article link handling. Source bodies cross-link other hiroba articles as
 * absolute detail-page URLs (`https://hiroba.dqx.jp/sc/topics/detail/<id>/`,
 * `…/sc/news/detail/<id>/` — the parser absolutizes root-relative hrefs at
 * parse time). The stored block tree keeps those source URLs as ground truth,
 * same as image `src`s; {@link rewriteArticleHref} maps them onto our own
 * routes (`/topics/<id>`, `/news/<id>`, `/playguide/<slug>`) at render time via
 * the renderer's `linkHref` option.
 *
 * Rewriting is unconditional — no existence check against the DB — because the
 * article pages treat a never-seen id as valid and trigger its pipeline on
 * first visit, so a cross-link to an unprocessed article self-heals.
 *
 * Anything else (other hiroba pages like `/sc/shop/`, off-site links, in-page
 * `#anchors`) is returned unchanged and keeps pointing at the source site.
 */

/**
 * A hiroba article detail URL: host, section (`topics`|`news`), a 32-hex id,
 * then an optional query (dropped — the detail pages take none that we serve)
 * and an optional `#fragment` (kept — in-page anchors survive our renderer).
 */
const ARTICLE_HREF_RE =
  /^https?:\/\/hiroba\.dqx\.jp\/sc\/(topics|news)\/detail\/([a-f0-9]{32})\/?(?:\?[^#]*)?(#.*)?$/i;

/**
 * A hiroba playguide URL: host, the `/sc/public/playguide/` prefix, then a slug
 * (`guide01`, `guide_4_2`, `wintrial_1_kantan`, `accessinfo`) — letters, digits,
 * and underscores, not a hex id. Same optional trailing slash / query / fragment
 * handling as {@link ARTICLE_HREF_RE}; kept separate because the id shape differs.
 */
const PLAYGUIDE_HREF_RE =
  /^https?:\/\/hiroba\.dqx\.jp\/sc\/public\/playguide\/([a-z0-9_]+)\/?(?:\?[^#]*)?(#.*)?$/i;

/**
 * Rewrite a source article link to our own route: `…/sc/topics/detail/<id>/`
 * → `/topics/<id>`, `…/sc/news/detail/<id>/` → `/news/<id>`, and
 * `…/sc/public/playguide/<slug>` → `/playguide/<slug>`, preserving any
 * `#fragment`. Every other href is returned unchanged.
 */
export function rewriteArticleHref(href: string): string {
  const m = ARTICLE_HREF_RE.exec(href);
  if (m) {
    const [, section, id, fragment] = m;
    return `/${section.toLowerCase()}/${id.toLowerCase()}${fragment ?? ''}`;
  }
  const pg = PLAYGUIDE_HREF_RE.exec(href);
  if (pg) {
    const [, slug, fragment] = pg;
    return `/playguide/${slug.toLowerCase()}${fragment ?? ''}`;
  }
  return href;
}
