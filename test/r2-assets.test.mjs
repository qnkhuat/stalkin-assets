import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  CACHE_CONTROL,
  assertManifestCurrent,
  buildManifest,
  buildPublicManifest,
  createR2ClientConfig,
  objectKey,
  serializeManifest,
  summarizeManifest,
  syncManifest,
  validateDeploymentConfig,
  verifyManifest,
} from '../scripts/lib/r2-assets.mjs';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve('scripts/r2-assets.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'stalkin-r2-test-'));
  await mkdir(path.join(root, 'case', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  await writeFile(path.join(root, 'case', 'one.webp'), Buffer.from('same-media'));
  await writeFile(path.join(root, 'case', 'nested', 'two.WEBP'), Buffer.from('same-media'));
  await writeFile(path.join(root, 'case', 'three.png'), Buffer.from('different-media'));
  await writeFile(path.join(root, 'case', 'notes.txt'), 'not media');
  await writeFile(path.join(root, 'node_modules', 'ignored', 'package.png'), 'ignored');
  return root;
}

test('manifest is deterministic, path-sorted, MIME-aware, and content-deduplicated', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await buildManifest(root);
  const second = await buildManifest(root);

  assert.equal(serializeManifest(first), serializeManifest(second));
  assert.deepEqual(Object.keys(first.files), [
    'case/nested/two.WEBP',
    'case/one.webp',
    'case/three.png',
  ]);
  assert.equal(first.files['case/one.webp'].contentType, 'image/webp');
  assert.equal(first.files['case/three.png'].contentType, 'image/png');
  assert.equal(
    first.files['case/one.webp'].key,
    objectKey(first.files['case/one.webp'].sha256),
  );
  assert.equal(
    first.files['case/one.webp'].key,
    first.files['case/nested/two.WEBP'].key,
  );
  assert.deepEqual(summarizeManifest(first), {
    logicalFiles: 3,
    uniqueBlobs: 2,
    duplicateFiles: 1,
    logicalBytes: 35,
    uniqueBytes: 25,
    savedBytes: 10,
  });
});

test('dry run is credential-free and makes no client calls', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await buildManifest(root);

  const summary = await syncManifest({
    manifest,
    rootDirectory: root,
    concurrency: 4,
    dryRun: true,
  });

  assert.equal(summary.wouldCheck, 2);
  assert.equal(summary.wouldUploadAtMost, 2);
  assert.equal(summary.uploaded, 0);
});

test('R2 client config derives the official endpoint and auto region from accountId', () => {
  const credentials = { accessKeyId: 'local-id', secretAccessKey: 'local-secret' };
  assert.deepEqual(createR2ClientConfig('0123456789ABCDEF0123456789ABCDEF', credentials), {
    region: 'auto',
    endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    credentials,
  });
});

test('deployment config accepts only a Cloudflare account, valid bucket, and HTTPS origin', () => {
  assert.deepEqual(
    validateDeploymentConfig({
      accountId: '0123456789ABCDEF0123456789ABCDEF',
      bucket: 'stalkie-assets',
      publicBaseUrl: 'https://Assets.Example.com/',
      concurrency: 8,
    }),
    {
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'stalkie-assets',
      publicBaseUrl: 'https://assets.example.com',
      concurrency: 8,
    },
  );
  assert.throws(
    () =>
      validateDeploymentConfig({
        accountId: 'evil.example/path',
        bucket: 'stalkie-assets',
        publicBaseUrl: 'https://assets.example.com',
      }),
    /32-character hexadecimal/,
  );
  assert.throws(
    () =>
      validateDeploymentConfig({
        accountId: '0123456789abcdef0123456789abcdef',
        bucket: 'Bad_Bucket',
        publicBaseUrl: 'https://assets.example.com',
      }),
    /bucket must be/,
  );
  for (const publicBaseUrl of [
    'http://assets.example.com',
    'https://user:password@assets.example.com',
    'https://assets.example.com:8443',
    'https://assets.example.com/path',
    'https://assets.example.com/?query=yes',
  ]) {
    assert.throws(
      () =>
        validateDeploymentConfig({
          accountId: '0123456789abcdef0123456789abcdef',
          bucket: 'stalkie-assets',
          publicBaseUrl,
        }),
      /HTTPS origin/,
    );
  }
});

