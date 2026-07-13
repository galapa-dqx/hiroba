/**
 * The admin tracker's run listing (DQX-26): the hub's runs (each with its
 * segment snapshot) enriched with per-item domain detail for the
 * article/playguide flows — the translated title, the item's D1 pipeline
 * snapshot, and per-image pipeline states. Generic flows (titles, backfills,
 * banners, glossary) pass through untouched; the panel renders them from the
 * hub data alone.
 */

import { Temporal } from 'temporal-polyfill';

import {
  computeImageDetail,
  computeSnapshot,
  createDb,
  getNewsItem,
  getPlayguide,
  getTitleTranslations,
  getTopic,
} from '@hiroba/db';
import type { Snapshot } from '@hiroba/flow';
import { getFlowHub, isActiveStatus, type RunInfo } from '@hiroba/flow/hub';
import type { FlowRunItem } from '@hiroba/shared';

import {
  ARTICLE_ITEM_TYPES,
  hasImages,
  hubRunItem,
  isItemFlow,
} from './item-flows';
import type { Env, ItemType } from './types';

/** How long settled runs stay in the tracker's listing (the hub itself
 *  retains them for a week). */
const SETTLED_VISIBLE_HOURS = 24;

/**
 * How deep a page to ask the hub for when the caller doesn't say. The hub's
 * default (100 newest) could drop a long-running active run behind a burst of
 * newer ones — the visibility filter below trims to active + a day of settled
 * anyway, so over-fetch generously and let it cut the listing down.
 */
const DEFAULT_HUB_PAGE = 500;

/** One hub /runs entry: the run row plus its current segment snapshot. */
type HubRunEntry = RunInfo & { snapshot: Snapshot | null };

/**
 * List runs for the admin tracker: every still-active hub run plus runs
 * settled in the last SETTLED_VISIBLE_HOURS, each item-pipeline run enriched
 * with its domain detail. `?flow=…&limit=…` pass through to the hub.
 */
export async function listFlowRuns(env: Env, url: URL): Promise<Response> {
  // The hub's /runs route embeds each run's segment snapshot — one DO call
  // for the whole paint. (Its fetch surface exists for exactly this kind of
  // cross-script caller; see the hub module.)
  const search = new URLSearchParams(url.search);
  if (!search.has('limit')) search.set('limit', String(DEFAULT_HUB_PAGE));
  const hubRes = await getFlowHub(env).fetch(`http://hub/runs?${search}`);
  if (!hubRes.ok) {
    return Response.json(
      { error: `Hub listing failed (${hubRes.status})` },
      { status: 502 },
    );
  }
  const { runs } = (await hubRes.json()) as { runs: HubRunEntry[] };

  const settledSince = Temporal.Now.instant().subtract({
    hours: SETTLED_VISIBLE_HOURS,
  }).epochMilliseconds;
  const visible = runs.filter(
    (run) => isActiveStatus(run.status) || run.updatedAt >= settledSince,
  );

  const db = createDb(env.DB);
  const itemRuns = visible
    .filter((run) => isItemFlow(run.flow))
    .map((run) => ({ runId: run.runId, ...hubRunItem(run) }));

  // Batch the translated titles per item type (cheap title-row-only reads).
  const titleEn = new Map<string, string>();
  for (const itemType of ARTICLE_ITEM_TYPES) {
    const ids = itemRuns
      .filter((r) => r.itemType === itemType)
      .map((r) => r.itemId);
    if (ids.length === 0) continue;
    const titles = await getTitleTranslations(db, itemType, ids, 'en');
    for (const [id, title] of titles) titleEn.set(`${itemType}:${id}`, title);
  }

  const itemFor = (itemType: ItemType, itemId: string) =>
    itemType === 'topic'
      ? getTopic(db, itemId)
      : itemType === 'playguide'
        ? getPlayguide(db, itemId)
        : getNewsItem(db, itemId);

  const items = new Map<string, FlowRunItem>();
  for (const { runId, itemType, itemId } of itemRuns) {
    const item = await itemFor(itemType, itemId);
    const pipeline = await computeSnapshot(db, itemType, itemId, 'en');
    const images =
      hasImages(itemType) && item
        ? await computeImageDetail(db, item.blocksJa, 'en')
        : [];
    items.set(runId, {
      itemType,
      itemId,
      titleJa: item?.titleJa ?? null,
      titleEn: titleEn.get(`${itemType}:${itemId}`) ?? null,
      pipeline,
      images,
    });
  }

  return Response.json({
    runs: visible.map((run) => ({
      ...run,
      item: items.get(run.runId) ?? null,
    })),
  });
}
