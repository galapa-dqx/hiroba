#!/usr/bin/env node
/**
 * One-off image_sources + extension backfill over the production R2 bucket.
 * See README.md for what it does and how to run it. Deliberately
 * self-contained (duplicates the tiny key helpers from @hiroba/shared and the
 * magic-byte sniff from apps/workflow) so it lives outside the workspace and
 * can be deleted wholesale once the archive is converted.
 *
 * Storage I/O: R2 via the S3 API. Database I/O: `wrangler d1 execute --remote`
 * (JSON reads, batched SQL-file writes), checkpointed per chunk so an
 * interrupted run resumes from D1's recorded outcomes (work predicate:
 * renders with no image_sources primary row yet).
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
const LIMIT_ARG = process.argv.indexOf('--limit');
/** Max rows per population to process (Infinity = whole archive). */
const LIMIT = LIMIT_ARG !== -1 ? Number(process.argv[LIMIT_ARG + 1]) : Infinity;

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
function keyWithExtension(key, contentType) {
  const ext = EXTENSION_BY_TYPE[contentType];
  if (!ext) return key;
  const slash = key.lastIndexOf('/');
  const dot = key.lastIndexOf('.');
  if (dot <= slash + 1) return `${key}${ext}`;
  if (key.slice(dot).toLowerCase() === ext) return key;
  return `${key.slice(0, dot)}${ext}`;
}

const avifVariantKey = (key) => `${key}.avif`;

/** Magic-byte sniff — mirrors apps/workflow/src/image-edit.ts. */
function sniffMimeType(b) {
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return 'image/gif';
  if (
    b.length >= 4 &&
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

/** Formats worth re-encoding; GIF excluded (animation — a still AVIF would eat it). */
const AVIF_SOURCE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

async function encodeAvif(bytes) {
  const mime = sniffMimeType(bytes);
  if (!mime || !AVIF_SOURCE_TYPES.has(mime)) return null;
  try {
    const avif = await sharp(bytes).avif({ quality: AVIF_QUALITY }).toBuffer();
    // A variant that isn't smaller is pure storage cost — skip (typical for
    // tiny icons where AVIF headers dominate). Same rule as the pipeline.
    return avif.byteLength < bytes.byteLength ? avif : null;
  } catch (err) {
    console.warn(`  encode failed: ${err.message}`);
    return null;
  }
}

/** Pixel dimensions via sharp, or nulls (e.g. formats sharp can't decode). */
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

/** INSERT OR REPLACE one image_sources row (complete-at-birth semantics). */
function sourceRowSql({ key, groupKey, mime, width, height, bytes }, now) {
  return (
    `INSERT OR REPLACE INTO image_sources (key, group_key, mime, width, height, bytes, created_at) ` +
    `VALUES ('${sq(key)}','${sq(groupKey)}','${sq(mime)}',${num(width)},${num(height)},${num(bytes)},${now});`
  );
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]);
      }
    }),
  );
  return results;
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

const tmp = mkdtempSync(join(tmpdir(), 'avif-backfill-'));
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
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)
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
 * Measure + encode one render and queue its complete image_sources row set
 * under `groupKey`. Returns true when an AVIF variant was written.
 */
async function registerRender(groupKey, bytes, mime, now) {
  const dims = await measure(bytes);
  queueSql(
    sourceRowSql(
      { key: groupKey, groupKey, mime, ...dims, bytes: bytes.byteLength },
      now,
    ),
  );
  const avif = await encodeAvif(bytes);
  if (!avif) return false;
  const variant = avifVariantKey(groupKey);
  await putObject(variant, avif, 'image/avif');
  queueSql(
    sourceRowSql(
      {
        key: variant,
        groupKey,
        mime: 'image/avif',
        ...dims,
        bytes: avif.byteLength,
      },
      now,
    ),
  );
  return true;
}