test('public manifest deterministically maps logical paths to normalized immutable URLs', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await buildManifest(root);

  const first = buildPublicManifest(manifest, 'https://Assets.Example.com/');
  const second = buildPublicManifest(
    { ...manifest, files: Object.fromEntries(Object.entries(manifest.files).reverse()) },
    'https://assets.example.com',
  );

  assert.equal(serializeManifest(first), serializeManifest(second));
  assert.deepEqual(Object.keys(first), Object.keys(manifest.files));
  assert.deepEqual(first['case/one.webp'], {
    uri: `https://assets.example.com/${manifest.files['case/one.webp'].key}`,
    sha256: manifest.files['case/one.webp'].sha256,
    bytes: manifest.files['case/one.webp'].bytes,
    mediaType: 'image/webp',
  });
});

test('export CLI writes an app-ready public map without credentials', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'r2-manifest.json');
  const configPath = path.join(root, 'r2.config.json');
  const outputPath = path.join(root, 'r2-public-manifest.json');
  await writeFile(manifestPath, serializeManifest(await buildManifest(root)));
  await writeFile(
    configPath,
    `${JSON.stringify({
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'stalkie-assets',
      publicBaseUrl: 'https://assets.example.com',
      manifestPath,
    }, null, 2)}\n`,
  );

  await execFileAsync(process.execPath, [
    CLI_PATH,
    'export',
    '--root',
    root,
    '--config',
    configPath,
    '--output',
    outputPath,
  ]);
  const exported = JSON.parse(await readFile(outputPath, 'utf8'));

  assert.match(
    exported['case/one.webp'].uri,
    /^https:\/\/assets\.example\.com\/blobs\/sha256\//,
  );
  assert.equal(exported['case/one.webp'].mediaType, 'image/webp');
});

test('manifest freshness check rejects changed local media', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await buildManifest(root);

  await assertManifestCurrent(manifest, root);
  await writeFile(path.join(root, 'case', 'one.webp'), Buffer.from('changed-media'));
  await assert.rejects(assertManifestCurrent(manifest, root), /manifest is stale/);
});

test('dry-run CLI rejects a stale manifest before reading credentials', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'r2-manifest.json');
  await writeFile(manifestPath, serializeManifest(await buildManifest(root)));
  await writeFile(path.join(root, 'case', 'new.webp'), Buffer.from('new-media'));

  await assert.rejects(
    execFileAsync(process.execPath, [
      CLI_PATH,
      'sync',
      '--dry-run',
      '--root',
      root,
      '--manifest',
      manifestPath,
    ]),
    /manifest is stale/,
  );
});

test('sync concurrently HEADs unique blobs, PUTs missing ones, and verifies metadata', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await buildManifest(root);
  const remote = new Map();
  const calls = [];
  let activeHeads = 0;
  let maxActiveHeads = 0;

  const client = {
    async send(command) {
      calls.push(command);
      if (command.constructor.name === 'HeadObjectCommand') {
        activeHeads += 1;
        maxActiveHeads = Math.max(maxActiveHeads, activeHeads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeHeads -= 1;
        const head = remote.get(command.input.Key);
        if (!head) {
          throw Object.assign(new Error('missing'), {
            $metadata: { httpStatusCode: 404 },
          });
        }
        return head;
      }
      if (command.constructor.name === 'PutObjectCommand') {
        remote.set(command.input.Key, {
          ContentLength: command.input.ContentLength,
          ContentType: command.input.ContentType,
          CacheControl: command.input.CacheControl,
          Metadata: command.input.Metadata,
        });
        return {};
      }
      throw new Error(`unexpected command: ${command.constructor.name}`);
    },
  };

  const summary = await syncManifest({
    client,
    bucket: 'assets',
    manifest,
    rootDirectory: root,
    concurrency: 2,
  });

  assert.equal(summary.uploaded, 2);
  assert.equal(summary.existing, 0);
  assert.equal(maxActiveHeads, 2);
  const puts = calls.filter((command) => command.constructor.name === 'PutObjectCommand');
  assert.equal(puts.length, 2);
  for (const put of puts) {
    assert.equal(put.input.Bucket, 'assets');
    assert.equal(put.input.CacheControl, CACHE_CONTROL);
    assert.equal(put.input.IfNoneMatch, '*');
    assert.match(put.input.ContentMD5, /^[A-Za-z0-9+/]{22}==$/);
    assert.match(put.input.Metadata.sha256, /^[a-f0-9]{64}$/);
    assert.ok(put.input.Body);
  }
});

