// Client-safe module: imported by React components, so it must not pull in
// server-only deps (the rest of the trigger machinery lives in trigger-recent.ts).

/** Upper bound on how many workflows one "translate recent N" action fans out to. */
export const MAX_RECENT_TRIGGER = 50;
