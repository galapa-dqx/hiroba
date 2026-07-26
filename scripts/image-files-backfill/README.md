# image_files backfill (one-off, DQX-49)

Retroactively brings the existing R2 archive in line with what the pipeline now
does at write time (see `apps/workflow/src/image-files.ts`): every render's
primary file measured, and an AVIF encoded beside it where one is worth having,
so the web can emit `<picture>` sources and intrinsic `width`/`height`.

Work predicate: **renders whose only `image_files` row is the primary** — the
`0023_image_model.sql` seeds (which also carry NULL `mime`/`width`/`height`/
`bytes`) plus anything written between DQX-45 and DQX-49. For each one it:

1. **Measures** the stored bytes and fills in the primary row's metadata,
   sniffing the real content type from magic bytes.
2. **Encodes** an AVIF with sharp at `<key>.avif` and records it as a
   non-primary `image_files` row.
3. **Re-keys** localized renders whose key extension lies about their bytes
   (old renders were PNGs at the source's `.jpg` key) by copying to the
   corrected key and updating the row. Versioned l10n keys are unique per
   render, so the swap can't collide; the old object is left behind as an
   orphan, same as any regeneration.
4. **Fixes the stored `Content-Type`** of mirrored originals whose upstream
   header lied. Their key is their identity, so it is never rewritten.

AVIF is skipped (the render keeps its primary alone, and serves as a bare
`<img>`) for GIFs — animation — for unknown formats, and for outputs that come
out no smaller than the primary.

**After running, purge the zone from the Cloudflare dashboard**: cached HTML
carries no `<picture>` sources or dimensions, and none of the re-keyed URLs.

## Setup

```sh
cd scripts/image-files-backfill
npm install            # standalone on purpose; not part of the pnpm workspace
```

Environment (an R2 API token with read/write on the bucket):

```sh
export R2_ACCOUNT_ID=…          # Cloudflare account id
export R2_ACCESS_KEY_ID=…
export R2_SECRET_ACCESS_KEY=…
# optional: export R2_BUCKET=galapa--images
```

D1 reads/writes go through `wrangler d1 execute --remote` (uses your wrangler
login; config `apps/workflow/wrangler.toml`).

## Run

```sh
node image-files-backfill.mjs --dry-run
```

```sh
node image-files-backfill.mjs --limit 25
```

```sh
node image-files-backfill.mjs
```

Rows land in checkpointed batches, so an interrupted run resumes where it left
off: every render that got an AVIF drops out of the predicate. Renders whose
AVIF was legitimately skipped (a GIF, a tiny icon) have no derived row to show
for it, so a rerun re-downloads and re-checks those few — harmless, and they
are re-measured to the same values.

Delete this directory once the archive is converted.
