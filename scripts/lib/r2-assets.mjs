import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { opendir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import mime from 'mime-types';

export const CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const DEFAULT_MANIFEST_PATH = 'r2-manifest.json';
export const DEFAULT_PUBLIC_MANIFEST_PATH = 'r2-public-manifest.json';
export const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.flac',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.m4v',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.pdf',
  '.png',
  '.svg',
  '.wav',
  '.webm',
  '.webp',
]);

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

export async function buildManifest(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const logicalPaths = await scanMediaFiles(root);
  const files = {};

  for (const logicalPath of logicalPaths) {
    const absolutePath = path.join(root, ...logicalPath.split('/'));
    const hashes = await hashFile(absolutePath);
    files[logicalPath] = {
      key: objectKey(hashes.sha256),
      sha256: hashes.sha256,
      contentMd5: hashes.contentMd5,
      bytes: hashes.bytes,
      contentType: contentTypeFor(logicalPath),
    };
  }

  return {
    version: 1,
    hashAlgorithm: 'sha256',
    keyPrefix: 'blobs/sha256',
    files,
  };
}

export async function writeManifest(manifestPath, manifest) {
  await writeFile(manifestPath, serializeManifest(manifest));
}

export async function assertManifestCurrent(manifest, rootDirectory) {
  const current = await buildManifest(rootDirectory);
  if (serializeManifest(current) !== serializeManifest(manifest)) {
    throw new Error('asset manifest is stale; run the manifest command before continuing');
  }
  return current;
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function readManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest);
  return manifest;
}

export function summarizeManifest(manifest) {
  const entries = Object.entries(manifest.files);
  const unique = uniqueBlobs(manifest);
  const logicalBytes = entries.reduce((sum, [, entry]) => sum + entry.bytes, 0);
  const uniqueBytes = unique.reduce((sum, blob) => sum + blob.bytes, 0);
  return {
    logicalFiles: entries.length,
    uniqueBlobs: unique.length,
    duplicateFiles: entries.length - unique.length,
    logicalBytes,
    uniqueBytes,
    savedBytes: logicalBytes - uniqueBytes,
  };
}

export function buildPublicManifest(manifest, publicBaseUrl) {
  const baseUrl = normalizePublicBaseUrl(publicBaseUrl);
  const assets = {};
  const entries = Object.entries(manifest.files).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [logicalPath, entry] of entries) {
    assets[logicalPath] = {
      uri: `${baseUrl}/${entry.key}`,
      sha256: entry.sha256,
      bytes: entry.bytes,
      mediaType: entry.contentType,
    };
  }
  return assets;
}

export async function syncManifest({
  client,
  bucket,
  manifest,
  rootDirectory,
  concurrency = 16,
  dryRun = false,
}) {
  const blobs = uniqueBlobs(manifest);
  if (dryRun) {
    return {
      ...summarizeManifest(manifest),
      uploaded: 0,
      existing: 0,
      wouldCheck: blobs.length,
      wouldUploadAtMost: blobs.length,
    };
  }

  const root = path.resolve(rootDirectory);
  const results = await mapConcurrent(blobs, concurrency, async (blob) => {
    const head = await headOrNull(client, bucket, blob.key);
    if (head) {
      assertRemoteMatches(blob, head);
      return 'existing';
    }

    const absolutePath = path.join(root, ...blob.sourcePath.split('/'));
    await assertLocalMatches(blob, absolutePath);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: blob.key,
          Body: createReadStream(absolutePath),
          ContentLength: blob.bytes,
          ContentMD5: blob.contentMd5,
          ContentType: blob.contentType,
          CacheControl: CACHE_CONTROL,
          Metadata: { sha256: blob.sha256 },
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      const raced = await headOrNull(client, bucket, blob.key);
      if (!raced) throw error;
      assertRemoteMatches(blob, raced);
      return 'existing';
    }
    const uploaded = await headOrNull(client, bucket, blob.key);
    if (!uploaded) throw new Error(`uploaded object is not readable: ${blob.key}`);
    assertRemoteMatches(blob, uploaded);
    return 'uploaded';
  });

  return {
    ...summarizeManifest(manifest),
    uploaded: results.filter((result) => result === 'uploaded').length,
    existing: results.filter((result) => result === 'existing').length,
  };
}

export async function verifyManifest({ client, bucket, manifest, concurrency = 16 }) {
  const blobs = uniqueBlobs(manifest);
  await mapConcurrent(blobs, concurrency, async (blob) => {
    const head = await headOrNull(client, bucket, blob.key);
    if (!head) throw new Error(`missing object: ${blob.key}`);
    assertRemoteMatches(blob, head);
    const remote = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: blob.key }),
    );
    const digest = await sha256Body(remote.Body);
    if (digest !== blob.sha256) {
      throw new Error(
        `remote content mismatch for ${blob.key}: expected ${blob.sha256}, found ${digest}`,
      );
    }
  });
  return { verified: blobs.length };
}

export function uniqueBlobs(manifest) {
  const byKey = new Map();
  for (const [sourcePath, entry] of Object.entries(manifest.files)) {
    const existing = byKey.get(entry.key);
    if (existing) {
      if (
        existing.sha256 !== entry.sha256 ||
        existing.contentMd5 !== entry.contentMd5 ||
        existing.bytes !== entry.bytes ||
        existing.contentType !== entry.contentType
      ) {
        throw new Error(`manifest has conflicting metadata for ${entry.key}`);
      }
      continue;
    }
    byKey.set(entry.key, { ...entry, sourcePath });
  }
  return [...byKey.values()];
}

