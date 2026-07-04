/**
 * Admin API client for interacting with the local admin API.
 * No authentication needed - protected by Cloudflare Access at edge.
 */

async function adminFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, options);

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export type Stats = {
  totalItems: number;
  itemsWithBody: number;
  itemsWithBodyFetchedAt: number;
  itemsTranslated: number;
  itemsPendingRecheck: number;
  byCategory: Record<string, number>;
};

export async function getStats(): Promise<Stats> {
  return adminFetch('/api/stats');
}

export type QueueItem = {
  id: string;
  titleJa: string;
  category: string;
  publishedAt: string; // ISO-8601 UTC instant
  bodyFetchedAt: string; // ISO-8601 UTC instant
  nextCheckAt: string; // ISO-8601 UTC instant
};

export async function getRecheckQueue(
  limit = 50,
): Promise<{ items: QueueItem[] }> {
  return adminFetch(`/api/recheck-queue?limit=${limit}`);
}

export type ScrapeResult = {
  success: boolean;
  results: Array<{ category: string; newItems: number; totalScraped: number }>;
  totalNewItems: number;
  totalScraped: number;
};

export async function triggerScrape(full = false): Promise<ScrapeResult> {
  return adminFetch(`/api/scrape?full=${full}`, { method: 'POST' });
}

export type NewsItem = {
  id: string;
  titleJa: string;
  category: string;
  publishedAt: string; // ISO-8601 UTC instant
  blocksJa: unknown[] | null; // JSON Block[] tree, NULL until the body is fetched
};

export async function getNewsList(options?: {
  category?: string;
  limit?: number;
}): Promise<{ items: NewsItem[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options?.category) params.set('category', options.category);
  if (options?.limit) params.set('limit', String(options.limit));
  const url = `/api/news${params.toString() ? `?${params}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
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

export type TopicStats = {
  total: number;
  withBody: number;
  translated: number;
};

export async function getTopicStats(): Promise<TopicStats> {
  return adminFetch('/api/topics/stats');
}

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
