# Strategy: Scrape, Localize & Display Rich-Text DQX "Topics"

> Living plan for bringing the rich-text `/topics/detail/` corpus from the DQX official community site (hiroba.dqx.jp) into `hiroba`: scrape → parse to a structured content tree → translate JA→EN → render with a modern, DQX/fantasy-themed design. Reconciled with the decisions we've made since the original plan-mode draft (custom nested content model, typia validation,`packages/richtext`, the design-reference inventory).

## Context

The `hiroba` project today localizes **plaintext** `/news/detail/` content: the news pipeline strips HTML from `div.newsContent`, stores a single `\n`-joined string in `news_items.content_ja`, translates it as one `content` field, and renders it with `set:html` + `white-space: pre-wrap`.

The high-value content on the DQX official site lives at **`/topics/detail/`** and is **rich text** — events, contests, updates, interviews, rankings, with imagery and decorative layout. We want to bring that content into `hiroba`: store it as a structured content tree, translate JA→EN, and render it with a modern, DQX/fantasy-themed design.

We are **not starting from zero**. The prototype at `/Users/emma/Code/DQX/Barohi/prescraper` already:

- Scraped **all ~3,306 topics** to raw HTML (`out/topics/*.html`) and extracted bodies (`out/topic_content/*.html`).
- Proved that we could parse every topic into a **structured block tree** (`out/blocks_new/*.json`, the current/complete set;
  `out/blocks/` is an abandoned 55-file partial and `out/blocks_test/` a near-duplicate variant — ignore both).
- Defined an 18-type block schema (`prescraper/schema.json`) and a recursion that pulls translatable
  strings (`prescraper/extract_texts.py`).

**Two key gaps we're closing:**

1. **Context-free, order-locked translation.** `extract_texts.py` yields a _flat, position-less_ list of strings. Translating fragments in isolation loses the sentence context the model needs, and — worse — it can't move inline formatting across the JA→EN word-order flip (Japanese "**赤い**剣" → English "the **red** sword" moves the bold). Our design fixes both by translating the **whole document as one RTML string** (§5), so the model sees full context and reorders inline tags freely.
2. **Inline-richness loss.** The prescraper's flat 18-type schema flattened inline formatting (bold, inline links, colored spans, "New" badges) into plain strings. Our content model preserves them as a nested tree (see §1), which is both a big fidelity win and what makes the fantasy re-styling possible.

**Decisions (from the user):**

1. **Full pipeline now** — bulk-import the existing corpus _and_ port the parser into Workers for ongoing incremental scraping.
2. **Images → caching proxy to R2** (lazy: fetch-on-first-view, cache, rewrite `src` to our domain).
3. **Visual style → modern stylized DQX/fantasy homage**, not a 1:1 recreation of the original 2005-era CSS.
4. **Content model → our own nested Block/Inline tree** (not Portable Text, not Mobiledoc) that mirrors the source DOM.
5. **Validation → typia** (types-first), superseding the originally-planned Zod.
6. **Translation → whole-document RTML** — serialize each topic (title + body) to a compact tag markup, translate it in one LLM call so the model can reorder inline runs, then parse the result back to a block tree. This replaces per-string extraction, JSON-Pointer keys, and the translation-memory cache.

---

## Current status

Already built in this repo:

- **`packages/richtext/src/schema.ts`** — the content model (§1). Complete: the two-tier Block/Inline
  union, `tags`-based field constraints, per-type `@example` links into the corpus, and `isInline`/
  `isBlock` guards.
- **`docs/design-reference/inventory.md`** + **`docs/design-reference/screenshots/`** (20 PNGs) — a
  design-validation catalog cataloguing every construct (variants, child model, frequency) with a
  reference screenshot each. This is the spec the renderer/theme must "match the structure" against.
- **Design direction / palette** — an illuminated-manuscript-meets-RPG token system (parchment/ink
  base, gold leaf, DQX heraldic green masthead, aged jewel accents) drawn from two reference images +
  the source material. Being wired into `apps/web` CSS custom properties.

