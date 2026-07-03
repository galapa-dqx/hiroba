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
} from './list-scraper';

// Body scraper (fetching is now handled by Durable Objects)
export { fetchNewsBody, type BodyContent } from './body-scraper';

// Glossary fetcher
export {
  fetchGlossary,
  GLOSSARY_URL,
  type GlossaryEntry,
} from './glossary-fetcher';

// Topics body parser (HTML → @hiroba/richtext block tree)
export { parseTopicBody, parseTopicContent } from './topics-parser';

// Topics body scraper (fetch + parse a topic detail page)
export { fetchTopicBody, parseTopicPage, type TopicBody } from './topics-body-scraper';

// Topics list scraper (backnumber enumeration → Phase 1 metadata)
export {
  scrapeTopicsList,
  scrapeAllTopics,
  parseTopicsListPage,
  fetchTopicsListPage,
  listBacknumberMonths,
  listTopicsSources,
  TOPICS_LIST_URL,
  TOPICS_BACKNUMBER_URL,
  type TopicListItem,
  type TopicsMonth,
  type TopicsSource,
} from './topics-list-scraper';
