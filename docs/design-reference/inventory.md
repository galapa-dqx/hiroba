# DQX Topics — Interface Inventory

A catalog of every construct in the topic content model ([`@hiroba/richtext`](../../packages/richtext/src/schema.ts)),
for **validating our own designs against the source structure**. For each type: its
**anatomy** (the structural slots a component must reproduce), its **variants** (each a
distinct visual), what it **contains**, the **source** HTML it came from, corpus
**frequency**, and a **reference** (live topic + screenshot).

How to use: when building a component, find its entry, reproduce every slot in **Anatomy**,
handle every **Variant**, and honour the **Contains** child model. Frequencies are the
priority signal — build the top of each tier first.

Screenshots are in [`./screenshots/`](./screenshots) (cropped to `.newsContent`, no site chrome).
Live references are `https://hiroba.dqx.jp/sc/topics/detail/<id>/`.

---

## Structural invariant (must hold in every design)

- **Inline** nodes contain **only Inline** children. (`Inline ⊂ Inline`)
- **Block** nodes may contain **Block or Inline** children (`ContentNode[]`).
- Text is a bare `string` leaf. Every text-bearing slot is an **inline run** (`Inline[]`)
  that can carry links / bold / color mid-sentence — designs must not assume a text slot
  is a flat string.
- Container blocks nest arbitrarily deep (`infoBox` → `section` → `list` → …). Components
  must recurse, not assume a fixed depth.

---

## Coverage checklist

Tick each off when its component reproduces the anatomy + all variants.

### Inline tier
| Type | Variants | Contains | Freq | Ref |
|---|---|---|---|---|
| `text` (bare string) | — | leaf | ubiquitous | 01 |
| `break` | — | leaf | ubiquitous | 01 |
| `strong` | — | `Inline[]` | ~97% of topics | 01 |
| `emphasis` | — | `Inline[]` | rare | 13 |
| `color` | (any hex) | `Inline[]` | ~90% of topics | 09, 11 |
| `link` | internal / external | `Inline[]` | ~90% of topics (65k links) | 01 |
| `badge` | (open) | leaf (`text`) | 688 topics | 12 |
| `icon` | (open) | leaf (`src`) | ~120 topics | 14 |

### Block tier
| Type | Variants | Contains | Freq (blocks) | Ref |
|---|---|---|---|---|
| `paragraph` | align l/c/r | `Inline[]` | 63,557 | 01 |
| `heading` | default, icon, quest, label | `Inline[]` | 32,690 | 01 · 18 (quest) |
| `image` | default, newspaper, bordered, … | leaf (+`sources`) | 28,397 | 01 |
| `table` | default, contents, tp | `TableCell` grid | 8,126 | 10, 07 |
| `infoBox` | highlight, statistics, terms, quest, screenshot, mini, cork | `ContentNode[]` | 4,918 | 01, 02, 20 (cork), 19 (mini) |
| `button` | default, square, vt2013, estore, reservation | `Inline[]` label | 3,681 | 11 |
| `list` | default, **caution** | `ListItem[]` | 790 + 2,442 caution | 01, 08 |
| `section` | newspaper, report | `ContentNode[]` (+title, dateline) | 2,408 | 03 |
| `accordion` | — | `ContentNode[]` (+summary) | 647 | 09 |
| `divider` | — | leaf | 275 topics | 15 |
| `video` | youtube, other | leaf | 135 | 16 |
| `embed` | tweet, timeline, button, hashtag | leaf | 84 | 17 |
| `steps` | numbered, howto | `StepItem[]` | 57 | 08 |
| `ranking` | default, area | `RankingItem[]` | 43 | 07 |
| `messageBox` | — | `ContentNode[]` (+name, role) | 17 | 06 |
| `speechBubble` | — | `ContentNode[]` (+speaker, icon) | 4 | 05 |
| `interview` | — | `InterviewExchange[]` | 5 topics | 04 |

---

## Inline tier — anatomy

### `strong` / `emphasis`
- **Anatomy:** an inline run rendered bold / italic. No box; flows within text.
- **Contains:** `Inline[]` (can wrap a `link`, `color`, etc.).
- **Source:** `<b>`, `<strong>`, `bold_red` (bold+red — becomes `strong > color`), `<em>`/`<i>`.
- **Design:** must survive mid-sentence; must nest (bold inside a link, color inside bold).