Still to build: everything downstream of the model — DB migration + Drizzle schemas, the Cheerio
parser port, translation utils, image proxy, renderer + theme, workflow + cron, admin.

---

## Architecture at a glance

```
                                  ┌─────────────────────────────────────────────┐
  hiroba.dqx.jp/sc/topics/        │           apps/workflow (Worker)            │
  ├ backnumber/YYYY/M/  ──────────┼─▶ topics-list-scraper ─▶ topics row (stub)   │
  └ detail/{hash}/      ──────────┼─▶ TopicsWorkflow:                            │
                                  │     1 fetch-body  → Cheerio block parser →   │
                                  │                      topics.blocks_ja (JSON) │
                                  │     2 extract-events (reuse, source=topic)   │
                                  │     3 translate-blocks → RTML 1-call         │
                                  │                       → translations (JSON)  │
                                  └───────────────┬──────────────┬──────────────┘
                                                  │              │ SSE progress
  prescraper/out/blocks_new/*.json ─ bulk import ▶│ D1 (SQLite)  ▼
  prescraper/out/topics/*.html  (title/date)      │        apps/web (Astro)
                                                  │        topics/[id].astro
  cache.hiroba.dqx.jp/...  ◀─ /img proxy ─ R2 ◀───┘        renderBlocks() → themed UI
```

---

## 1. Content model — `packages/richtext`

The single source of truth shared by scraper, workflow, and renderer. A topic body is a **tree of
nodes in two tiers**, defined as TypeScript types in `packages/richtext/src/schema.ts`:

- **Block** — block-level structure (paragraph, heading, image, table, infoBox, …).
- **Inline** — inline-level runs inside text (text, link, strong, color, badge, …).

**Containment invariant:**

- Inline nodes may only contain Inline children. (`Inline ⊂ Inline`)
- Block nodes may contain Block _or_ Inline children — a `ContentNode = Block | Inline`.

This deliberately mirrors the source DOM (scraped HTML) and the render target (HTML), so **parse and
render are the same recursive walk**. Text is the leaf: a bare `string` (`TextNode = string`), so
inline formatting nests naturally, e.g. `strong > color > "…"`.

**Validation is by typia** — the TypeScript types _are_ the schema. Field-level constraints ride on
the types as typia `tags`:

- `HexColor = string & tags.Pattern<'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'>`
- `Count = number & tags.Type<'uint32'> & tags.Minimum<1>`

typia's `tspc` transformer generates the `is`/`assert`/`validate` functions from these types for
ingest-time validation (bulk import and live scrape), with no hand-written validator to drift.
Because typia is contained to this one package's build, downstream consumers (Workers/esbuild, Astro/
Vite) just import plain JS + `.d.ts`.

### Node inventory

**Inline tier:** `text` (bare string leaf) · `break` · `strong` · `emphasis` · `color` (`+value`) ·
`link` (`+href`, `external?`) · `badge` (atomic, e.g. the "New" chip) · `icon` (atomic glyph, e.g.
ordinal/platform icons).

**Block tier:**

- _text blocks_ (Inline children): `paragraph` (`align?`) · `heading` (`level 1–4`, `variant?`) ·
  `button` (`href`, `variant?`) · `divider`.
- _media / leaf blocks_: `image` (`src`, `alt?`, responsive `sources?`) · `video`
  (`provider: youtube|other`) · `embed` (`provider: twitter`, `variant?`).
- _container blocks_ (`ContentNode` children): `infoBox` (`variant: highlight|quest|terms|cork|
statistics|mini|screenshot`) · `section` (`variant?`, `title?`, `dateline?`) · `accordion`
  (`summary`) · `speechBubble` (`speaker?`, `icon?`) · `messageBox` (`name?`, `role?`).
- _structured blocks_ (own child shapes): `list` (`ordered`, `variant?: default|caution`, `items`) ·
  `table` (`headers?`, `rows`, cells with `colSpan`/`rowSpan`) · `interview` (`exchanges[]` of
  `{question: Inline[], answer: Block[]}`) · `steps` (`variant?: numbered|howto`) · `ranking`
  (`variant?: default|area`, ranked `items`).

