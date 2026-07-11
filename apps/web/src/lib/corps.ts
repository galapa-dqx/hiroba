/**
 * Astoltia Defense Force (防衛軍) corps, keyed by the つよさ予報 raid badge number
 * that appears in the schedule icon URL
 * (…/tokoyami/raid/ico/<n>.png). The game renders each corps as a small
 * Japanese badge; we swap those for a coloured text pill instead.
 *
 * These change rarely (a new 兵団 every several months), so the set is hardcoded:
 * `key` resolves the display name via the i18n catalog (`corps.<key>`), `full`
 * is the English tooltip name, and `bg`/`fg` colour the rectangle — `bg` sampled
 * from each badge's dominant colour (All Corps is a rainbow, so it gets a
 * gradient). Unknown badge numbers fall back to a neutral "???" pill.
 */
export type Corps = {
  /** i18n key for the short display pill (`corps.<key>`). */
  key: string;
  /** English full name, used for the hover tooltip. */
  full: string;
  /** Rectangle background — a solid colour, or a gradient for All Corps. */
  bg: string;
  /** Text colour chosen for contrast against `bg`. */
  fg: string;
};

const DARK = '#1c1c1c';
const LIGHT = '#f5f5f5';

/** Badge number (from the icon URL) → corps. */
const BY_ICON: Record<string, Corps> = {
  '2': { key: 'fangs', full: 'Crimson Fangs', bg: '#c65042', fg: LIGHT },
  '3': { key: 'machina', full: 'Violet Machina', bg: '#aa5ec5', fg: LIGHT },
  '4': { key: 'constructs', full: 'Jade Constructs', bg: '#69a733', fg: LIGHT },
  '5': { key: 'invaders', full: 'Alien Invaders', bg: '#c1a474', fg: DARK },
  '6': { key: 'bones', full: 'Blue Bones', bg: '#4e73cc', fg: LIGHT },
  '8': { key: 'shells', full: 'Silver Shells', bg: '#8d8f9c', fg: LIGHT },
  '9': { key: 'marines', full: 'Misty Marines', bg: '#43b2b2', fg: LIGHT },
  '10': { key: 'dragons', full: 'Ashen Dragons', bg: '#8d7165', fg: LIGHT },
  '11': { key: 'blobs', full: 'Rainbow Blobs', bg: '#2443d7', fg: LIGHT },
  '12': {
    key: 'beauties',
    full: 'Fragrant Beauties',
    bg: '#682f2f',
    fg: LIGHT,
  },
  '13': { key: 'wings', full: 'White Wings', bg: '#dfdfdf', fg: DARK },
  '14': { key: 'woods', full: 'Rotting Woods', bg: '#898a39', fg: LIGHT },
  '15': { key: 'produce', full: 'Fresh Produce', bg: '#f0c657', fg: DARK },
  '16': { key: 'ingots', full: 'Steel Ingots', bg: '#4c5465', fg: LIGHT },
  '17': { key: 'treasures', full: 'Golden Treasures', bg: '#e6db8d', fg: DARK },
  '18': { key: 'brigands', full: 'Blazing Brigands', bg: '#c87000', fg: LIGHT },
  '19': {
    key: 'nightmares',
    full: 'Dusk Nightmares',
    bg: '#443354',
    fg: LIGHT,
  },
  // All Corps is a free-choice slot rendered as a rainbow badge in-game.
  '20': {
    key: 'allCorps',
    full: 'All Corps',
    bg: 'linear-gradient(120deg, #d24a4a, #e0913a, #3fa64a, #3f7fd0, #9a55c0)',
    fg: LIGHT,
  },
};

/** Neutral fallback for an unrecognized badge (a newly added corps). */
export const UNKNOWN_CORPS: Corps = {
  key: 'unknown',
  full: '???',
  bg: '#6b6f76',
  fg: LIGHT,
};

/** Resolve the corps from a schedule icon URL, or null when it isn't one. */
export function corpsFromIcon(
  iconUrl: string | null | undefined,
): Corps | null {
  if (!iconUrl) return null;
  const m = iconUrl.match(/\/ico\/(\d+)\.png/);
  if (!m) return null;
  return BY_ICON[m[1]] ?? UNKNOWN_CORPS;
}
