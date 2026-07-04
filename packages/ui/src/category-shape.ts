/**
 * CategoryDot geometry — the single source of truth shared by the Astro
 * (`CategoryDot.astro`, web) and React (`CategoryDot.tsx`, admin) renderers.
 *
 * Each category gets a distinct cut (news = round · event = pentagon ·
 * update = tall emerald · maintenance = marquise). The dot is an inline SVG so
 * `fill`/`stroke` can use `currentColor` and stay theme-adaptive; a translucent
 * stroke painted under the fill (`paint-order: stroke`) gives a uniform external
 * outline that hugs the cut.
 */

/** SVG path per non-`news` category (news is a `<circle>`, see the radius below). */
export const CATEGORY_PATHS: Record<string, string> = {
  event: 'M16 5 L26.46 12.6 L22.47 24.9 L9.53 24.9 L5.54 12.6 Z',
  update: 'M14 5 L18 5 L21 8 L21 24 L18 27 L14 27 L11 24 L11 8 Z',
  maintenance: 'M16 5 Q27 16 16 27 Q5 16 16 5 Z',
};

export const CATEGORY_DOT_STROKE_OPACITY = 0.4;
export const CATEGORY_DOT_STROKE_WIDTH = 8.4;
/** Radius of the `news` circle, in the 32×32 viewBox. */
export const CATEGORY_DOT_CIRCLE_RADIUS = 11;