`TopicDocument = { id, blocks: Block[] }` is the top-level shape. `isInline`/`isBlock` guards +
`INLINE_TYPES` provide runtime discrimination (a bare string is always Inline).

### Why this differs from prescraper's flat 18-type `schema.json`

Justified by a source-HTML census of the 3,306-topic corpus (we found examples by scanning
`out/topic_content`, not the derived block output):

- **Inline formatting preserved as nesting** instead of flattened to strings: `bold_red → strong>color`,
  in-prose `<a> → link`, `<span style="color"> → color`, `ico_newsystem "New" → badge`, ordinal
  icons → `icon`. (Inline links appear in ~90% of topics — the single biggest fidelity win.)
- **+ `divider`** (`lineType1`, an empty bordered `<p>`, 275 topics).
- **`list` is first-class** (emitted 790× but missing from `schema.json`); the old `caution_list`
  folds in as `list variant='caution'`.
- **`section` gains `dateline`** (repurposes `.news_date` — a newspaper byline, not an event range)
  and `title`.
- **Dropped** `letter` (1 trivial caption → paragraph) and `date_range` as a type (event dates live
  in prose; the `extract-events` step handles them).
- **`interview`** fixed: `answer` is `Block[]`, `question` is `Inline[]` (repairs the empty
  `tit_q`/`txt_itv_main` pairing bug that dropped all interviews in the old parser).

Each type in `schema.ts` carries `@example https://hiroba.dqx.jp/sc/topics/detail/<id>/` links to
1–3 real topics containing it, cross-referenced with the screenshots in `docs/design-reference/`.

### Serialization & translation utils (same package)

Translation round-trips the whole document through **RTML** — a compact, canonical tag markup
that is a _lossless_ serialization of the block tree (see §5 for how it's used). Two functions, plus
the image helper:

- **`serializeToRtml(doc: {title, blocks}): string`** — the block tree → RTML. Shares the
  recursive-walk shape of the renderer (§8) but emits our own canonical vocabulary rather than themed
  HTML. **The design rule that makes it robust:** every human-readable string is _element content_;
  every non-linguistic value (`href`, `src`, `color value`, `variant`, `align`, `provider`,
  `colSpan`, `rank`, `external`) is an _attribute_. So the model only ever rewrites text between tags
  and never has to touch an attribute. The vocabulary uses natural HTML where it exists (`<strong>
<em> <a href> <br> <ul>/<ol>/<li> <table>/<tr>/<td> <h1..4> <img> <hr>`) and custom tags for our
  constructs (`<color value> <badge> <icon> <infobox variant> <section> <accordion> <speech>
<message> <interview> <steps> <ranking> <button>`). Fields that are themselves text (`speaker`,
  `writer`, `interview.title`, `messageBox.name`/`role`, `section.title`/`dateline`) become child
  elements (`<speaker>…</speaker>`), never attributes — so they get translated too.
- **`parseRtml(markup: string): {title, blocks}`** — RTML → block tree, built on an
  off-the-shelf HTML5 parser rather than bespoke parsing (see _Parsing the markup back_, below). The
  result is validated with typia (§1); a parse/validate failure triggers the fallback in §5. The
  round-trip is an identity — `parseRtml(serializeToRtml(doc)) ≡ doc` — verified over the whole
  corpus (see Verification).
- **`rewriteImageSrc(src): string`** — normalize image URLs (absolute `cache.hiroba.dqx.jp/…` and
  relative `/dq_resource/…`) → our `/img/…` proxy path (see §7).

### Parsing the markup back

`parseRtml` needs no hand-written parser — an off-the-shelf one handles unknown tags and
attributes fine. The choice of _which kind_ matters:

- **Use htmlparser2** (the forgiving HTML tokenizer Cheerio is built on; a direct dependency of
  `@hiroba/richtext`). It treats any unrecognized tag as a generic element and preserves unknown
  attributes verbatim, so `<infobox variant="highlight"><color value="#c03">…</color></infobox>`
  parses into exactly the tree we want, with no schema registration. And it **never throws** — it
  _recovers_ from malformed input — the right posture against imperfect LLM output: a stray `&` or a
  slightly misnested tag yields a repaired tree, not a crash. We map tag→node type on the way out and
  let the typia + tag-multiset check (§5) catch anything recovery silently changed.
- **Not a strict XML parser.** XML accepts unknown tags/attributes too, but _hard-fails_ on any
  non-well-formed input (an unescaped `&`, one unclosed tag) — turning every minor model slip into a
  total loss instead of a recoverable one.

htmlparser2 sidesteps HTML5's nastier tree-construction rules outright — no foster-parenting, no
injected `<tbody>` — but a few tokenizer behaviors still shape the **vocabulary** (all verified with a
probe over the real cases):

- **Void + self-closing:** map genuinely-atomic nodes onto HTML's real void tags (`break→<br>`,
  `divider→<hr>`, `image→<img>`, `embed→<embed>`) and give every _custom_ atom an explicit close tag
  (`<icon …></icon>`). We also enable `recognizeSelfClosing`, so a model-emitted `<icon …/>` is
  tolerated instead of swallowing its siblings.
