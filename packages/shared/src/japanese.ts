/**
 * Japanese-text detection, derived from transcribed spans (we don't store a
 * `localizable` flag — it's computed where needed: translate injects image text
 * only for Japanese-bearing images, localize skips images with none, and the
 * pipeline snapshot derives its localize candidate set the same way).
 */

const JAPANESE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

/** True if any span contains a hiragana/katakana/kanji character. */
export const hasJapanese = (spans: string[]): boolean =>
  spans.some((s) => JAPANESE.test(s));