### `color`
- **Anatomy:** inline run in a specific hex color; often combined with bold for warnings.
- **Contains:** `value: HexColor` + `Inline[]`.
- **Source:** `<span style="color:#…">`. Common semantic use: red for deadlines/"ended".
- **Design:** don't hard-map to a palette token blindly — the source hex is meaningful
  (red = caution). Preserve intent; ensure contrast on our background.

### `link`
- **Anatomy:** inline anchor; `external` gets an out-arrow / new-tab affordance.
- **Contains:** `href`, `external?`, `Inline[]` label.
- **Source:** in-prose `<a href>` (internal `/sc/…` vs external).
- **Design:** the big fidelity item — links appear *inside* paragraphs, not just as buttons.

### `badge`
- **Anatomy:** a small standalone chip/pill (e.g. red "New").
- **Source:** `ico_newsystem`. **Design:** a compact inline label, baseline-aligned with text.

### `icon`
- **Anatomy:** a small inline glyph image (platform/ordinal markers).
- **Source:** `ico_2nd`…`ico_5th`. **Design:** inline, text-height, doesn't break the line box.

---

## Block tier — anatomy

### `paragraph`
- **Anatomy:** a block of inline run, optional align (l/c/r). Centered is common for
  announcements.
- **Contains:** `Inline[]`.

### `heading`
- **Anatomy:** `level` 1–4 + text; `icon` variant has a **leading icon slot**; `quest`
  variant is a **decorated/framed** title; `label` = a small decorative eyebrow (the
  over-used `title_icon0x` sub-labels — style these lighter than a real heading).
- **Contains:** `Inline[]`.
- **Source:** `title01`–`04`, `title_icon0x`, `title_quest`.
- **Design:** don't render all four variants at one weight — the corpus leans on `icon`
  (~21k) as sub-labels; give `label` a distinct, quieter treatment.

### `image`
- **Anatomy:** block image, centered, optional border; `sources[]` = responsive widths.
- **Contains:** `src`, `alt?`, `variant?`, `sources?`.
- **Design:** all `src` route through the `/img` R2 proxy. Max content width ~520–960px.
  `alt` is almost always absent — plan to generate it.

### `table`
- **Anatomy:** optional **header row** + body rows of `TableCell`; cells carry
  `colSpan`/`rowSpan`, a `header` flag, and **block/inline children** (cells can hold images).
  `contents` = a layout/contents table (often headerless); `tp` = a topics data table.
- **Contains:** `headers?: TableCell[]`, `rows: TableCell[][]`.
- **Design:** must handle headerless "layout tables" (33% have no header row) and responsive
  overflow on narrow screens.

### `infoBox` — the workhorse (7 variants)
- **Anatomy:** a decorated container, often **header/title strip + body**; body is nested
  content. Each variant is a **distinct frame**:
  - `highlight` (2,151) — the standard rounded brown box (`brownroundBox`).
  - `statistics` (1,179), `terms` (1,102) — parchment/terms panels.
  - `quest` (455) — quest-scroll frame.
  - `screenshot` (16), `mini` (13), `cork` (2) — rare; screenshot frame, small box, cork-board.
- **Contains:** `ContentNode[]` (recursive).
- **Design:** this is the highest-leverage component — design the frame system so a variant
  is a theme swap, not a new component. See screenshots 01 (highlight) & 02 (screenshot).

### `list`
- **Anatomy:** ordered/unordered items; `caution` variant = the **※ notice list** (each item
  a caution line). Items hold nested content (links, sub-lists).
- **Contains:** `items: ListItem[]` where `ListItem = { children: ContentNode[] }`.

### `section`
- **Anatomy:** **masthead/title** + optional **dateline byline** + body. `newspaper` =
  "アストルティア通信" format (see 03); `report` = dev report layout.
- **Contains:** `title?: Inline[]`, `dateline?: Inline[]`, `ContentNode[]`.

### `accordion`
- **Anatomy:** a **clickable summary header** (toggle) + **collapsible body**.
- **Contains:** `summary: Inline[]`, `ContentNode[]`.
- **Source:** `ad_menu` + `btn_ad_menu`. **Design:** needs open/closed state + a11y disclosure.

### `speechBubble`
- **Anatomy:** **speaker portrait** (left) + optional **speaker name** + **rounded bubble body**.
- **Contains:** `speaker?`, `icon?` (portrait src), `ContentNode[]`.
- **Reference:** 05 — portraits left, tan bubbles right.

