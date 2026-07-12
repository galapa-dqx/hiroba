import { describe, expect, it } from 'vitest';

import { defineFlow, step, units } from './define';
import { seedSnapshot } from './snapshot';

describe('defineFlow', () => {
  it('captures step keys in declaration order, including spread fragments', () => {
    const intake = { load: step(), fetch: step() };
    const output = { translate: step(), publish: units() };
    const def = defineFlow({
      name: 'demo',
      key: (p: { id: string }) => p.id,
      steps: { ...intake, middle: units(), ...output },
    });
    expect(Object.keys(def.steps)).toEqual([
      'load',
      'fetch',
      'middle',
      'translate',
      'publish',
    ]);
    expect(seedSnapshot(def, 'r1').order).toEqual([
      'load',
      'fetch',
      'middle',
      'translate',
      'publish',
    ]);
  });

  it('computes the dedup key from params', () => {
    const def = defineFlow({
      name: 'article',
      key: (p: { itemType: string; itemId: string }) =>
        `${p.itemType}:${p.itemId}`,
      steps: { fetch: step() },
    });
    expect(def.key({ itemType: 'news', itemId: 'abc' })).toBe('news:abc');
  });

  it('rejects integer-index step ids (they reorder ahead of insertion order)', () => {
    expect(() =>
      defineFlow({
        name: 'bad',
        key: () => 'k',
        steps: { '42': step() },
      }),
    ).toThrow(/numeric/);
    // Non-canonical numeric strings are fine — JS does not reorder them.
    expect(() =>
      defineFlow({
        name: 'ok',
        key: () => 'k',
        steps: { 'page-2': step(), v2: step() },
      }),
    ).not.toThrow();
  });
});
