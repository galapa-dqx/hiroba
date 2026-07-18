# image_sources backfill (one-off)

Retroactively brings the existing R2 archive in line with what the pipeline
now does at write time (see `apps/workflow/src/image-sources.ts`): every
render measured and recorded as `image_sources` rows (MIME + width/height per
variant, the metadata the web `<picture>` tag reads), with an AVIF variant
encoded beside it where one is worth having.

1. **Mirrored originals** (mirror done, no `image_sources` primary row):
   sniffs the real content type from magic bytes (fixing the stored
   `Content-Type` where the upstream CDN header lied), measures, encodes an
   AVIF variant with sharp at `<key>.avif`, and records the group's rows.
2. **Localized renders** (`url` translation rows with no primary row):
   re-keys objects whose URL extension lies about their bytes (old renders
   were PNGs at `.jpg` keys) by copying to the corrected key and updating the
   `url` row, then measures/encodes/records under the corrected key. Old
   objects are left behind as orphans, same as any regeneration.

AVIF is skipped (the group simply has only its primary row) for GIFs
(animation), unknown formats, and variants that come out no smaller.

**After running, purge the zone from the Cloudflare dashboard** — cached HTML
still references the pre-re-key localized URLs and carries no `<picture>`
sources or dimensions.

## Setup

```sh
cd scripts/avif-backfill
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
node avif-backfill.mjs --dry-run            # report only, no writes anywhere
node avif-backfill.mjs --limit 25           # smoke test on a small slice
node avif-backfill.mjs                      # the real thing
```

Idempotent: the work predicate is "no `image_sources` primary row yet", and
rows land in checkpointed batches, so a rerun resumes where it left off.
Delete this directory once the archive is converted.