- **Reserved names:** don't name custom constructs after HTML's special-cased elements — `<title>
  <style> <script> <textarea>` parse as raw text, and `<image>` is silently rewritten to a void `<img>`.
  Carry the document title as `<doctitle>`, section titles as `<sectiontitle>`, and keep HTML-unknown
  names like `<infobox> <color> <badge>`.
- **Natural tags are safe here:** `<p>`, `<ul>/<ol>/<li>`, `<table>/<tr>/<td>/<th>`, `<h1..4>` all parse
  cleanly — htmlparser2 doesn't foster-parent or inject a `<tbody>`, and our containers only ever hold
  their proper children. Using real HTML tags where they exist buys reliability: the model has a huge
  prior for them. Serialization stays **compact** (no inter-tag whitespace), and parsing drops
  whitespace-only text between elements, so LLM-added indentation can't leak in as stray text nodes.
- **Attribute case:** HTML lowercases names, so the vocabulary uses lowercase attributes (`colspan`,
  not `colSpan`) and the parser reads them case-insensitively.

The **round-trip identity test** (§ Verification) over all ~3,306 corpus docs is what proves this
vocabulary+parser pairing is lossless — any construct that doesn't survive `serialize → parse` surfaces
there before it can corrupt a translation.

---

## 2. Data model — `packages/db`

New migration `apps/workflow/migrations/0009_add_topics.sql` (STRICT + CHECK, matching the
`0008_schema_overhaul.sql` style). New Drizzle schemas under `packages/db/src/schema/`.

**`topics`** (mirrors `news-items.ts`, but body is a block tree, not plaintext):

```sql
CREATE TABLE `topics` (
  `id` text PRIMARY KEY CHECK(length(`id`) = 32),
  `published_at` integer NOT NULL,                 -- Temporal.Instant (epoch ms), reuse instant() type
  `title_ja` text NOT NULL,
  `blocks_ja` text CHECK(`blocks_ja` IS NULL OR json_valid(`blocks_ja`)),   -- JSON block tree (source of record)
  `category` text,                                 -- nullable; topic taxonomy is a later enhancement
  `body_fetched_at` integer
) STRICT;
CREATE INDEX `topics_published_at_idx` ON `topics` (`published_at`);
```

**Reuse `translations`** for the localized output — it _already_ supports `item_type='topic'`
(see `packages/db/src/schema/translations.ts`) and, because we now translate the document as a whole,
we need only **two rows per (topic, language)**, exactly mirroring the news pipeline:

- `field='title'` → the translated title (plaintext), so the topics **list** can show EN titles
  without parsing the body.
- `field='content'` → the translated **block tree as a JSON blob** (the parsed result of the RTML
  round-trip, §5).

**Queries** to add in `packages/db/src/queries.ts`: `upsertTopic`, `getTopic`, `getTopics` (paginated,
mirror `getNewsItems`), `getTopicTranslations`, `upsertTopicTranslation`.

