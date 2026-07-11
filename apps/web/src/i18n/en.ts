/**
 * English base catalog for the web app's UI chrome (headings, nav, buttons,
 * aria labels, pipeline status). This is the source-of-truth set of keys and
 * the fallback for every enabled language; see ./index.ts for the `t()` helper
 * and how to register a translated catalog.
 *
 * Conventions:
 *   - Keys are dot-namespaced by area (nav.*, calendar.*, status.*, …).
 *   - `{token}` placeholders are filled by `t(key, params)`.
 *   - The site name "Galapa News" is a proper noun and stays literal in markup.
 */
export const en = {
  // Document + layout chrome
  'meta.description':
    'Dragon Quest X news, translated from the official Hiroba',
  'title.template': '{title} | Galapa News',
  'a11y.brandHome': 'Galapa News — home',
  'a11y.primaryNav': 'Primary',

  // Primary navigation
  'nav.news': 'News',
  'nav.topics': 'Topics',
  'nav.playGuide': 'Play Guide',
  'nav.calendar': 'Calendar',

  // Footer ("Translated from {source} — …", {source} is the Hiroba link)
  'footer.pre': 'Translated from ',
  'footer.source': 'DQX Hiroba',
  'footer.post': ' — a fan project, not affiliated with Square Enix.',

  // News categories (also used in nav, home sections, and article chips)
  'category.news': 'News',
  'category.event': 'Events',
  'category.update': 'Updates',
  'category.maintenance': 'Maintenance',

  // Settings popover
  'settings.aria': 'Settings',
  'settings.theme': 'Theme',
  'settings.themeGroup': 'Color theme',
  'settings.light': 'Light',
  'settings.dark': 'Dark',
  'settings.times': 'Times',
  'settings.timeZone': 'Time zone',
  'settings.local': 'Local',
  'settings.jst': 'JST',
  'settings.language': 'Language',

  // Home page
  'home.title': 'Latest News',
  'home.heroSubtitle':
    'Dispatches from Astoltia — Dragon Quest X news, translated from the official Hiroba.',

  // Topics / Play Guide index pages
  'topics.title': 'Topics',
  'topics.emptyPre': 'No topics yet. Open a topic URL like ',
  'topics.emptyPost':
    ' to fetch, transcribe and translate it — or seed them from the admin.',
  'playguide.title': 'Play Guide',
  'playguide.emptyPre': 'No guide pages yet. They are discovered by crawling ',
  'playguide.emptyPost': ' on the daily refresh — or seed them from the admin.',

  // Panel sections + article list + pagination
  'panel.viewAll': 'View all',
  'list.empty': 'No dispatches have arrived yet.',
  'pagination.aria': 'Pagination',
  'pagination.newest': '‹ Newest',
  'pagination.older': 'Older ›',

  // Article detail shell
  'article.viewOriginal': 'View original {noun} ↗',
  'article.noun.article': 'article',
  'article.noun.topic': 'topic',
  'article.noun.guide': 'guide',
  'article.chip.topic': 'Topic',
  'article.chip.playGuide': 'Play Guide',
  'article.translatedOn': 'Translated on',
  'article.loadingTopic': 'Loading topic…',
  'article.loadingGuide': 'Loading guide…',
  'back.home': 'Back to home',
  'back.topics': 'Back to topics',
  'back.playGuide': 'Back to play guide',

  // Events rail (article aside)
  'eventsRail.title': 'Events in this article',
  'eventType.multiDay': 'Multi-day',
  'eventType.allDay': 'All-day',
  'eventType.span': 'Timed',
  'eventType.mark': 'Milestone',

  // Calendar page
  'calendar.pageTitle': 'Events — {date}',
  'calendar.heading': 'Today in Astoltia',
  'calendar.subtitle':
    "The day's events on the DQX server. Times shown in {zone} — switch to JST from the settings gear.",
  'calendar.subtitleZone': 'your local zone',
  'calendar.changeDay': 'Change day',
  'calendar.prev': '‹ Prev',
  'calendar.next': 'Next ›',
  'calendar.today': 'Today',
  'calendar.backToToday': 'Back to today',

  // Defense Force corps (防衛軍 兵団) — short pills shown in the swimlane.
  // Keyed to lib/corps.ts; unrecognized badges fall back to corps.unknown.
  'corps.fangs': 'Fangs',
  'corps.machina': 'Machina',
  'corps.constructs': 'Constructs',
  'corps.invaders': 'Invaders',
  'corps.bones': 'Bones',
  'corps.shells': 'Shells',
  'corps.marines': 'Marines',
  'corps.dragons': 'Dragons',
  'corps.blobs': 'Blobs',
  'corps.beauties': 'Beauties',
  'corps.wings': 'Wings',
  'corps.woods': 'Woods',
  'corps.produce': 'Produce',
  'corps.ingots': 'Ingots',
  'corps.treasures': 'Treasures',
  'corps.brigands': 'Brigands',
  'corps.nightmares': 'Nightmares',
  'corps.allCorps': 'All Corps',
  'corps.unknown': '???',

  // Agenda band + timeline
  'band.aria': 'Ongoing and all-day events',
  'band.ongoing': 'Ongoing',
  'band.allDay': 'All day',
  'band.rotation': 'Rotation',
  'timeline.empty': 'No timed events on this day.',
  // Game rotation column headers (防衛軍 / メタルーキー battle content).
  'timeline.swim.defense': 'Defense Force',
  'timeline.swim.metal': 'Metal Rookie',

  // Banner carousel (all aria/labels)
  'banner.aria': 'Featured announcements',
  'banner.slide': '{n} of {total}',
  'banner.prev': 'Previous banner',
  'banner.next': 'Next banner',
  'banner.choose': 'Choose banner',
  'banner.dot': 'Banner {n}',

  // Processing-callout pipeline status (templates: {count}/{total}/{failed})
  'status.fetchFailed': 'Failed to fetch the article.',
  'status.fetching': 'Fetching content…',
  'status.downloadingImages': 'Downloading images ({count}/{total})…',
  'status.readingImageText': 'Reading image text ({count}/{total})…',
  'status.translationFailed': 'Translation failed.',
  'status.translating': 'Translating…',
  'status.translatingImages': 'Translating images ({count}/{total})…',
  'status.imagesFailedOne': 'Done — {failed} image could not be localized.',
  'status.imagesFailedOther': 'Done — {failed} images could not be localized.',
  'status.finishing': 'Finishing up…',
  'status.doneReloading': 'Done! Reloading…',
  'status.errorPrefix': 'Error: {error}',
  'status.unknownError': 'Unknown error',
} as const;
