/**
 * Async iterator-based list scraper for DQX Hiroba news.
 *
 * Yields news items page by page, allowing callers to break early
 * when hitting known items (incremental scraping mode).
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import type { ListItem } from "@hiroba/db";
import {
	CATEGORIES,
	parseJstDateToUnix,
	SCRAPE_CONFIG,
	type Category,
} from "@hiroba/shared";

const BASE_URL = SCRAPE_CONFIG.baseUrl;

/**
 * Map Category strings to numeric IDs used in the website URLs.
 */
export const CATEGORY_TO_ID: Record<Category, number> = {
	news: 0,
	event: 1,
	update: 2,
	maintenance: 3,
};

/**
 * Extract date from the same table row as the link.
 * Structure: <tr><td class="news"><a>...</a></td><td class="date"><div>DATE</div></td></tr>
 */
function extractDateNearElement(
	$: cheerio.CheerioAPI,
	element: cheerio.Cheerio<AnyNode>,
): string {
	// The link is inside td.news, look for sibling td.date in same row
	const parentTd = element.closest("td");
	if (parentTd.length) {
		const dateTd = parentTd.siblings("td.date").first();
		if (dateTd.length) {
			const text = dateTd.text().trim();
			const match = text.match(/(\d{4}[-/]\d{2}[-/]\d{2}(?:\s+\d{2}:\d{2})?)/);
			if (match) return match[1];
		}
	}

	// Fallback: look for date pattern in the row
	const row = element.closest("tr");
	if (row.length) {
		const text = row.text();
		const match = text.match(/(\d{4}[-/]\d{2}[-/]\d{2}(?:\s+\d{2}:\d{2})?)/);
		if (match) return match[1];
	}

	return "";
}

/**
 * Extract total number of pages from pagination links.
 */
function extractTotalPages($: cheerio.CheerioAPI): number {
	let maxPage = 1;

	// Look for pagination links
	$("a[href*='/sc/news/category/']").each((_, elem) => {
		const href = $(elem).attr("href") || "";
		const match = href.match(/\/sc\/news\/category\/\d+\/(\d+)/);
		if (match) {
			const pageNum = parseInt(match[1]);
			maxPage = Math.max(maxPage, pageNum);
		}
	});

	// Also check for "last" link text
	$("a").each((_, elem) => {
		const text = $(elem).text();
		if (/last|最後/.test(text)) {
			const href = $(elem).attr("href") || "";
			const match = href.match(/\/(\d+)\/?$/);
			if (match) {
				maxPage = Math.max(maxPage, parseInt(match[1]));
			}
		}
	});

	return maxPage;
}

/**
 * Parse a list page HTML and extract news items.
 */
export function parseListPage(html: string, category: Category): ListItem[] {
	const $ = cheerio.load(html);
	const items: ListItem[] = [];
	const seenIds = new Set<string>();

	// Find all news links
	$("a[href*='/sc/news/detail/']").each((_, elem) => {
		const link = $(elem);
		const href = link.attr("href") || "";
		const match = href.match(/\/sc\/news\/detail\/([^/]+)\/?/);
		if (!match) return;

		const newsId = match[1];

		// Skip duplicates
		if (seenIds.has(newsId)) return;
		seenIds.add(newsId);

		const title = link.text().trim();

		// Skip empty titles or navigation links
		if (!title || title === "詳細" || title === "もっと見る") return;

		const dateStr = extractDateNearElement($, link);

		items.push({
			id: newsId,
			titleJa: title,
			category,
			publishedAt: parseJstDateToUnix(dateStr),
		});
	});

	return items;
}

/**
 * Fetch a single list page for a category.
 */
async function fetchListPage(
	category: Category,
	page: number,
): Promise<{ items: ListItem[]; totalPages: number }> {
	const categoryId = CATEGORY_TO_ID[category];
	let url = `${BASE_URL}/sc/news/category/${categoryId}`;
	if (page > 1) {
		url += `/${page}`;
	}

	const response = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch list page: ${response.status}`);
	}

	const html = await response.text();
	const $ = cheerio.load(html);

	return {
		items: parseListPage(html, category),
		totalPages: extractTotalPages($),
	};
}

/**
 * Async iterator that yields news items page by page.
 * Caller can break early when hitting known items (incremental mode).
 */
export async function* scrapeNewsList(
	category: Category,
): AsyncGenerator<ListItem[], void, unknown> {
	let page = 1;
	let totalPages = 1;

	while (page <= totalPages) {
		const result = await fetchListPage(category, page);

		if (result.items.length === 0) break;

		totalPages = result.totalPages;
		yield result.items;

		page++;
	}
}

/**
 * Scrape a single category and return all items.
 * Convenience function for full scrapes.
 */
export async function scrapeCategory(category: Category): Promise<ListItem[]> {
	const allItems: ListItem[] = [];

	for await (const items of scrapeNewsList(category)) {
		allItems.push(...items);
	}

	return allItems;
}

/**
 * Get all available categories.
 */
export function getAllCategories(): readonly Category[] {
	return CATEGORIES;
}
