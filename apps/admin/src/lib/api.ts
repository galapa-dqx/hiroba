/**
 * Admin API client for interacting with the local admin API.
 * No authentication needed - protected by Cloudflare Access at edge.
 */

import type { Snapshot } from '@hiroba/flow';
// Type-only: the /hub entry's runtime half imports cloudflare:workers, which
// must never reach the client bundle.
import type { RunInfo } from '@hiroba/flow/hub';
import type { FlowRunItem, PhaseState } from '@hiroba/shared';

async function adminFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, options);

  if (!res.ok) {
    // Surface the server's error message when it sent one.
    let message = `API error: ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Non-JSON error body — keep the status message.
    }
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

export type ArticleTypeStats = {
  total: number;
  withBody: number;
  translated: number;
  recheckDue: number;
  recheckUpcoming: number;
  recheckRetired: number;
};

export type Stats = {
  news: ArticleTypeStats & { byCategory: Record<string, number> };
  topics: ArticleTypeStats;
};

export async function getStats(): Promise<Stats> {
  return adminFetch('/api/stats');
}

export type RecheckItem = {
  itemType: 'news' | 'topic';
  id: string;
  titleJa: string;
  category: string | null;
  publishedAt: string; // ISO-8601 UTC instant
  lastChangedAt: string; // ISO-8601 UTC instant
  bodyCheckedAt: string; // ISO-8601 UTC instant
  nextCheckAt: string | null; // ISO-8601 UTC instant; null = retired
};

export type RecheckQueue = {
  due: RecheckItem[];
  upcoming: RecheckItem[];
  retired: number;
};

export async function getRecheckQueue(limit = 100): Promise<RecheckQueue> {
  return adminFetch(`/api/recheck-queue?limit=${limit}`);
}

export type ScrapeResult = {
  success: boolean;
  results: Array<{ category: string; newItems: number; totalScraped: number }>;
  totalNewItems: number;
  totalScraped: number;
  /** New items whose title translation was enqueued (0 if enqueue failed). */
  titlesEnqueued: number;
};

/** Incremental refresh — first page of each category, run inline. */
export async function triggerScrape(): Promise<ScrapeResult> {
  return adminFetch(`/api/scrape?full=false`, { method: 'POST' });
}

/** Acknowledgement that the whole-archive scrape flow was (re)started. */
export type ArchiveScrapeStarted = {
  success?: boolean;
  mode?: 'workflow';
  /** `already_running` = the hub attached to a scrape of the same scope;
   *  `throttled` is carried by the wire type but unreachable without a
   *  cooldown on this flow. */
  status: 'started' | 'already_running' | 'throttled';
  /** Hub run id — query param for GET /api/flow-runs/stream to follow along.
   *  Absent only when throttled. */
  runId?: string;
};

/**
 * Kick off the whole-archive scrape (NewsBackfillFlow, optionally scoped to
 * one category) and return immediately; follow progress via the hub's per-run
 * SSE at `/api/flow-runs/stream?runId=…`. Paging the archive in one request
 * would blow the subrequest limit — that's what the flow fixes.
 */
export async function startArchiveScrape(
  category?: string,
): Promise<ArchiveScrapeStarted> {
  const params = new URLSearchParams({ full: 'true' });
  if (category) params.set('category', category);
  return adminFetch(`/api/scrape?${params}`, { method: 'POST' });
}

export type NewsItem = {
  id: string;
  titleJa: string;
  /** Title in the requested language, or null when not yet translated. */
  titleLocalized: string | null;
  category: string;
  publishedAt: string; // ISO-8601 UTC instant
  hasBody: boolean;
  translated: boolean;
};

export async function getNewsList(options?: {
  category?: string;
  limit?: number;
  cursor?: string;
  lang?: string;
}): Promise<{ items: NewsItem[]; hasMore: boolean; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (options?.category) params.set('category', options.category);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.lang) params.set('lang', options.lang);
  const url = `/api/news${params.toString() ? `?${params}` : ''}`;
  return adminFetch(url);
}

export async function invalidateBody(
  id: string,
): Promise<{ success: boolean }> {
  return adminFetch(`/api/news/${id}/body`, { method: 'DELETE' });
}

export async function triggerWorkflow(
  id: string,
): Promise<{ success: boolean }> {
  return adminFetch(`/api/news/${id}/workflow`, { method: 'POST' });
}

/** Kick off the rotation-banner refresh (scrape + localize). */
export async function refreshBanners(): Promise<{
  status: string;
  instanceId?: string;
}> {
  return adminFetch('/api/banners/refresh', { method: 'POST' });
}

/** Result of a "translate the most recent N" fan-out. */
export type TriggerRecentResult = {
  success: boolean;
  triggered: number;
  ids: string[];
};

export async function triggerRecentNewsWorkflows(
  count: number,
): Promise<TriggerRecentResult> {
  return adminFetch(`/api/news/trigger-recent?count=${count}`, {
    method: 'POST',
  });
}

export async function deleteTranslation(
  id: string,
  lang: string,
): Promise<{ success: boolean }> {
  return adminFetch(`/api/news/${id}/${lang}`, { method: 'DELETE' });
}

// Topics API

export type TopicItem = {
  id: string;
  titleJa: string;
  /** Title in the requested language, or null when not yet translated. */
  titleLocalized: string | null;
  publishedAt: string; // ISO-8601 UTC instant
  hasBody: boolean;
  translated: boolean;
};

export async function getTopicsList(options?: {
  limit?: number;
  cursor?: string;
  lang?: string;
}): Promise<{ items: TopicItem[]; hasMore: boolean; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.lang) params.set('lang', options.lang);
  const url = `/api/topics${params.toString() ? `?${params}` : ''}`;
  return adminFetch(url);
}

export type TopicsScrapeResult = {
  processed: number;
  newItems: number;
  totalScraped: number;
  cursor: number;
  nextCursor: number;
  total: number;
  done: boolean;
  /** New items whose title translation was enqueued (0 if enqueue failed). */
  titlesEnqueued: number;
};

export async function scrapeTopics(options?: {
  cursor?: number;
  batch?: number;
}): Promise<TopicsScrapeResult> {
  const params = new URLSearchParams();
  if (options?.cursor != null) params.set('cursor', String(options.cursor));
  if (options?.batch != null) params.set('batch', String(options.batch));
  const url = `/api/topics/scrape${params.toString() ? `?${params}` : ''}`;
  return adminFetch(url, { method: 'POST' });
}

export async function triggerTopicWorkflow(
  id: string,
): Promise<{ success: boolean }> {
  return adminFetch(`/api/topics/${id}/workflow`, { method: 'POST' });
}

export async function triggerRecentTopicWorkflows(
  count: number,
): Promise<TriggerRecentResult> {
  return adminFetch(`/api/topics/trigger-recent?count=${count}`, {
    method: 'POST',
  });
}

export async function invalidateTopicBody(
  id: string,
): Promise<{ success: boolean }> {
  return adminFetch(`/api/topics/${id}/body`, { method: 'DELETE' });
}

export async function deleteTopicTranslation(
  id: string,
  lang: string,
): Promise<{ success: boolean }> {
  return adminFetch(`/api/topics/${id}/${lang}`, { method: 'DELETE' });
}

// Playguide API

export type PlayguideItem = {
  id: string;
  titleJa: string;
  /** Title in the requested language, or null when not yet translated. */
  titleLocalized: string | null;
  sortOrder: number;
  hasBody: boolean;
  translated: boolean;
};

export async function getPlayguideList(options?: {
  lang?: string;
}): Promise<{ items: PlayguideItem[] }> {
  const params = new URLSearchParams();
  if (options?.lang) params.set('lang', options.lang);
  const url = `/api/playguide${params.toString() ? `?${params}` : ''}`;
  return adminFetch(url);
}

export type PlayguideCrawlResult = {
  success: boolean;
  crawled: number;
  newItems: number;
  titlesEnqueued: number;
};

export async function crawlPlayguides(): Promise<PlayguideCrawlResult> {
  return adminFetch('/api/playguide/crawl', { method: 'POST' });
}

export async function triggerPlayguideWorkflow(
  slug: string,
): Promise<{ success: boolean }> {
  return adminFetch(`/api/playguide/${slug}/workflow`, { method: 'POST' });
}

// Article editing API (shared by news items, topics, and playguides)

export type ArticleKind = 'news' | 'topic' | 'playguide';

function articleApiBase(kind: ArticleKind): string {
  return kind === 'topic'
    ? '/api/topics'
    : kind === 'playguide'
      ? '/api/playguide'
      : '/api/news';
}

export type ArticleTranslation = {
  title: string | null;
  blocks: unknown[] | null;
  translatedAt: string | null; // ISO-8601 UTC instant
  /** Original imageKey → versioned R2 key of this language's localized raster,
   *  for the images this language actually localized. */
  localizedImages: Record<string, string>;
};

/** An enabled translation-target language (a tab in the editor). */
export type ArticleLanguage = {
  code: string;
  label: string;
  nativeLabel: string;
};

export type ArticleDetail = {
  id: string;
  titleJa: string;
  category: string | null;
  /** ISO-8601 UTC instant, or null for undated items (playguides). */
  publishedAt: string | null;
  blocksJa: unknown[] | null;
  /** Enabled languages, in code order — one editor tab each. */
  languages: ArticleLanguage[];
  /** Translation per language code (present for every entry in `languages`). */
  translations: Record<string, ArticleTranslation>;
};

export async function getArticle(
  kind: ArticleKind,
  id: string,
): Promise<ArticleDetail> {
  return adminFetch(`${articleApiBase(kind)}/${id}`);
}

export async function updateArticleSource(
  kind: ArticleKind,
  id: string,
  patch: { titleJa?: string; blocksJa?: unknown[] },
): Promise<{ success: boolean }> {
  return adminFetch(`${articleApiBase(kind)}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function triggerArticleWorkflow(
  kind: ArticleKind,
  id: string,
): Promise<{ success: boolean }> {
  return adminFetch(`${articleApiBase(kind)}/${id}/workflow`, {
    method: 'POST',
  });
}

export async function updateArticleTranslation(
  kind: ArticleKind,
  id: string,
  lang: string,
  patch: { title?: string; blocks?: unknown[] },
): Promise<{ success: boolean }> {
  return adminFetch(`${articleApiBase(kind)}/${id}/${lang}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// Flow runs API (the workflow tracker)

/**
 * One tracker listing entry: the hub run row, its current segment snapshot,
 * and — for the article/playguide flows — the per-item identity enrichment
 * (which item the run is about, and its titles).
 */
export type FlowRunEntry = RunInfo & {
  snapshot: Snapshot | null;
  item: FlowRunItem | null;
};

export async function getFlowRuns(): Promise<{ runs: FlowRunEntry[] }> {
  return adminFetch('/api/flow-runs');
}

export type GlossaryEntry = {
  sourceText: string;
  targetLanguage: string;
  translatedText: string;
  updatedAt: string; // ISO-8601 UTC instant
  /** True for an admin override, false for an upstream (nightly-imported) row. */
  isOverride: boolean;
};

export async function getGlossary(
  lang?: string,
): Promise<{ entries: GlossaryEntry[] }> {
  const params = lang ? `?lang=${lang}` : '';
  return adminFetch(`/api/glossary${params}`);
}

/**
 * Create or edit an admin override — a term that survives the nightly upstream
 * refresh and wins over the imported translation for its key.
 */
export async function upsertGlossaryOverride(entry: {
  sourceText: string;
  targetLanguage: string;
  translatedText: string;
}): Promise<{ success: boolean }> {
  return adminFetch('/api/glossary/overrides', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

export async function deleteGlossaryOverride(
  sourceText: string,
  lang: string,
): Promise<{ success: boolean }> {
  return adminFetch(
    `/api/glossary/overrides/${encodeURIComponent(sourceText)}/${lang}`,
    { method: 'DELETE' },
  );
}

/** Result of kicking off a glossary "regenerate affected texts" run. */
export type RegenerateAffectedResult = {
  /** 'started' when a run was launched, 'already_running' if one was in flight. */
  status: 'started' | 'already_running';
  instanceId: string;
};

/**
 * Kick off a background workflow that re-runs every article whose Japanese body
 * contains `sourceText` — use after editing an override so existing translations
 * pick up the new term. Returns immediately; the workflow pages the whole
 * affected set (no cap) and dedupes a run already in flight for the same term.
 */
export async function regenerateGlossaryAffected(
  sourceText: string,
): Promise<RegenerateAffectedResult> {
  return adminFetch('/api/glossary/regenerate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceText }),
  });
}

export async function importGlossary(
  file: File,
  targetLanguage: string,
): Promise<{ success: boolean; imported: number }> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('targetLanguage', targetLanguage);

  const res = await fetch('/api/glossary/import', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function importGlossaryFromGitHub(): Promise<{
  success: boolean;
  imported: number;
  source: string;
}> {
  return adminFetch('/api/glossary/import-github', { method: 'POST' });
}

export type GlossaryMatch = {
  sourceText: string;
  translatedText: string;
};

export async function lookupGlossary(
  text: string,
  lang = 'en',
): Promise<{ matches: GlossaryMatch[] }> {
  return adminFetch('/api/glossary/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, lang }),
  });
}

// Languages API (the translation-target whitelist)

export type LanguageEntry = {
  code: string;
  label: string;
  nativeLabel: string;
  enabled: boolean;
  updatedAt: string; // ISO-8601 UTC instant
};

export async function getLanguages(): Promise<{
  languages: LanguageEntry[];
}> {
  return adminFetch('/api/languages');
}

export async function addLanguage(entry: {
  code: string;
  label: string;
  nativeLabel: string;
  enabled?: boolean;
}): Promise<{ success: boolean; code: string }> {
  return adminFetch('/api/languages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

export async function updateLanguage(
  code: string,
  patch: { label?: string; nativeLabel?: string; enabled?: boolean },
): Promise<{ success: boolean; code: string }> {
  return adminFetch(`/api/languages/${encodeURIComponent(code)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteLanguage(
  code: string,
): Promise<{ success: boolean; code: string }> {
  return adminFetch(`/api/languages/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  });
}

// Images API (the stored image corpus + per-language localization state)

export type ImageTranslation = {
  /** Translated-spans row state; null = not started for this language. */
  textState: PhaseState | null;
  /** Translated text spans (index-aligned to textsJa); null until done. */
  texts: string[] | null;
  /** Localized-image row state; null = not started for this language. */
  urlState: PhaseState | null;
  /** R2 key of the localized image (`l10n/<lang>/<key>`); null until done. */
  localizedKey: string | null;
  /** Failure detail when a step failed. */
  error: string | null;
  translatedAt: string | null; // ISO-8601 UTC instant
};

export type AdminImage = {
  id: number;
  key: string; // imageKey <host>/<path> — the R2 key of the original
  textsJa: string[] | null; // transcribed source spans; null = not transcribed
  hasText: boolean; // has >=1 Japanese span (i.e. a localization candidate)
  isBanner: boolean; // backs a rotation banner (banners.imageKey = key)
  mirrorState: PhaseState;
  transcribeState: PhaseState;
  updatedAt: string; // ISO-8601 UTC instant
  translation: ImageTranslation;
};

/** Image source categories the images screen can filter to server-side. */
export type ImageSourceFilter = 'banner';

export async function getImages(options: {
  lang: string;
  limit?: number;
  cursor?: number;
  /** Keep only images bearing Japanese text (localization candidates). */
  onlyText?: boolean;
  /** Keep only images from this source (currently: rotation banners). */
  source?: ImageSourceFilter;
}): Promise<{
  language: string;
  items: AdminImage[];
  hasMore: boolean;
  nextCursor?: number;
}> {
  const params = new URLSearchParams({ lang: options.lang });
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor != null) params.set('cursor', String(options.cursor));
  if (options.onlyText) params.set('onlyText', 'true');
  if (options.source) params.set('source', options.source);
  return adminFetch(`/api/images?${params}`);
}

/** Per-language localization state on the single-image edit screen. */
export type ImageLangDetail = {
  /** Translated-spans row state; null = not started for this language. */
  textState: PhaseState | null;
  /** Translated text spans (index-aligned to textsJa); null until saved. */
  texts: string[] | null;
  /** Localized-image row state; null = not started for this language. */
  urlState: PhaseState | null;
  /** R2 key of the localized image (`l10n/<lang>/<key>`); null until produced. */
  localizedKey: string | null;
  /** Model that produced the localized image ('manual' = hand-supplied). */
  urlModel: string | null;
  /** Failure detail when a step failed. */
  error: string | null;
  translatedAt: string | null; // ISO-8601 UTC instant
};

export type ImageDetail = {
  id: number;
  key: string; // imageKey <host>/<path> — the R2 key of the original
  textsJa: string[] | null; // transcribed source spans; null = not transcribed
  hasText: boolean;
  mirrorState: PhaseState;
  transcribeState: PhaseState;
  updatedAt: string; // ISO-8601 UTC instant
  /** Enabled languages, in code order — one editor tab each. */
  languages: ArticleLanguage[];
  /** State per language code (present for every entry in `languages`). */
  translations: Record<string, ImageLangDetail>;
};

export async function getImageDetail(id: number): Promise<ImageDetail> {
  return adminFetch(`/api/images/${id}`);
}

/**
 * Resolve an image's natural key (imageKey) to its surrogate id, so the article
 * editor can link an inline image to its edit screen. Returns null when the
 * image isn't in the library yet (404).
 */
export async function resolveImageId(key: string): Promise<number | null> {
  const res = await fetch(`/api/images/resolve?key=${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = (await res.json()) as { id: number };
  return data.id;
}

/** Save the edited JA→target spans (index-aligned to textsJa) for a language. */
export async function saveImageTranslation(
  id: number,
  lang: string,
  texts: string[],
): Promise<{ success: boolean }> {
  return adminFetch(`/api/images/${id}/${lang}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
}

/** One row of the JA span list as the editor currently has it. `from` is the
 *  row's index in the SAVED texts_ja, or null for a row just added. */
export type ImageSpanEdit = { text: string; from: number | null };

/**
 * Save the JA span rows themselves (add/remove/edit) — the source side of the
 * pair editor. Because the spans are shared, this rewrites every language's
 * translated spans to stay aligned, so it must land BEFORE any per-language
 * save (which is length-checked against texts_ja).
 */
export async function saveImageSpans(
  id: number,
  spans: ImageSpanEdit[],
): Promise<{ success: boolean }> {
  return adminFetch(`/api/images/${id}/texts`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spans }),
  });
}

/** Outcome of a synchronous gpt-image-2 regeneration for one (image, language). */
export type RegenerateResult = {
  status: 'done' | 'failed';
  state: PhaseState | null;
  localizedKey: string | null;
};

/** Quality tiers gpt-image-2's edit endpoint accepts, cheapest first. */
export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

/** Re-run gpt-image-2 for one image/language using the saved spans. */
export async function regenerateImage(
  id: number,
  lang: string,
  quality?: ImageQuality,
): Promise<RegenerateResult> {
  return adminFetch(`/api/images/${id}/${lang}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quality }),
  });
}

/** Upload a hand-made localized image for one image/language. */
export async function uploadImage(
  id: number,
  lang: string,
  file: File,
): Promise<{ success: boolean; localizedKey: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`/api/images/${id}/${lang}/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    let message = `API error: ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Non-JSON error body — keep the status message.
    }
    throw new Error(message);
  }
  return res.json();
}

/** Pre-warm a language's whole-archive title backfill (DQX-13). */
export async function backfillLanguageTitles(
  code: string,
): Promise<{ success: boolean; code: string }> {
  return adminFetch(`/api/languages/${encodeURIComponent(code)}/backfill`, {
    method: 'POST',
  });
}

// Events API

export type EventItem = {
  id: string;
  type: 'multiDay' | 'allDay' | 'span' | 'mark';
  titleJa: string;
  /** Title in the requested language, or null when not yet translated. */
  titleLocalized: string | null;
  startTime: string; // ISO-8601 UTC instant
  endTime: string | null; // ISO-8601 UTC instant
  sourceType: string | null;
  sourceId: string | null;
  createdAt: string; // ISO-8601 UTC instant
};

export async function getEvents(options?: {
  type?: string;
  search?: string;
  limit?: number;
  lang?: string;
}): Promise<{ items: EventItem[] }> {
  const params = new URLSearchParams();
  if (options?.type) params.set('type', options.type);
  if (options?.search) params.set('search', options.search);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.lang) params.set('lang', options.lang);
  const url = `/api/events${params.toString() ? `?${params}` : ''}`;
  return adminFetch(url);
}

