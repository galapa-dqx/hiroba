/**
 * @hiroba/ui - Shared UI components and presentation helpers
 *
 * Astro components (`Ornament`, `Rosette`, `ThemeToggle`, `CategoryDot`) and the
 * React `CategoryDot` are imported directly by their subpaths (e.g.
 * `@hiroba/ui/Ornament.astro`, `@hiroba/ui/CategoryDot`). This barrel re-exports
 * only the framework-agnostic modules.
 */

export * from './format-date';
export * from './category-shape';