test('sync skips matching blobs and rejects conflicting immutable metadata', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await buildManifest(root);
  const blobs = Object.values(manifest.files);
  const good = blobs[0];
  const bad = blobs.find((entry) => entry.key !== good.key);
  const puts = [];
  const client = {
    async send(command) {
      if (command.constructor.name === 'PutObjectCommand') {
        puts.push(command);
        return {};
      }
      const entry = command.input.Key === good.key ? good : bad;
      return {
        ContentLength: entry.bytes,
        ContentType: entry.contentType,
        CacheControl: CACHE_CONTROL,
        Metadata: {
          sha256: command.input.Key === good.key ? entry.sha256 : 'wrong',
        },
      };
    },
  };

  await assert.rejects(
    syncManifest({
      client,
      bucket: 'assets',
      manifest,
      rootDirectory: root,
      concurrency: 2,
    }),
    /immutable object metadata mismatch/,
  );
  assert.equal(puts.length, 0);
});

test('sync verifies a matching object when another uploader wins the conditional PUT race', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fullManifest = await buildManifest(root);
  const [logicalPath, entry] = Object.entries(fullManifest.files)[0];
  const manifest = { ...fullManifest, files: { [logicalPath]: entry } };
  let headCount = 0;
  const client = {
    async send(command) {
      if (command.constructor.name === 'HeadObjectCommand') {
        headCount += 1;
        if (headCount === 1) {
          throw Object.assign(new Error('missing'), {
            $metadata: { httpStatusCode: 404 },
          });
        }
        return {
          ContentLength: entry.bytes,
          ContentType: entry.contentType,
          CacheControl: CACHE_CONTROL,
          Metadata: { sha256: entry.sha256 },
        };
      }
      throw Object.assign(new Error('already exists'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      });
    },
  };

  const summary = await syncManifest({
    client,
    bucket: 'assets',
    manifest,
    rootDirectory: root,
    concurrency: 1,
  });

  assert.equal(summary.uploaded, 0);
  assert.equal(summary.existing, 1);
});

test('verify fails when a manifest blob is absent', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await buildManifest(root);
  const client = {
    async send() {
      throw Object.assign(new Error('missing'), { name: 'NotFound' });
    },
  };

  await assert.rejects(
    verifyManifest({ client, bucket: 'assets', manifest, concurrency: 2 }),
    /missing object/,
  );
});

test('verify downloads each unique object and rejects bytes that disagree with SHA-256', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await buildManifest(root);
  const byKey = new Map();
  for (const [logicalPath, entry] of Object.entries(manifest.files)) {
    if (!byKey.has(entry.key)) {
      byKey.set(entry.key, {
        entry,
        bytes: await readFile(path.join(root, ...logicalPath.split('/'))),
      });
    }
  }
  let getCount = 0;
  const client = {
    async send(command) {
      const remote = byKey.get(command.input.Key);
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          ContentLength: remote.entry.bytes,
          ContentType: remote.entry.contentType,
          CacheControl: CACHE_CONTROL,
          Metadata: { sha256: remote.entry.sha256 },
        };
      }
      getCount += 1;
      return { Body: Readable.from([remote.bytes]) };
    },
  };

  assert.deepEqual(
    await verifyManifest({ client, bucket: 'assets', manifest, concurrency: 2 }),
    { verified: 2 },
  );
  assert.equal(getCount, 2);

  const first = byKey.values().next().value;
  first.bytes = Buffer.from('tampered');
  await assert.rejects(
    verifyManifest({ client, bucket: 'assets', manifest, concurrency: 2 }),
    /remote content mismatch/,
  );
});

test('CLI rejects flags that are unsafe or meaningless for a command', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [CLI_PATH, 'manifest', '--dry-run']),
    /--dry-run is not valid for manifest/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [CLI_PATH, 'sync', '--check']),
    /--check is not valid for sync/,
  );
});
