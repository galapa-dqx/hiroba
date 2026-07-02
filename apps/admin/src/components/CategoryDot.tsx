/**
 * CategoryDot — the little category gem beside a `.category-badge`. Each category
 * gets a distinct cut (news = round · event = pentagon · update = tall emerald ·
 * maintenance = marquise). It's an inline SVG (not a CSS background) so `fill` and
 * `stroke` can use `currentColor` — the badge sets `color: var(--_c)`, so the dot
 * stays theme-adaptive with no baked-in colours. `paint-order: stroke` puts the
 * translucent stroke under the fill, giving a uniform external outline that hugs
 * the shape.
 */
const PATHS: Record<string, string> = {
  event: "M16 5 L26.46 12.6 L22.47 24.9 L9.53 24.9 L5.54 12.6 Z",
  update: "M14 5 L18 5 L21 8 L21 24 L18 27 L14 27 L11 24 L11 8 Z",
  maintenance: "M16 5 Q27 16 16 27 Q5 16 16 5 Z",
};

export default function CategoryDot({ category }: { category: string }) {
  const paint = {
    fill: "currentColor",
    stroke: "currentColor",
    strokeOpacity: 0.4,
    strokeWidth: 8.4,
    paintOrder: "stroke" as const,
  };
  return (
    <svg className="cat-dot" viewBox="0 0 32 32" aria-hidden="true">
      {category === "news" ? (
        <circle cx="16" cy="16" r="11" {...paint} />
      ) : (
        <path d={PATHS[category] ?? PATHS.event} strokeLinejoin="round" {...paint} />
      )}
    </svg>
  );
}
