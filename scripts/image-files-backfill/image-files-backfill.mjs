#!/usr/bin/env node
/**
 * One-off image_files backfill over the production R2 bucket (DQX-49). See
 * README.md for what it does and how to run it. Deliberately self-contained
 * (duplicates the tiny key helpers from @hiroba/shared and the magic-byte
 * sniff from apps/workflow) so it lives outside the pnpm workspace and can be
 * deleted wholesale once the archive is converted.
 *
 * Storage I/O: R2 via the S3 API. Database I/O: `wrangler d1 execute --remote`
 * (JSON reads, batched SQL-file writes), checkpointed per chunk so an
 * interrupted run resumes from D1's recorded outcomes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';

// ---------------------------------------------------------------- config --

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Max renders to process this run (Infinity = the whole archive). A malformed
 * `--limit` exits rather than defaulting: `Number(undefined)` is NaN, and
 * `slice(0, NaN)` silently processes NOTHING — an easy "it ran clean" lie on a
 * job whose whole point is the count it converted.
 */
const LIMIT = (() => {
  const at = process.argv.indexOf('--limit');
  if (at === -1) return Infinity;
  const value = Number(process.argv[at + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(
      `--limit needs a positive integer (got '${process.argv[at + 1] ?? ''}')`,
    );
    process.exit(1);
  }
  return value;
})();

const BUCKET = process.env.R2_BUCKET ?? 'galapa--images';
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  console.error(
    'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (see README.md)',
  );
  process.exit(1);
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WRANGLER_CONFIG = join(REPO_ROOT, 'apps/workflow/wrangler.toml');

/** Mirrors LOCALIZED_IMAGE_CACHE_CONTROL / the mirror step's policy. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Same tradeoff as the pipeline's Images-binding default. */
const AVIF_QUALITY = 60;
/** Concurrent S3+sharp pipelines. */
const CONCURRENCY = 8;
/** Statements per `wrangler d1 execute --file` checkpoint. */
const SQL_BATCH = 60;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

// ------------------------------------------------- helpers (duplicated) --

// Kept in sync by hand with @hiroba/shared (constants.ts) — this script is
// standalone on purpose and dies once the archive is converted.
const EXTENSION_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};
/** Throws on an unknown type, like the shared helper — a lying or
 *  `undefined`-suffixed key is worse than a loud stop. Unreachable today
 *  (every caller passes a sniffed or hardcoded known type), which is exactly
 *  when an invariant is cheapest to keep. */
function extensionForType(contentType) {
  const ext = EXTENSION_BY_TYPE[contentType];
  if (!ext) throw new Error(`no canonical extension for '${contentType}'`);
  return ext;
}
function keyWithExtension(key, contentType) {
  const ext = extensionForType(contentType);
  const slash = key.lastIndexOf('/');
  const dot = key.lastIndexOf('.');
  if (dot <= slash + 1) return `${key}${ext}`;
  if (key.slice(dot).toLowerCase() === ext) return key;
  return `${key.slice(0, dot)}${ext}`;
}

const avifVariantKey = (key) => `${key}.avif`;
const fitVariantKey = (key, size, contentType) =>
  `${key}.fit${size.width}x${size.height}${extensionForType(contentType)}`;

/** A thrown value as a log line. `err.message` alone reads `undefined` for a
 *  thrown string and throws outright for a thrown null, and one unloggable
 *  oddity shouldn't take the archive sweep down with it. */
const reason = (err) =>
  err instanceof Error ? err.message : String(err ?? 'unknown');

/** Magic-byte sniff — mirrors apps/workflow/src/image-edit.ts. */
function sniffMimeType(b) {
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return 'image/gif';
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  )
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return 'image/jpeg';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'image/webp';
  return null;
}

/** Formats worth re-encoding; GIF excluded (animation — a still AVIF eats it). */
const DERIVABLE_SOURCE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/** Mirrors RENDITION_SCALES in apps/workflow/src/image-files.ts — 1x is the
 *  primary itself, so only the smaller rungs are listed. */