---

## 3. Parser port — `packages/scraper`

`hiroba` already parses HTML with **Cheerio** (`packages/scraper/src/body-scraper.ts`); `prescraper`'s
parser uses **happy-dom**. Port `prescraper/transformer.js` + its extractors (`prescraper/blocks/*.js`)
to Cheerio, **targeting the new nested Block/Inline model** (§1) — the priority-ordered extractor
registry (compound/container patterns first, generic `paragraph`/`image` last) carries over, but
inline handling now recurses into a nested `Inline[]` instead of flattening to strings.

- New: `packages/scraper/src/topics-list-scraper.ts` — enumerate `/sc/topics/backnumber/YYYY/M/`
  → `{id, titleJa, publishedAt}` (title/date come from the list + the detail page's `h2.iconTitle`,
  **not** from the block JSON). Mirror `list-scraper.ts`.
- New: `packages/scraper/src/topics-body-scraper.ts` — fetch `/sc/topics/detail/{id}/`, select
  `div.newsContent`, run the ported block parser → `blocks_ja`.
- **Parity gate (verification):** run the ported Cheerio parser over `prescraper/out/topic_content/*.html`
  and diff against `prescraper/out/blocks_new/*.json` (accounting for the intentional model changes in
  §1). Must reach high fidelity before we trust it for live scraping. Systematic diffs → fix the
  extractor; one-off diffs → log + accept.
- **Not this parser:** parsing the RTML back (`parseRtml`, §1) is a _separate_ concern — an
  off-the-shelf HTML5 parser over our own canonical markup — not this bespoke source-site parser.

---

## 4. Bulk import (one-time seed of the ~3,306-topic corpus)

An admin-triggered Cloudflare Workflow with SSE progress (reuse the workflow-coordinator DO + admin
SSE pattern):

1. Read `prescraper/out/blocks_new/*.json` (blocks) + `prescraper/out/topics/*.html` (title via
   `h2.iconTitle`, date from title/`<title>`). Validate each tree against the typia validator (§1);
   quarantine + report failures.
2. `upsertTopic` rows with `blocks_ja`.
3. Translate each topic as a whole document (§5); process in batches, emit progress. (No TM dedup, so
   boilerplate is re-translated — the one-time cost we accepted in §2.)
4. Store the EN `title`/`content` rows in `translations` per topic.

No image download here (we chose the lazy R2 proxy, §7). The corpus JSON lives outside the repo
(`prescraper/out`), so it's delivered to the Worker via an import endpoint / R2-staged upload.

> If the parser port (§3) reaches high parity, an alternative is to re-parse the raw HTML in-Worker
> rather than importing `blocks_new` — same code path as live scraping. Decide at M3 based on the
> parity gate.

---

## 5. Translation pipeline — `apps/workflow/src/steps/translate-blocks.ts`

The whole topic is translated as **one RTML document**, so the model has full context and can
reorder inline tags across the JA→EN word-order flip. Reuse `findMatchingGlossaryEntries` and the
DQX-tuned `TRANSLATION_SYSTEM_PROMPT` from `steps/translate.ts`; the CSV helpers
(`buildCsvInput`/`parseCsvResponse`) are **not** used — the I/O unit is RTML, not a string table.

1. `serializeToRtml({title: title_ja, blocks: blocks_ja})` (§1) → one markup string.
2. One LLM call (GPT-4o today — switching to Sonnet-5, see _Future_; `temperature: 0.3`): the system
   prompt tells the model to **translate only
   text between tags, preserve every tag and attribute verbatim, and freely reorder inline tags** to
   read naturally in English; inject matching glossary entries for proper-noun consistency.
3. `parseRtml(response)` → `{title, blocks}`; **validate with typia** (§1) and check tag integrity
   (same tag/attribute multiset in vs. out — catches a dropped `<img>` or a mangled `href`).
4. Persist two `translations` rows: `field='title'` (plaintext) and `field='content'` (the block-tree
   JSON blob). No `translation_memory`, no `topics.blocks_en`.

