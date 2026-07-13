import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDueRechecks,
  saveChangedBody,
  setBodyChecked,
  type Database,
} from '@hiroba/db';
import { getFlowHub } from '@hiroba/flow/hub';
import type { Block } from '@hiroba/richtext';
import {
  fetchNewsBody,
  fetchPlayguideBody,
  fetchTopicBody,
} from '@hiroba/scraper';

import type { Logger } from './logger';
import { processRechecks } from './recheck';
import type { Env } from './types';

vi.mock('@hiroba/db', () => ({
  getDueRechecks: vi.fn(),
  saveChangedBody: vi.fn(),
  setBodyChecked: vi.fn(),
}));

// The hub entry pulls cloudflare:workers, which doesn't exist on this plain-
// node tier — and the RPC surface is exactly what this suite asserts against.
vi.mock('@hiroba/flow/hub', () => ({
  getFlowHub: vi.fn(),
}));

vi.mock('@hiroba/scraper', () => ({
  fetchNewsBody: vi.fn(),
  fetchPlayguideBody: vi.fn(),
  fetchTopicBody: vi.fn(),
}));

const db = {} as Database;
const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const doFetch = vi.fn(async () => new Response('ok'));
const env = {
  WORKFLOW_MANAGER: {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ fetch: doFetch })),
  },
} as unknown as Env;

const hubStart = vi.fn(async () => ({
  runId: 'run-1',
  created: true,
  status: 'queued',
}));

const PARA = (text: string): Block => ({ type: 'paragraph', children: [text] });

function dueItem(
  overrides: Partial<{
    itemType: 'news' | 'topic';
    id: string;
    blocksJa: Block[] | null;
  }> = {},
) {
  return {
    itemType: 'news' as const,
    id: '0'.repeat(32),
    titleJa: '記事',
    category: 'news',
    publishedAt: null!,
    lastChangedAt: null!,
    bodyCheckedAt: null!,
    nextCheckAt: null,
    blocksJa: [PARA('本文')],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFlowHub).mockReturnValue({
    start: hubStart,
  } as unknown as ReturnType<typeof getFlowHub>);
});

describe('processRechecks', () => {
  it('bumps the checked stamp when content is unchanged', async () => {
    vi.mocked(getDueRechecks).mockResolvedValue([dueItem()]);
    vi.mocked(fetchNewsBody).mockResolvedValue([PARA('本文')]);

    await processRechecks(db, env, log);

    expect(setBodyChecked).toHaveBeenCalledWith(db, 'news', '0'.repeat(32));
    expect(saveChangedBody).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('ignores the pipeline’s time/event annotations when comparing', async () => {
    // Stored tree carries a <time> annotation; the fresh scrape never does.
    const annotated: Block[] = [
      {
        type: 'paragraph',
        children: [
          {
            type: 'time',
            datetime: '2026-07-10T06:00:00+09:00',
            children: ['7月10日'],
          },
          'に開催',
        ],
      },
    ];
    const fresh: Block[] = [{ type: 'paragraph', children: ['7月10日に開催'] }];
    vi.mocked(getDueRechecks).mockResolvedValue([
      dueItem({ blocksJa: annotated }),
    ]);
    vi.mocked(fetchNewsBody).mockResolvedValue(fresh);

    await processRechecks(db, env, log);

    expect(setBodyChecked).toHaveBeenCalledOnce();
    expect(saveChangedBody).not.toHaveBeenCalled();
  });

  it('saves changed content and re-triggers the pipeline', async () => {
    vi.mocked(getDueRechecks).mockResolvedValue([
      dueItem({ itemType: 'topic', id: 'a'.repeat(32) }),
    ]);
    vi.mocked(fetchTopicBody).mockResolvedValue({
      titleJa: '更新された記事',
      blocks: [PARA('更新後の本文')],
    });

    await processRechecks(db, env, log);

    expect(saveChangedBody).toHaveBeenCalledWith(db, 'topic', 'a'.repeat(32), {
      blocks: [PARA('更新後の本文')],
      titleJa: '更新された記事',
    });
    expect(setBodyChecked).not.toHaveBeenCalled();
    // Topic DO names are namespaced (same as the /trigger route).
    expect(env.WORKFLOW_MANAGER.idFromName).toHaveBeenCalledWith(
      `topic:${'a'.repeat(32)}`,
    );
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it('re-triggers a changed playguide via the hub, not the DO', async () => {
    vi.mocked(getDueRechecks).mockResolvedValue([
      dueItem({ itemType: 'playguide' as never, id: 'guide07' }),
    ]);
    vi.mocked(fetchPlayguideBody).mockResolvedValue({
      titleJa: 'ガイド',
      specificTitle: null,
      blocks: [PARA('更新後の本文')],
    });

    await processRechecks(db, env, log);

    expect(saveChangedBody).toHaveBeenCalledWith(db, 'playguide', 'guide07', {
      blocks: [PARA('更新後の本文')],
      titleJa: undefined,
    });
    // Playguides run on the flow framework (DQX-24): started at the hub,
    // keyed by slug — the WorkflowManager DO is never touched.
    expect(hubStart).toHaveBeenCalledWith('playguide', { slug: 'guide07' });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('caps pipeline re-triggers per run, deferring the rest', async () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      dueItem({ id: String(i).repeat(32) }),
    );
    vi.mocked(getDueRechecks).mockResolvedValue(items);
    vi.mocked(fetchNewsBody).mockResolvedValue([PARA('変わった本文')]);

    await processRechecks(db, env, log);

    // 5 changed items re-trigger; the remaining 3 stay due for the next run.
    expect(saveChangedBody).toHaveBeenCalledTimes(5);
    expect(doFetch).toHaveBeenCalledTimes(5);
    expect(setBodyChecked).not.toHaveBeenCalled();
  });

  it('continues past per-item failures', async () => {
    vi.mocked(getDueRechecks).mockResolvedValue([
      dueItem({ id: 'b'.repeat(32) }),
      dueItem({ id: 'c'.repeat(32) }),
    ]);
    vi.mocked(fetchNewsBody)
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce([PARA('本文')]);

    await processRechecks(db, env, log);

    expect(log.error).toHaveBeenCalledOnce();
    expect(setBodyChecked).toHaveBeenCalledWith(db, 'news', 'c'.repeat(32));
  });
});