const RENDITION_SCALES = [0.5, 0.25];

/** sharp's encoder per output type, matching the pipeline's Images formats. */
function encodeAs(pipeline, format) {
  if (format === 'image/avif') return pipeline.avif({ quality: AVIF_QUALITY });
  if (format === 'image/png') return pipeline.png();
  if (format === 'image/webp') return pipeline.webp();
  return pipeline.jpeg();
}

/**
 * Re-encode `bytes` to `format`, optionally scaled to fit inside `size`.
 * Null when the source isn't re-encodable or the output isn't smaller than
 * the primary — the pipeline's rules, so a backfilled render ends up with the
 * same file set a freshly written one would have.
 */
async function encode(bytes, format, size) {
  const mime = sniffMimeType(bytes);
  if (!mime || !DERIVABLE_SOURCE_TYPES.has(mime)) return null;
  try {
    let pipeline = sharp(bytes);
    if (size) {
      pipeline = pipeline.resize({
        width: size.width,
        height: size.height,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const out = await encodeAs(pipeline, format).toBuffer();
    // A file that isn't smaller is pure storage cost — skip (typical for tiny
    // icons, where the AVIF container dominates). Same rule as the pipeline.
    return out.byteLength < bytes.byteLength ? out : null;
  } catch (err) {
    console.warn(`  encode failed (${format}): ${reason(err)}`);
    return null;
  }
}

/** The ladder for a raster of `dims` size — mirrors `ladder()` in
 *  apps/workflow/src/image-files.ts, including the dedup that keeps two rungs
 *  of a small raster from rounding onto one key. */
function ladder(dims) {
  if (dims.width == null || dims.height == null) return [];
  const seen = new Set();
  const rungs = [];
  for (const scale of RENDITION_SCALES) {
    const width = Math.round(dims.width * scale);
    const height = Math.round(dims.height * scale);
    if (width < 1 || height < 1) continue;
    if (width >= dims.width && height >= dims.height) continue;
    const box = `${width}x${height}`;
    if (seen.has(box)) continue;
    seen.add(box);
    rungs.push({ width, height });
  }
  return rungs;
}

/** Pixel dimensions via sharp, or nulls (formats sharp can't decode). */
async function measure(bytes) {
  try {
    const meta = await sharp(bytes).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

const sq = (s) => s.replace(/'/g, "''");
const num = (n) => (n == null ? 'NULL' : String(n));
/** A nullable TEXT literal — `image_files.mime` is NULL for "we don't know",
 *  never a sentinel string, so unknown must not arrive quoted. */
const txt = (s) => (s == null ? 'NULL' : `'${sq(s)}'`);

/** Run `fn` over every item, at most `limit` at a time. Side-effect only —
 *  each conversion tallies its own outcome and queues its own SQL, so nothing
 *  is collected and the whole archive never sits in memory at once. */
async function eachLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

// ------------------------------------------------------------------- d1 --

function d1Query(sql) {
  const out = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--remote',
      '--json',
      '--config',
      WRANGLER_CONFIG,
      '--command',
      sql,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  // wrangler --json emits a JSON array of result sets.
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

const tmp = mkdtempSync(join(tmpdir(), 'image-files-backfill-'));
let sqlFileCounter = 0;
let pendingSql = [];

function queueSql(stmt) {
  pendingSql.push(stmt);
}

function flushSql(force = false) {
  if (pendingSql.length === 0) return;
  if (!force && pendingSql.length < SQL_BATCH) return;
  const batch = pendingSql;
  pendingSql = [];
  if (DRY_RUN) {
    console.log(`[dry-run] would apply ${batch.length} D1 statement(s)`);
    return;
  }
  const file = join(tmp, `batch-${sqlFileCounter++}.sql`);
  writeFileSync(file, batch.join('\n') + '\n');
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--remote',
      '--config',
      WRANGLER_CONFIG,
      '--file',
      file,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  console.log(`checkpointed ${batch.length} D1 statement(s)`);
}

// ------------------------------------------------------------------- s3 --

async function getObject(key) {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    return {
      bytes: Buffer.from(await res.Body.transformToByteArray()),
      contentType: res.ContentType,
    };
  } catch (err) {
    // Optional-chained: a null throwable must rethrow as itself, not as a
    // TypeError from this very line.
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404)
      return null;
    throw err;
  }
}

async function putObject(key, body, contentType) {
  if (DRY_RUN) return;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: CACHE_CONTROL,
    }),
  );
}

/** Server-side copy with replaced metadata (re-key / content-type fix). */
async function copyObject(fromKey, toKey, contentType) {
  if (DRY_RUN) return;
  await s3.send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      // CopySource is URL-path style and must be encoded per segment.
      CopySource: `${BUCKET}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
      Key: toKey,
      MetadataDirective: 'REPLACE',
      ContentType: contentType,
      CacheControl: CACHE_CONTROL,
    }),
  );
}

// -------------------------------------------------------------- process --

/**
 * Every render whose file set is still just its primary: the 0023 migration's
 * seeds (which also carry NULL metadata) and anything written between DQX-45
 * and DQX-49. Ordered by id so a `--limit` slice is stable across runs.
 */
function pendingRenders() {
  // The limit rides in the SQL, not a JS slice: --limit 25 must actually
  // query 25 rows, or a large archive still ships its whole pending list
  // through wrangler's JSON output just to sample it.
  const limit = Number.isFinite(LIMIT) ? ` LIMIT ${LIMIT}` : '';
  return d1Query(
    `SELECT i.id AS imageId, i.language AS language, f.key AS key
       FROM images i
       JOIN image_files f ON f.image_id = i.id AND f.is_primary = 1
      WHERE NOT EXISTS (
              SELECT 1 FROM image_files d
               WHERE d.image_id = i.id AND d.is_primary = 0)
      ORDER BY i.id${limit}`,
  );
}

/** UPDATE the primary row's measured metadata (seeds land with NULLs). */
function primaryUpdateSql(key, { mime, width, height, size }) {
  return (
    `UPDATE image_files SET mime=${txt(mime)}, width=${num(width)},` +
    ` height=${num(height)}, bytes=${num(size)} WHERE key='${sq(key)}';`
  );
}

/** INSERT OR REPLACE one derived (non-primary) file row. */
function derivedRowSql({ key, imageId, mime, width, height, size }, now) {
  return (
    `INSERT OR REPLACE INTO image_files (key, image_id, is_primary, mime, width, height, bytes, created_at) ` +
    `VALUES ('${sq(key)}','${sq(imageId)}',0,${txt(mime)},${num(width)},${num(height)},${num(size)},${now});`
  );
}

/**
 * Convert one render: correct its stored bytes' identity (content type, and
 * for localized renders the key's extension), fill in the primary row's
 * measurements, and encode the AVIF beside it.
 *
 * Returns the outcome tally keys to bump.
 */
async function convert(row, now) {
  const obj = await getObject(row.key);
  // Nothing to convert and nothing to record — collected and printed so a
  // rerun just re-checks these few instead of carrying a tombstone.
  if (!obj) return { missing: true };

  const sniffed = sniffMimeType(obj.bytes);
  // NULL, not a sentinel, when neither the bytes nor the stored header say what
  // this is — same as the pipeline's writers. An "unknown" that reads as a
  // format would be a lie the serving side has to keep re-detecting.
  const mime = sniffed ?? obj.contentType ?? null;
  const outcome = {};

  let key = row.key;
  if (sniffed && row.language !== null) {
    // Localized renders live at versioned keys we mint, so a lying extension
    // (old renders were PNGs at the source's .jpg/.gif key) can be corrected:
    // the key is unique per render, so the swap can't collide. The old object
    // stays as an orphan and the follow-up zone purge retires the HTML that
    // referenced it. Mirrored originals keep their upstream path verbatim —
    // that path IS their identity — so only their content-type is fixed.
    const corrected = keyWithExtension(row.key, sniffed);
    if (corrected !== row.key) {
      await copyObject(row.key, corrected, sniffed);
      queueSql(
        `UPDATE image_files SET key='${sq(corrected)}' WHERE key='${sq(row.key)}';`,
      );
      key = corrected;
      outcome.rekeyed = true;
    }
  }
  if (sniffed && sniffed !== obj.contentType && key === row.key) {
    // The mirror step used to trust the upstream header; fix the stored
    // Content-Type in place (a re-keyed object already got it on the copy).
    await copyObject(row.key, row.key, sniffed);
    outcome.retyped = true;
  }

  const dims = await measure(obj.bytes);
  // Cheap and unconditional: seeds carry NULLs, and a row written before a
  // re-key now names the corrected key.
  queueSql(
    primaryUpdateSql(key, { mime, ...dims, size: obj.bytes.byteLength }),
  );

  /** Encode + store + record one derived file; no-op when it's not worth it. */
  let derived = 0;
  const add = async (format, size) => {
    const out = await encode(obj.bytes, format, size);
    if (!out) return;
    const derivedKey = size
      ? fitVariantKey(key, size, format)
      : avifVariantKey(key);
    // A failed put is one fewer file, never a dead sweep — same rule as the
    // pipeline's deriveFiles. The row is only queued once the object stored,
    // so D1 never learns about an object that isn't there.
    try {
      await putObject(derivedKey, out, format);
    } catch (err) {
      console.warn(`  store failed for ${derivedKey}: ${reason(err)}`);
      return;
    }
    // Renditions are re-measured rather than computed — sharp owns the
    // fit-inside rounding, and a row's dimensions must match its bytes.
    const outDims = size ? await measure(out) : dims;
    queueSql(
      derivedRowSql(
        {
          key: derivedKey,
          imageId: row.imageId,
          mime: format,
          ...outDims,
          size: out.byteLength,
        },
        now,
      ),
    );
    derived++;
  };

  // The same ladder the pipeline writes: full-size AVIF, then each smaller
  // rung in the source format and AVIF.
  await add('image/avif');
  if (sniffed) {
    for (const size of ladder(dims)) {
      await add(sniffed, size);
      await add('image/avif', size);
    }
  }
  return { ...outcome, [derived > 0 ? 'encoded' : 'primaryOnly']: true };
}

async function backfill() {
  const rows = pendingRenders();
  console.log(`${rows.length} render(s) pending`);

  const counts = {
    encoded: 0,
    primaryOnly: 0,
    missing: 0,
    rekeyed: 0,
    retyped: 0,
  };
  const missingKeys = [];
  let done = 0;
  await eachLimit(rows, CONCURRENCY, async (row) => {
    const now = Date.now();
    const outcome = await convert(row, now);
    for (const [name, hit] of Object.entries(outcome)) if (hit) counts[name]++;
    if (outcome.missing) missingKeys.push(row.key);
    if (++done % 25 === 0) console.log(`  ${done}/${rows.length}`);
    flushSql();
  });
  flushSql(true);
  return { counts, missingKeys };
}

// ----------------------------------------------------------------- main --

console.log(
  `image_files backfill — bucket ${BUCKET}${DRY_RUN ? ' [DRY RUN]' : ''}${Number.isFinite(LIMIT) ? ` [limit ${LIMIT}]` : ''}`,
);
const { counts, missingKeys } = await backfill();
console.log('\nDone.', counts);
if (missingKeys.length) {
  console.log('\nrenders whose primary object is missing from the bucket:');
  for (const key of missingKeys) console.log(`  ${key}`);
}
console.log(
  '\nPurge the zone from the Cloudflare dashboard: cached HTML carries no' +
    ' <picture> sources or dimensions (and none of the re-keyed URLs).',
);