### `messageBox`
- **Anatomy:** a **quoted body** + **attribution** (name / role). Player-voice or NPC quotes.
- **Contains:** `content` (`ContentNode[]`), `name?`, `role?`. **Reference:** 06.

### `interview`
- **Anatomy:** optional **title**, a sequence of **Q/A pairs** (question label + Q, answer
  label + A), and a **writer** attribution line.
- **Contains:** `exchanges: { question: Inline[]; answer: Block[] }[]`, `title?`, `writer?`.
- **Reference:** 04. **Design:** distinguish Q vs A clearly (label chips / indentation).

### `steps`
- **Anatomy:** ordered **step markers** (number or how-to badge) + step body.
- **Contains:** `items: { n?: number; children: Block[] }[]`. **Reference:** 08.

### `ranking`
- **Anatomy:** rows of **rank (number/medal) + title + count**. Podium emphasis for top 3.
- **Contains:** `items: { rank; title: Inline[]; count? }[]`. **Reference:** 07.

### `button`
- **Anatomy:** a styled CTA link with an inline label. Variants are visual skins
  (`square`, `vt2013` event style, `estore`, `reservation`).
- **Contains:** `href`, `Inline[]` label, `variant?`. **Reference:** 11.

### `video` / `embed` / `divider`
- `video` — responsive 16:9 YouTube frame (`provider`, `src`).
- `embed` — Twitter/X widget; `variant` = tweet / timeline / follow-button / hashtag.
- `divider` — a horizontal rule (`lineType1`, an empty bordered `<p>`).

---

## Cross-cutting design must-handles

1. **Deep nesting** — `infoBox`/`section`/`accordion`/`table`-cell hold full `ContentNode[]`;
   every container must recurse. Test a box-in-a-box.
2. **Inline richness mid-text** — links, bold, color, badges inside a running sentence
   (not just at block level). This is the main gap in the old 2005 render we're fixing.
3. **Long Japanese strings** — no width assumptions; wrap gracefully; watch button labels.
4. **Fixed content width** — source sits ~520–960px centered. Our design sets the width;
   don't inherit the cramped original, but honour image aspect at the chosen width.
5. **Images via proxy** — every `image`/`icon` `src` rewrites to `/img/…` (R2). Never hotlink.
6. **Variant = theme, not fork** — especially `infoBox` (7) and `heading` (4): one component,
   variant-driven styling.
7. **Accessibility** — `accordion` disclosure semantics, table headers, generated `alt`,
   color-contrast on the fantasy palette (source reds/browns won't all pass on a new bg).

---

## Screenshot index

| # | File | Primary types shown |
|---|---|---|
| 01 | `01_general-infobox-list-table` | infoBox (highlight), heading, image, list, button, table, link, color |
| 02 | `02_infobox-screenshot` | infoBox (screenshot) |
| 03 | `03_newspaper-dateline` | section (newspaper) + dateline |
| 04 | `04_interview` | interview |
| 05 | `05_speech-bubble` | speechBubble |
| 06 | `06_message-box` | messageBox |
| 07 | `07_ranking` | ranking, table |
| 08 | `08_steps-howto` | steps (howto), list, image |
| 09 | `09_accordion-color` | accordion, color, section |
| 10 | `10_table` | table |
| 11 | `11_buttons-vt2013` | button (vt2013), color |
| 12 | `12_badge-new` | badge ("New"), table, heading |
| 13 | `13_emphasis-italic` | `emphasis` — outlined italic run |
| 14 | `14_icon-ordinal` | `icon` — outlined ordinal "2nd" badge |
| 15 | `15_divider-linetype1` | `divider` — outlined ornamental rule |
| 16 | `16_video-youtube` | `video` — outlined YouTube embed |
| 17 | `17_embed-twitter` | `embed` — outlined Twitter/X share button |
| 18 | `18_heading-quest` | `heading` (quest) — outlined |
| 19 | `19_infobox-mini` | `infoBox` (mini, `.box_mi`) — outlined |
| 20 | `20_infobox-cork` | `infoBox` (cork) — outlined ranking board |

_**Full-body context shots** (show nesting + spacing between blocks): 01, 02, 03, 04, 11.
**Outlined targeted shots** (single construct pinned with a green `outline` + `outline-offset`,
self-verifying): 05–10, 12–20. Notes: `02` (screenshot infoBox) and `11` (vt2013 button) are
full-body because their exact element is an empty graphic wrapper whose old event asset no
longer loads; `emphasis` is rare; the Twitter embed renders only as a share button (no rich card)._