export async function deleteEvent(id: string): Promise<{ success: boolean }> {
  return adminFetch(`/api/events/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// Reset milestones API (admin-managed recurring game resets → calendar marks)

export type ResetMilestoneEntry = {
  id: string;
  titleJa: string;
  /** Per-language display names incl. "en"; falls back lang → en → titleJa. */
  titles: Record<string, string>;
  /** Full iCal string: DTSTART;TZID=Asia/Tokyo:… + RRULE:… */
  rrule: string;
  enabled: boolean;
  sortOrder: number;
  note: string | null;
  createdAt: string; // ISO-8601 UTC instant
  updatedAt: string; // ISO-8601 UTC instant
};

/** The enabled target languages the editor renders a name field for. */
export type ResetLanguage = {
  code: string;
  label: string;
  nativeLabel: string;
};

export async function getResets(): Promise<{
  resets: ResetMilestoneEntry[];
  languages: ResetLanguage[];
}> {
  return adminFetch('/api/resets');
}

export async function upsertReset(entry: {
  id: string;
  titleJa: string;
  titles: Record<string, string>;
  rrule: string;
  enabled?: boolean;
  sortOrder?: number;
  note?: string | null;
}): Promise<{ success: boolean; id: string }> {
  return adminFetch('/api/resets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

export async function deleteReset(
  id: string,
): Promise<{ success: boolean; id: string }> {
  return adminFetch(`/api/resets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
