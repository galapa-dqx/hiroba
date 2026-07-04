/**
 * CategoryDot (React) — the category gem beside an admin `.category-badge`.
 * Geometry lives in `./category-shape`; see that module for the design notes.
 */
import {
  CATEGORY_DOT_CIRCLE_RADIUS,
  CATEGORY_DOT_STROKE_OPACITY,
  CATEGORY_DOT_STROKE_WIDTH,
  CATEGORY_PATHS,
} from './category-shape';

export default function CategoryDot({ category }: { category: string }) {
  const paint = {
    fill: 'currentColor',
    stroke: 'currentColor',
    strokeOpacity: CATEGORY_DOT_STROKE_OPACITY,
    strokeWidth: CATEGORY_DOT_STROKE_WIDTH,
    paintOrder: 'stroke' as const,
  };
  return (
    <svg className="cat-dot" viewBox="0 0 32 32" aria-hidden="true">
      {category === 'news' ? (
        <circle cx="16" cy="16" r={CATEGORY_DOT_CIRCLE_RADIUS} {...paint} />
      ) : (
        <path
          d={CATEGORY_PATHS[category] ?? CATEGORY_PATHS.event}
          strokeLinejoin="round"
          {...paint}
        />
      )}
    </svg>
  );
}
