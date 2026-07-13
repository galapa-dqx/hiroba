/**
 * Recheck processor — the consumer of the recheck queue.
 *
 * Runs on the hourly cron: polls the source pages of due articles (news +
 * topics) and compares the freshly parsed block tree with what's stored.
 * Unchanged content just gets its checked-at stamp bumped (pushing the next
 * check out on the fading schedule — see @hiroba/shared freshness). Changed
 * content is saved, its change anchor reset (so frequent checking resumes),
 * and the full ArticleWorkflow re-runs to re-translate and re-annotate it.
 *
 * The comparison strips the inline <time>/<event> annotations the pipeline
 * writes into blocks_ja — a fresh scrape never carries them, so diffing raw
 * trees would flag every annotated article as changed.
 *
 * Cost controls: polls are plain HTML fetches capped per run; workflow
 * re-triggers (which spend Gemini calls) are capped separately, so a parser
 * change can't stampede the translation pipeline. Items past the cap stay
 * due and drain over subsequent hourly runs.
 */

import {
  getDueRechecks,
  saveChangedBody,
  setBodyChecked,
  type Database,
} from '@hiroba/db';
import { getFlowHub } from '@hiroba/flow/hub';
import { PlayguideFlow } from '@hiroba/flows';
import {
  serializeToRtml,
  stripTimeEventTags,
  type Block,
} from '@hiroba/richtext';
import {
  fetchNewsBody,
  fetchPlayguideBody,
  fetchTopicBody,
} from '@hiroba/scraper';

import type { Logger } from './logger';
import type { Env, ItemType } from './types';

/** Source-page polls per hourly run. */
const MAX_CHECKS_PER_RUN = 20;
/** Changed-article pipeline re-triggers per run (each re-translates). */
const MAX_RETRIGGERS_PER_RUN = 5;

/**
 * Canonical comparison form: annotations stripped, then RTML-serialized.
 * Serializing (rather than JSON.stringify) matters — stripping a <time> tag
 * leaves its text as a separate sibling string, and RTML serialization is
 * what fuses those back into one text run so equal content compares equal.
 */
const comparable = (blocks: Block[]): string =>
  serializeToRtml({ title: '', blocks: stripTimeEventTags(blocks) });

/** Re-run an item's pipeline. Playguides run on the flow framework (DQX-24) —
 * started via the hub, keyed by slug so a run in flight is attached to; news
 * and topics fire their ArticleWorkflow via the WorkflowManager DO (the same
 * path the public /trigger endpoint takes). */
async function triggerArticleWorkflow(
  env: Env,
  itemType: ItemType,
  itemId: string,
): Promise<void> {
  if (itemType === 'playguide') {
    // System-initiated heal — `force` keeps the contract explicit (the hub
    // only throttles when a caller opts into cooldownMs, but this start must
    // never be swallowed regardless of how that evolves).
    await getFlowHub(env).start(
      PlayguideFlow.name,
      { slug: itemId },
      { force: true },
    );
    return;
  }
  const doName = itemType === 'news' ? itemId : `${itemType}:${itemId}`;
  const stub = env.WORKFLOW_MANAGER.get(
    env.WORKFLOW_MANAGER.idFromName(doName),
  );
  await stub.fetch('http://internal/trigger', {
    method: 'POST',
    // System-initiated heal — force past the page-view re-trigger cooldown.
    body: JSON.stringify({ itemId, itemType, force: true }),
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function processRechecks(
  db: Database,
  env: Env,
  log: Logger,
): Promise<void> {
  const due = await getDueRechecks(db, MAX_CHECKS_PER_RUN);
  if (due.length === 0) {
    log.debug('recheck: nothing due');
    return;
  }

  let unchanged = 0;
  let changed = 0;
  let deferred = 0;
  let failed = 0;

  for (const item of due) {
    try {
      let fresh: { titleJa: string | undefined; blocks: Block[] };
      if (item.itemType === 'news') {
        fresh = { titleJa: undefined, blocks: await fetchNewsBody(item.id) };
      } else if (item.itemType === 'playguide') {
        // Only a specific in-page heading re-titles a guide on change; a generic
        // section header must not clobber the crawl/hybrid title (see fetch-body).
        const body = await fetchPlayguideBody(item.id);
        fresh = {
          titleJa: body.specificTitle ?? undefined,
          blocks: body.blocks,
        };
      } else {
        fresh = await fetchTopicBody(item.id);
      }

      const stored = item.blocksJa ?? [];
      if (comparable(fresh.blocks) === comparable(stored)) {
        await setBodyChecked(db, item.itemType, item.id);
        unchanged++;
        continue;
      }

      if (changed >= MAX_RETRIGGERS_PER_RUN) {
        // Leave it due; a later run picks it up within the trigger budget.
        deferred++;
        continue;
      }

      log.info(
        `recheck: ${item.itemType} ${item.id} changed — re-running pipeline`,
      );
      await saveChangedBody(db, item.itemType, item.id, {
        blocks: fresh.blocks,
        titleJa: fresh.titleJa,
      });
      await triggerArticleWorkflow(env, item.itemType, item.id);
      changed++;
    } catch (error) {
      failed++;
      log.error(`recheck failed for ${item.itemType} ${item.id}:`, error);
    }
  }

  log.info(
    `recheck: ${due.length} due — ${unchanged} unchanged, ${changed} changed, ${deferred} deferred, ${failed} failed`,
  );
}