**Fallback on a bad round-trip** (invalid parse, typia failure, or tag mismatch): retry once; if it
still fails, quarantine the topic and leave it JA (the renderer already falls back to `blocks_ja`) so
one bad response can never corrupt stored structure.

**Chunking:** most topics fit a single call, but the longest exceed the output-token ceiling. When
the serialized markup is too large, split at **top-level block boundaries** into ordered chunks,
translate each (optionally passing the title / prior chunk as context), and concatenate the parsed
block arrays. Never split inside a block, so every chunk is independently well-formed RTML.

---

## 6. Live ingestion — `apps/workflow`

- **`TopicsWorkflow`** (new class mirroring `news-workflow.ts`): `fetch-body` (scrape + parse →
  `blocks_ja`) → `extract-events` (**reuse** `steps/extract-events.ts`; the `events` table already
  has `source_type='topic'` — topics are event-rich, so this is a real win) → `translate-blocks` (§5).
  Register a second workflow binding in `apps/workflow/wrangler.toml`.
- **Cron**: extend `scheduled()` in `apps/workflow/src/index.ts` to also scrape the latest topics
  (first backnumber page / latest list) hourly; enqueue new ids → trigger `TopicsWorkflow` via the
  workflow-coordinator DO.
- **DO keying caution**: the coordinator DO is `idFromName(item.id)`. News and topic ids are both
  32-char hex and _could_ collide — namespace the DO name (`idFromName('topic:'+id)`) and/or thread an
  `itemType` through the trigger payload so news vs topic workflows don't clobber each other.

---

## 7. Image proxy → R2

- Add an **R2 bucket binding** in `apps/workflow/wrangler.toml`.
- New Worker route **`/img/[host]/[...path]`**: the upstream host is the first path segment, so the
  route reconstructs `https://<host>/<path>` — serve from R2 if present, else fetch upstream (sane
  `User-Agent`/`Referer`), stream to client while writing to R2, set long-lived `Cache-Control`. Lazy =
  only viewed images are ever mirrored. Allow only `*.dqx.jp` hosts so the route can't become an open
  proxy.
- `rewriteImageSrc` (§1) is applied by the renderer to every `image.src`/`icon.src` (and any `src`
  inside table cells). It **encodes the upstream host in the path** — `/img/<host>/<path>` — so the
  rewrite is lossless and collision-free across the several DQX image hosts (a corpus scan found
  `cache.hiroba.dqx.jp` ~92%, root-relative `/dq_resource/…`, `faceicon.dqx.jp` avatars, plus
  `hiroba.dqx.jp` / `close.cache.hiroba.dqx.jp`). CDN aliases canonicalize to `cache.hiroba.dqx.jp` so
  identical assets dedup to one R2 key; genuinely off-site hosts (e.g. ganganonline.com) stay
  unproxied.

---

## 8. Renderer + display — `apps/web` (+ shared renderer)

- **`renderBlocks(blocks): string`** — a recursive, server-side HTML renderer in a shared module
  (reusable by web _and_ admin preview). It's a sibling of `serializeToRtml` (§1) — the same
  recursive walk over `ContentNode`, but emitting _themed_ HTML instead of the canonical RTML
  vocabulary. **Escape all text nodes** — we emit our own tags from structured data, strictly safer
  than the news path's `set:html` of scraped HTML. Recurse into
  `infoBox`/`section`/`accordion`/list/table/interview children.
- **New pages** (mirror `apps/web/src/pages/news/[id].astro`):
  - `apps/web/src/pages/topics/[id].astro` — load the topic + its `translations` rows; render the EN
    `content` blob when present, else fall back to `blocks_ja`; fire `TopicsWorkflow` if the EN row is
    missing, reusing the **SSE processing-notice** client (`news/[id].astro`).
  - `apps/web/src/pages/topics/index.astro` — paginated list; integrate a "Topics" entry into home/nav.
  - `apps/web/src/pages/api/topics/[id]/[lang].ts` + `…/sse.ts` (mirror the news API routes).

### Design direction — modern stylized DQX/fantasy

