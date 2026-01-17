/**
 * Admin API client for interacting with the local admin API.
 * No authentication needed - protected by Cloudflare Access at edge.
 */

async function adminFetch(path: string, options: RequestInit = {}) {
	const res = await fetch(path, options);

	if (!res.ok) {
		throw new Error(`API error: ${res.status}`);
	}

	return res.json();
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
	return adminFetch("/api/stats");
}

export type QueueItem = {
	id: string;
	titleJa: string;
	category: string;
	publishedAt: number;
	bodyFetchedAt: number;
	nextCheckAt: number;
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
	return adminFetch(`/api/scrape?full=${full}`, { method: "POST" });
}

export type NewsItem = {
	id: string;
	titleJa: string;
	category: string;
	publishedAt: number;
	contentJa: string | null;
};

export async function getNewsList(options?: {
	category?: string;
	limit?: number;
}): Promise<{ items: NewsItem[]; hasMore: boolean }> {
	const params = new URLSearchParams();
	if (options?.category) params.set("category", options.category);
	if (options?.limit) params.set("limit", String(options.limit));
	const url = `/api/news${params.toString() ? `?${params}` : ""}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`API error: ${res.status}`);
	return res.json();
}

export async function invalidateBody(
	id: string,
): Promise<{ success: boolean }> {
	return adminFetch(`/api/news/${id}/body`, { method: "DELETE" });
}

export async function deleteTranslation(
	id: string,
	lang: string,
): Promise<{ success: boolean }> {
	return adminFetch(`/api/news/${id}/${lang}`, { method: "DELETE" });
}

export type GlossaryEntry = {
	sourceText: string;
	targetLanguage: string;
	translatedText: string;
	updatedAt: number;
};

export async function getGlossary(
	lang?: string,
): Promise<{ entries: GlossaryEntry[] }> {
	const params = lang ? `?lang=${lang}` : "";
	return adminFetch(`/api/glossary${params}`);
}

export async function importGlossary(
	file: File,
	targetLanguage: string,
): Promise<{ success: boolean; imported: number }> {
	const formData = new FormData();
	formData.append("file", file);
	formData.append("targetLanguage", targetLanguage);

	const res = await fetch("/api/glossary/import", {
		method: "POST",
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
	return adminFetch("/api/glossary/import-github", { method: "POST" });
}

export async function deleteGlossaryEntry(
	sourceText: string,
	lang: string,
): Promise<{ success: boolean }> {
	return adminFetch(`/api/glossary/${encodeURIComponent(sourceText)}/${lang}`, {
		method: "DELETE",
	});
}

export type GlossaryMatch = {
	sourceText: string;
	translatedText: string;
};

export async function lookupGlossary(
	text: string,
	lang = "en",
): Promise<{ matches: GlossaryMatch[] }> {
	return adminFetch("/api/glossary/lookup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, lang }),
	});
}
