/**
 * Japanese-text detection, derived from transcribed spans (we don't store a
 * `localizable` flag — it's computed where needed: translate injects image text
 * only for Japanese-bearing images, and localize skips images with none).
 */

const JAPANESE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

/** True if any span contains a hiragana/katakana/kanji character. */
export const hasJapanese = (spans: string[]): boolean =>
  spans.some((s) => JAPANESE.test(s));