The project styles with **scoped Astro CSS + CSS custom properties** (no Tailwind). We're building a
small **fantasy design-token theme** — an _illuminated-manuscript-meets-RPG_ system: vellum/parchment
surfaces, brown ink, gold-leaf ornament, a DQX heraldic-green masthead, and aged jewel accents
(sapphire, vermilion, amber, ember, plum, steel) mapped to semantic roles (links, caution, infoBox
variants). Tokens are centralized (raw palette + semantic layer) so a future theme switch / dark mode
is one file; the legacy `--color-*` tokens map onto the new palette for back-compat.

Each block type + variant maps to a polished, **responsive, accessible** component that reads better
than the 2005 originals, validated against **`docs/design-reference/inventory.md`** (per-type anatomy

- reference screenshots — "match the structure"):

* `heading` (`icon`/`quest` variants) → ornamented section banners.
* `infoBox` (`highlight`/`quest`/`terms`/`cork`/`statistics`/`mini`/`screenshot`) → themed cards
  (quest-scroll, terms-parchment, cork-board, stat-panel, …).
* `list variant='caution'` → inset ※-notice callout; `button` variants → themed CTAs.
* `interview` → two-column Q&A with speaker treatment; `speechBubble` → portrait-slot bubble;
  `ranking` → podium/leaderboard; `steps` → numbered quest steps; `table` → striped fantasy table;
  `video`/`embed` → lazy responsive embeds; `badge`/`icon` → inline chips/glyphs.

---

## 9. Admin — `apps/admin`

- `TopicsList` + Dashboard stats (mirror `NewsList`/`Dashboard`); buttons to trigger bulk import and
  re-translate.
- **Translation review UI**: edit a topic's EN output and save it back to its `translations`
  `content` row (either as edited RTML re-parsed, or block-by-block). Scope is **per topic** —
  with `translation_memory` gone there's no cross-topic string propagation; consistency across topics
  is instead driven by the shared **glossary** (edit a term once, re-translate). A later milestone.

---

## Milestones (suggested build order)

- **M0 — Content model** ✅ _(done)_: `packages/richtext` nested Block/Inline schema + typia tags +
  guards; `docs/design-reference` inventory + screenshots; palette/design direction.
- **M1 — Foundations**: `serializeToRtml`/`parseRtml`/`rewriteImageSrc` (+ round-trip test),
  migration `0009`, Drizzle schemas + queries, parser port to Cheerio, **parity gate** vs `blocks_new`.
- **M2 — Display path**: image proxy + R2, `renderBlocks` + fantasy theme, `topics/[id].astro`
  rendering `blocks_ja` (JA-only first, proves storage + render + images).
- **M3 — Localize**: `translate-blocks` step (whole-document RTML round-trip) + bulk import of the corpus.
- **M4 — Live**: `TopicsWorkflow`, cron incremental scrape, DO namespacing, admin TopicsList.
- **M5 — Polish**: translation review UI, design refinement, dark mode.

---

## Verification

- **Parser parity**: ported Cheerio parser over `prescraper/out/topic_content/*.html` diffed against
  `prescraper/out/blocks_new/*.json` (net of the intentional model changes in §1) — quantify match
  rate; investigate systematic diffs.
- **Schema validation**: validate all ~3,306 block docs against the typia validator; report failures.
- **RTML round-trip**: `parseRtml(serializeToRtml(doc)) ≡ doc` over all ~3,306 corpus
  docs (deep-equal) — the serialization must be lossless or translation corrupts structure.
- **Translated-output integrity**: on a sample of real LLM responses, confirm the tag/attribute
  multiset is preserved and the parse-back validates against typia; confirm the fallback quarantines a
  deliberately-mangled response instead of storing it.
- **Local D1 e2e**: `pnpm db:migrate:local`; seed ~20 sample topics; run translate; `astro dev` +
  `wrangler dev`; open `topics/[id]` — confirm themed render, image proxy populates R2 (2nd hit served
  from R2), SSE processing-notice → reload, JA fallback when the EN row is absent.