async function backfillOriginals() {
  console.log('\n=== mirrored originals ===');
  const rows = d1Query(
    `SELECT id, key FROM images
      WHERE mirror_state='done'
        AND NOT EXISTS (SELECT 1 FROM image_sources s WHERE s.key = images.key)
      ORDER BY id`,
  ).slice(0, LIMIT);
  console.log(`${rows.length} pending`);

  const counts = { encoded: 0, primaryOnly: 0, missing: 0, retyped: 0 };
  let done = 0;
  await mapLimit(rows, CONCURRENCY, async (row) => {
    const now = Date.now();
    const obj = await getObject(row.key);
    if (!obj) {
      // mirror says done but the object is gone — flip the state back so the
      // predicate excludes it and the pipeline's head-check re-mirrors it on
      // the article's next run.
      counts.missing++;
      queueSql(
        `UPDATE images SET mirror_state='failed', updated_at=${now} WHERE id=${row.id};`,
      );
      return;
    }
    const sniffed = sniffMimeType(obj.bytes);
    if (sniffed && sniffed !== obj.contentType) {
      // The mirror step used to trust the upstream header; fix the stored
      // content-type in place (key unchanged — it IS the image's identity).
      await copyObject(row.key, row.key, sniffed);
      counts.retyped++;
    }
    const mime = sniffed ?? obj.contentType ?? 'application/octet-stream';
    const gotAvif = await registerRender(row.key, obj.bytes, mime, now);
    counts[gotAvif ? 'encoded' : 'primaryOnly']++;
    if (++done % 25 === 0) console.log(`  ${done}/${rows.length}`);
    flushSql();
  });
  flushSql(true);
  console.log(`originals:`, counts);
  return counts;
}

async function backfillLocalized() {
  console.log('\n=== localized renders ===');
  const rows = d1Query(
    `SELECT t.item_id AS itemId, t.language, t.value
       FROM translations t
      WHERE t.item_type='image' AND t.field='url' AND t.state='done' AND t.value IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM image_sources s WHERE s.key = t.value)
      ORDER BY CAST(t.item_id AS INTEGER), t.language`,
  ).slice(0, LIMIT);
  console.log(`${rows.length} pending`);

  const counts = { encoded: 0, primaryOnly: 0, missing: 0, rekeyed: 0 };
  const missingKeys = [];
  let done = 0;
  await mapLimit(rows, CONCURRENCY, async (row) => {
    const now = Date.now();
    const obj = await getObject(row.value);
    if (!obj) {
      // Nothing to register and nothing to mark — collected and printed so a
      // rerun just re-checks these few instead of carrying a tombstone.
      counts.missing++;
      missingKeys.push(row.value);
      return;
    }
    const sniffed = sniffMimeType(obj.bytes);
    const mime = sniffed ?? obj.contentType ?? 'application/octet-stream';

    // Re-key renders whose URL extension lies about the bytes (old renders
    // were PNGs at the source's .jpg/.gif key). Versioned keys are unique per
    // render, so the swap can't collide; the old object stays as an orphan
    // and the follow-up zone purge retires the HTML that referenced it.
    let servedKey = row.value;
    if (sniffed) {
      const corrected = keyWithExtension(row.value, sniffed);
      if (corrected !== row.value) {
        await copyObject(row.value, corrected, sniffed);
        queueSql(
          `UPDATE translations SET value='${sq(corrected)}', updated_at=${now}
            WHERE item_type='image' AND item_id='${sq(row.itemId)}' AND language='${sq(row.language)}' AND field='url';`,
        );
        servedKey = corrected;
        counts.rekeyed++;
      }
    }

    const gotAvif = await registerRender(servedKey, obj.bytes, mime, now);
    counts[gotAvif ? 'encoded' : 'primaryOnly']++;
    if (++done % 25 === 0) console.log(`  ${done}/${rows.length}`);
    flushSql();
  });
  flushSql(true);
  console.log(`localized:`, counts);
  if (missingKeys.length) {
    console.log('localized renders missing from the bucket:');
    for (const key of missingKeys) console.log(`  ${key}`);
  }
  return counts;
}

// ----------------------------------------------------------------- main --

console.log(
  `image_sources backfill — bucket ${BUCKET}${DRY_RUN ? ' [DRY RUN]' : ''}${Number.isFinite(LIMIT) ? ` [limit ${LIMIT}]` : ''}`,
);
const originals = await backfillOriginals();
const localized = await backfillLocalized();
console.log('\nDone.', { originals, localized });
if (localized.rekeyed > 0) {
  console.log(
    `\n${localized.rekeyed} localized render(s) were re-keyed — purge the zone from the Cloudflare dashboard so cached HTML picks up the new URLs.`,
  );
}
