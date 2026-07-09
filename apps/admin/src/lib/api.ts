/**
 * Admin API client for interacting with the local admin API.
 * No authentication needed - protected by Cloudflare Access at edge.
 */

import type { PhaseState, WorkflowRunEntry } from '@hiroba/shared';

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

export async function triggerScrape(full = false): Promise<ScrapeResult> {
  return adminFetch(`/api/scrape?full=${full}`, { method: 'POST' });
}

export type NewsItem = {
  id: string;
  titleJa: string;
  category: string;
  publishedAt: string; // ISO-8601 UTC instant
  hasBody: boolean;
  translated: boolean;
};

export async function getNewsList(options?: {
  category?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ items: NewsItem[]; hasMore: boolean; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (options?.category) params.set('category', options.category);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.cursor) params.set('cursor', options.cursor);
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
  publishedAt: string; // ISO-8601 UTC instant
  hasBody: boolean;
  translated: boolean;
};

export async function getTopicsList(options?: {
  limit?: number;
  cursor?: string;
}): Promise<{ items: TopicItem[]; hasMore: boolean; nextCursor?: string }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.cursor) params.set('cursor', options.cursor);
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

// Article editing API (shared by news items and topics)

export type ArticleKind = 'news' | 'topic';

function articleApiBase(kind: ArticleKind): string {
  return kind === 'topic' ? '/api/topics' : '/api/news';
}

export type ArticleTranslation = {
  title: string | null;
  blocks: unknown[] | null;
  translatedAt: string | null; // ISO-8601 UTC instant
};

export type ArticleDetail = {
  id: string;
  titleJa: string;
  category: string | null;
  publishedAt: string; // ISO-8601 UTC instant
  blocksJa: unknown[] | null;
  en: ArticleTranslation;
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

// Workflow runs API

export async function getWorkflowRuns(): Promise<{
  runs: WorkflowRunEntry[];
}> {
  return adminFetch('/api/workflows');
}

export type GlossaryEntry = {
  sourceText: string;
  targetLanguage: string;
  translatedText: string;
  updatedAt: string; // ISO-8601 UTC instant
};

export async function getGlossary(
  lang?: string,
): Promise<{ entries: GlossaryEntry[] }> {
  const params = lang ? `?lang=${lang}` : '';
  return adminFetch(`/api/glossary${params}`);
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

export async function deleteGlossaryEntry(
  sourceText: string,
  lang: string,
): Promise<{ success: boolean }> {
  return adminFetch(`/api/glossary/${encodeURIComponent(sourceText)}/${lang}`, {
    method: 'DELETE',
  });
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
  mirrorState: PhaseState;
  transcribeState: PhaseState;
  updatedAt: string; // ISO-8601 UTC instant
  translation: ImageTranslation;
};

export async function getImages(options: {
  lang: string;
  limit?: number;
  cursor?: number;
}): Promise<{
  language: string;
  items: AdminImage[];
  hasMore: boolean;
  nextCursor?: number;
}> {
  const params = new URLSearchParams({ lang: options.lang });
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor != null) params.set('cursor', String(options.cursor));
  return adminFetch(`/api/images?${params}`);
}

// Events API

export type EventItem = {
  id: string;
  type: 'multiDay' | 'allDay' | 'span' | 'mark';
  titleJa: string;
  titleEn: string | null;
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
}): Promise<{ items: EventItem[] }> {
  const params = new URLSearchParams();
  if (options?.type) params.set('type', options.type);
  if (options?.search) params.set('search', options.search);
  if (options?.limit) params.set('limit', String(options.limit));
  const url = `/api/events${params.toString() ? `?${params}` : ''}`;
  return adminFetch(url);
}

export async function deleteEvent(id: string): Promise<{ success: boolean }> {
  return adminFetch(`/api/events/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