- **Live e2e**: trigger `TopicsWorkflow` on one real topic id; watch SSE; confirm `blocks_ja`, the EN
  `title`/`content` `translations` rows, and any extracted `events` (source_type='topic').

---

## Key files

**Already built:** `packages/richtext/src/schema.ts` · `packages/richtext/src/index.ts` ·
`docs/design-reference/inventory.md` + `docs/design-reference/screenshots/`.

**Reuse / mirror:** `packages/scraper/src/{list-scraper,body-scraper}.ts` ·
`apps/workflow/src/news-workflow.ts` · `apps/workflow/src/steps/{translate,extract-events,fetch-body}.ts` ·
`apps/web/src/pages/news/[id].astro` ·
`packages/db/src/schema/{translations,events,glossary,news-items}.ts` ·
`packages/db/src/queries.ts` · `packages/shared/src/constants.ts` · `apps/workflow/wrangler.toml`.

**Create:** `apps/workflow/migrations/0009_add_topics.sql` ·
`packages/db/src/schema/topics.ts` · `packages/richtext/src/{rtml,image-url}.ts` (serialize + parse) ·
`packages/scraper/src/topics-{list,body}-scraper.ts` + ported block extractors ·
`apps/workflow/src/topics-workflow.ts` + `src/steps/translate-blocks.ts` · image-proxy route + R2 binding ·
`apps/web/src/pages/topics/[id].astro` + `topics/index.astro` + `api/topics/[id]/{[lang],sse}.ts` +
fantasy theme CSS · `apps/admin` TopicsList + translation-review components.

**Port from prescraper:** `transformer.js` + `blocks/*.js` (→ Cheerio, targeting the nested model).
(`extract_texts.py` is _not_ ported — its flat-string extraction is superseded by the RTML
round-trip.)

---

## Future / adjacent work (not yet scoped)

Known upcoming changes this plan should _anticipate_ but doesn't fully specify. Each notes where it
would touch the sections above.

### Model: GPT-4o → Sonnet-5

The translate step (§5) is written against the current stack's GPT-4o, but the model is a swappable
detail — same RTML I/O, same glossary injection. The near-term switch is **Sonnet-5**, which
matters here beyond raw quality: it's the house model, and it's **multimodal**, which lets the image
work below live _inside_ this pipeline instead of as a bolted-on OCR service. (Prompt-tuning the
tag-fidelity instructions may differ slightly between models — the §5 fallback keeps a bad response
safe regardless of which model is behind it.)

### Image text localization

Much of a topic's text is _baked into images_ (event banners, decorative headings); today those pass
through the R2 proxy (§7) untranslated. Bringing them into the loop has two parts:

1. **Extraction — a prerequisite pre-pass.** Before translate, a vision step reads each image's
   in-picture JA text and attaches it to the `image` node via a new optional field on `ImageNode`
   (e.g. `text?: Inline[]`) — the one schema addition this needs (M0's schema is otherwise frozen).
   It pairs with the R2 mirror step: "prepare images" = fetch + OCR, surfaced as an **SSE-visible
   prerequisite phase** ("processing images…") so a topic isn't considered translatable until its
   images are read. Sonnet-5's vision makes this first-party (and could fold OCR + translation into
   one call).
2. **Carry it through the same translation call — the "text inside the `<img>` tag" trick.**
   `serializeToRtml` emits the extracted text as the image element's _content_ —
   `<img src="…">…JA text…</img>` — so it rides the whole-document call and gets translated **with full
   surrounding context** (a banner reading 「夏の大型アップデート」 lands better when the model sees the
   paragraph around it). This falls straight out of the existing "all human-readable text is element
   content" rule (§1); parse-back writes the EN string back onto `image.text`. No change to the
   round-trip contract itself.
   - _Open question — rendering (§8):_ show the translated text as a caption/overlay, as improved
     `alt`, or (fanciest) composite it back onto the image. Decide when we build it.

Net when built: one new `ImageNode.text` field (§1); one "prepare images" workflow step with OCR (§6)
that's an SSE prerequisite (§8); and a render treatment for translated image text (§8).
