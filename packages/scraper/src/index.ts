/**
 * Scraper package - list scraping, body fetching, and glossary import.
 */

// List scraper
export {
	scrapeNewsList,
	scrapeCategory,
	parseListPage,
	getAllCategories,
	CATEGORY_TO_ID,
} from "./list-scraper";

// Body scraper (fetching is now handled by Durable Objects)
export { fetchNewsBody, type BodyContent } from "./body-scraper";

// Glossary fetcher
export {
	fetchGlossary,
	GLOSSARY_URL,
	type GlossaryEntry,
} from "./glossary-fetcher";
