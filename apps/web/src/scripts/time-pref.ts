/**
 * Viewer's timezone preference for rendered times, set by the settings gear.
 *
 * All times are rendered server-side in JST (the game-server zone). By default
 * the client relocalizes timed values to the viewer's zone; choosing "jst"
 * leaves the SSR baseline untouched. Persisted in localStorage; read by every
 * localizer (article rt-time, events rail, the agenda timeline).
 */

export type TimePref = 'local' | 'jst';

const KEY = 'dqx-tz';

/** The saved preference, defaulting to the viewer's local zone. */
export function getTimePref(): TimePref {
  try {
    return localStorage.getItem(KEY) === 'jst' ? 'jst' : 'local';
  } catch {
    return 'local';
  }
}

/** True when timed values should be relocalized to the viewer's zone. */
export function localizeTimes(): boolean {
  return getTimePref() === 'local';
}
