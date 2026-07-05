import { describe, expect, it } from 'vitest';

import { parseTitleBatch } from './translate-titles';

describe('parseTitleBatch', () => {
  it('maps id → title for a well-formed array', () => {
    const map = parseTitleBatch(
      JSON.stringify([
        { id: 'a', title: 'One' },
        { id: 'b', title: 'Two' },
      ]),
    );
    expect(map.get('a')).toBe('One');
    expect(map.get('b')).toBe('Two');
    expect(map.size).toBe(2);
  });

  it('keys by id, so a reordered response still lines up', () => {
    const map = parseTitleBatch(
      JSON.stringify([
        { id: 'b', title: 'Two' },
        { id: 'a', title: 'One' },
      ]),
    );
    expect(map.get('a')).toBe('One');
    expect(map.get('b')).toBe('Two');
  });

  it('trims titles and drops blank ones', () => {
    const map = parseTitleBatch(
      JSON.stringify([
        { id: 'a', title: '  Spaced  ' },
        { id: 'b', title: '   ' },
      ]),
    );
    expect(map.get('a')).toBe('Spaced');
    expect(map.has('b')).toBe(false);
  });

  it('skips entries missing an id or title, or with non-string values', () => {
    const map = parseTitleBatch(
      JSON.stringify([
        { id: 'a', title: 'Ok' },
        { id: 'b' },
        { title: 'no id' },
        { id: 3, title: 'numeric id' },
        { id: 'c', title: 42 },
      ]),
    );
    expect(map.get('a')).toBe('Ok');
    expect(map.size).toBe(1);
  });

  it('returns an empty map for non-array or invalid JSON', () => {
    expect(parseTitleBatch('{"id":"a","title":"x"}').size).toBe(0);
    expect(parseTitleBatch('not json').size).toBe(0);
    expect(parseTitleBatch('').size).toBe(0);
  });
});