export function objectKey(sha256) {
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export function contentTypeFor(logicalPath) {
  return mime.lookup(logicalPath) || 'application/octet-stream';
}

export function createR2ClientConfig(accountId, credentials) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (
    !credentials ||
    typeof credentials.accessKeyId !== 'string' ||
    !credentials.accessKeyId ||
    typeof credentials.secretAccessKey !== 'string' ||
    !credentials.secretAccessKey
  ) {
    throw new Error('R2 credentials are required');
  }
  return {
    region: 'auto',
    endpoint: `https://${normalizedAccountId}.r2.cloudflarestorage.com`,
    credentials,
  };
}

export function validateDeploymentConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('R2 config must be an object');
  }
  const bucket = normalizeBucket(config.bucket);
  const normalized = {
    ...config,
    accountId: normalizeAccountId(config.accountId),
    bucket,
    publicBaseUrl: normalizePublicBaseUrl(config.publicBaseUrl),
  };
  if (
    config.manifestPath !== undefined &&
    (typeof config.manifestPath !== 'string' || !config.manifestPath.trim())
  ) {
    throw new Error('manifestPath must be a non-empty string');
  }
  if (
    config.concurrency !== undefined &&
    (!Number.isInteger(config.concurrency) || config.concurrency < 1)
  ) {
    throw new Error('concurrency must be a positive integer');
  }
  return normalized;
}

function normalizeAccountId(accountId) {
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error('accountId must be a 32-character hexadecimal Cloudflare account ID');
  }
  return accountId.toLowerCase();
}

function normalizeBucket(bucket) {
  if (
    typeof bucket !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(bucket)
  ) {
    throw new Error(
      'bucket must be 3-63 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen',
    );
  }
  return bucket;
}

function normalizePublicBaseUrl(publicBaseUrl) {
  if (typeof publicBaseUrl !== 'string') {
    throw new Error('publicBaseUrl is required');
  }
  let parsed;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    throw new Error('publicBaseUrl must be a valid HTTPS origin');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'publicBaseUrl must be an HTTPS origin without credentials, port, path, query, or fragment',
    );
  }
  return parsed.origin;
}

async function scanMediaFiles(root) {
  const output = [];

  async function visit(directory, relativeDirectory) {
    const entries = [];
    const handle = await opendir(directory);
    for await (const entry of handle) entries.push(entry);
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (
        entry.isFile() &&
        MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        output.push(relativePath);
      }
    }
  }

  await visit(root, '');
  return output;
}

async function hashFile(filePath) {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sha256.update(chunk);
    md5.update(chunk);
    bytes += chunk.length;
  }
  return {
    sha256: sha256.digest('hex'),
    contentMd5: md5.digest('base64'),
    bytes,
  };
}

async function sha256Body(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new Error('remote object body is not readable');
  }
  const hash = createHash('sha256');
  for await (const chunk of body) hash.update(chunk);
  return hash.digest('hex');
}

async function assertLocalMatches(blob, filePath) {
  const hashes = await hashFile(filePath);
  const mismatches = [];
  if (hashes.sha256 !== blob.sha256) mismatches.push(`sha256 ${hashes.sha256}`);
  if (hashes.contentMd5 !== blob.contentMd5) {
    mismatches.push(`Content-MD5 ${hashes.contentMd5}`);
  }
  if (hashes.bytes !== blob.bytes) mismatches.push(`size ${hashes.bytes}`);
  if (mismatches.length) {
    throw new Error(
      `local file changed after manifest generation (${blob.sourcePath}): ${mismatches.join(', ')}`,
    );
  }
}

async function headOrNull(client, bucket, key) {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (
      error?.name === 'NotFound' ||
      error?.name === 'NoSuchKey' ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw error;
  }
}

function isPreconditionFailed(error) {
  return (
    error?.name === 'PreconditionFailed' ||
    error?.$metadata?.httpStatusCode === 412
  );
}

function assertRemoteMatches(blob, head) {
  const mismatches = [];
  if (head.ContentLength !== blob.bytes) {
    mismatches.push(`size expected ${blob.bytes}, found ${head.ContentLength ?? 'missing'}`);
  }
  if (head.ContentType !== blob.contentType) {
    mismatches.push(
      `Content-Type expected ${blob.contentType}, found ${head.ContentType ?? 'missing'}`,
    );
  }
  if (head.CacheControl !== CACHE_CONTROL) {
    mismatches.push(
      `Cache-Control expected "${CACHE_CONTROL}", found "${head.CacheControl ?? 'missing'}"`,
    );
  }
  if (head.Metadata?.sha256 !== blob.sha256) {
    mismatches.push(
      `sha256 metadata expected ${blob.sha256}, found ${head.Metadata?.sha256 ?? 'missing'}`,
    );
  }
  if (mismatches.length) {
    throw new Error(
      `immutable object metadata mismatch for ${blob.key}: ${mismatches.join('; ')}`,
    );
  }
}

async function mapConcurrent(items, concurrency, operation) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await operation(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function validateManifest(manifest) {
  if (
    manifest?.version !== 1 ||
    manifest?.hashAlgorithm !== 'sha256' ||
    manifest?.keyPrefix !== 'blobs/sha256' ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  ) {
    throw new Error('invalid R2 asset manifest');
  }
  for (const [logicalPath, entry] of Object.entries(manifest.files)) {
    if (
      logicalPath.startsWith('/') ||
      logicalPath.includes('\\') ||
      logicalPath.split('/').includes('..')
    ) {
      throw new Error(`invalid logical path in manifest: ${logicalPath}`);
    }
    if (
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !/^[A-Za-z0-9+/]{22}==$/.test(entry.contentMd5) ||
      entry.key !== objectKey(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.contentType !== 'string'
    ) {
      throw new Error(`invalid manifest entry: ${logicalPath}`);
    }
  }
}
