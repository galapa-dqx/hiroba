import { Temporal } from 'temporal-polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { imageKey, type Block } from '@hiroba/richtext';
import {
  describeSnapshot,
  isSnapshotComplete,
  isSnapshotSettled,
} from '@hiroba/shared';

import {
  ensureImageRows,
  setImageMirrorState,
  setTranslationStates,
  upsertImageTranscription,
  upsertImageTranslation,
  upsertTopic,
  upsertTopicTranslation,
} from './queries';
import { computeSnapshot } from './snapshot';
import { createTestDb, type TestDb } from './test-db';

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.dispose();
});
beforeEach(async () => {
  await ctx.reset();
});

const BASE = Temporal.Instant.from('2026-01-01T00:00:00Z');
const TOPIC = 'a'.repeat(32);

const SRC_A = 'https://hiroba.dqx.jp/sc/images/banner.png';
const SRC_B = 'https://hiroba.dqx.jp/sc/images/plain.png';
const KEY_A = imageKey(SRC_A)!;
const KEY_B = imageKey(SRC_B)!;

const blocks = [
  { type: 'image', src: SRC_A },
  { type: 'image', src: SRC_B },
] as unknown as Block[];

/** Seed the topic with a fetched body referencing both images. */
async function seedFetchedTopic() {
  await upsertTopic(ctx.db, {
    id: TOPIC,
    titleJa: 'トピック',
    publishedAt: BASE,
    blocksJa: blocks,
    bodyFetchedAt: BASE,
    fetchState: 'done',
  });
}

describe('computeSnapshot', () => {
  it('reports an untouched item as all-pending and unsettled', async () => {
    const s = await computeSnapshot(ctx.db, 'topic', TOPIC, 'en');
    expect(s.article).toBe('pending');
    expect(s.translation).toBe('pending');
    expect(isSnapshotSettled(s)).toBe(false);
  });

  it('walks a topic through the whole pipeline', async () => {
    // Fetched, images referenced but not yet discovered.
    await seedFetchedTopic();
    let s = await computeSnapshot(ctx.db, 'topic', TOPIC, 'en');
    expect(s.article).toBe('done');
    expect(s.images).toEqual({
      mirror: { done: 0, failed: 0, total: 2 },
      transcribe: { done: 0, failed: 0, total: 2 },
      localize: null,
    });
    expect(describeSnapshot(s)).toBe('Downloading images (0/2)…');

    // Mirror: one copied, one still going.
    await ensureImageRows(ctx.db, [KEY_A, KEY_B]);
    await setImageMirrorState(ctx.db, KEY_A, 'done');
    s = await computeSnapshot(ctx.db, 'topic', TOPIC, 'en');
    expect(describeSnapshot(s)).toBe('Downloading images (1/2)…');

    // Transcribe: banner has Japanese text, the other has none.
    await setImageMirrorState(ctx.db, KEY_B, 'done');
    const bannerId = await upsertImageTranscription(ctx.db, {
      key: KEY_A,
      textsJa: ['ドラゴンクエスト'],
      model: 'gemini',
    });
    s = await computeSnapshot(ctx.db, 'topic', TOPIC, 'en');
    expect(describeSnapshot(s)).toBe('Reading image text (1/2)…');
    expect(s.images?.localize).toBeNull();

    await upsertImageTranscription(ctx.db, {
      key: KEY_B,
      textsJa: [],
      model: 'gemini',
    });

    // Translation in flight; candidate set now known (only the banner).
    await setTranslationStates(ctx.db, {
      itemType: 'topic',
      itemId: TOPIC,
      language: 'en',
      fields: ['title', 'content'],
      state: 'running',
    });
    s = await computeSnapshot(ctx.db, 'topic', TOPIC, 'en');
    expect(s.translation).toBe('running');
    expect(s.images?.localize).toEqual({ done: 0, failed: 0, total: 1 });
    expect(describeSnapshot(s)).toBe('Translating…');
    expect(isSnapshotSettled(s)).toBe(false);

    // Translation done — the article now waits only on image localization.
    for (const field of ['title', 'content'] as const) {
      await translateTopicField(field);
    }
    s = await computeSnapshot(ctx.db, 'topic', TOPIC, 'en');
    expect(describeSnapshot(s)).toBe('Translating images (0/1)…');
    expect(isSnapshotSettled(s)).toBe(false);

    // Localized banner lands → settled and complete.
    await upsertImageTranslation(ctx.db, {
      imageId: bannerId,
      language: 'en',
      field: 'url',
      value: `l10n/en/${KEY_A}`,
      model: 'gpt-image-2',
    });
    s = await computeSnapshot(ctx.db, 'topic', TOPIC, 'en');
    expect(isSnapshotSettled(s)).toBe(true);
    expect(isSnapshotComplete(s)).toBe(true);
  });

  it('settles degraded when a localization failed', async () => {
    await seedFetchedTopic();
    await ensureImageRows(ctx.db, [KEY_A, KEY_B]);
    await setImageMirrorState(ctx.db, KEY_A, 'done');
    await setImageMirrorState(ctx.db, KEY_B, 'done');
    const bannerId = await upsertImageTranscription(ctx.db, {
      key: KEY_A,
      textsJa: ['ドラゴンクエスト'],
      model: 'gemini',
    });
    await upsertImageTranscription(ctx.db, {
      key: KEY_B,
      textsJa: [],
      model: 'gemini',
    });
    for (const field of ['title', 'content'] as const) {
      await translateTopicField(field);
    }
    await setTranslationStates(ctx.db, {
      itemType: 'image',
      itemId: String(bannerId),
      language: 'en',
      fields: ['url'],
      state: 'failed',
      error: 'image edit failed',
    });

    const s = await computeSnapshot(ctx.db, 'topic', TOPIC, 'en');
    expect(s.images?.localize).toEqual({ done: 0, failed: 1, total: 1 });
    expect(isSnapshotSettled(s)).toBe(true); // display degraded…
    expect(isSnapshotComplete(s)).toBe(false); // …but retry on next trigger
    expect(describeSnapshot(s)).toBe('Done — 1 image could not be localized.');
  });
});

/** Write a finished topic translation row for `field`. */
async function translateTopicField(field: 'title' | 'content') {
  await upsertTopicTranslation(ctx.db, {
    itemId: TOPIC,
    language: 'en',
    field,
    value: field === 'content' ? '[]' : 'Topic',
    model: 'gemini',
  });
}
