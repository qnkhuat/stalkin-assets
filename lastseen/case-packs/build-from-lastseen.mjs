#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ASSET_REPO_ROOT = resolve(SCRIPT_DIR, '../..');
const OUTPUT_ROOT = join(SCRIPT_DIR, 'v1');
const BLOB_ROOT = join(OUTPUT_ROOT, 'blobs');
const MANIFEST_ROOT = join(OUTPUT_ROOT, 'manifests');
const appRoot = resolve(process.argv[2] ?? '');

if (!process.argv[2]) {
  throw new Error('Usage: node lastseen/case-packs/build-from-lastseen.mjs <lastseen-app-root>');
}

const generatedModulePath = join(
  appRoot,
  'src/data/fixtures/caseRuntime.generated.ts',
);
const generatedModule = await readFile(generatedModulePath, 'utf8');
const caseSources = parseGeneratedSources(generatedModule);
const blobSources = new Map();
const manifests = [];

await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(BLOB_ROOT, { recursive: true });
await mkdir(MANIFEST_ROOT, { recursive: true });

for (const [caseId, sources] of caseSources) {
  const packagePath = join(
    appRoot,
    `src/data/fixtures/lastseen-v2/${caseId}.en.json`,
  );
  const manifestPath = await sourceManifestPath(appRoot, caseId);
  const [casePackageBytes, sourceManifestBytes] = await Promise.all([
    readFile(packagePath),
    readFile(manifestPath),
  ]);
  const casePackage = JSON.parse(casePackageBytes);
  const sourceManifest = JSON.parse(sourceManifestBytes);
  const records = indexSourceRecords(sourceManifest.assets ?? []);
  const shellPaths = shellLogicalPaths(casePackage, records);
  const assets = [];
  const bundledShell = [];

  for (const source of sources) {
    const sourcePath =
      source.kind === 'module'
        ? join(appRoot, 'assets/cases/runtime', source.filename)
        : githubRawLocalPath(source.uri);
    const absoluteSourcePath =
      source.kind === 'module'
        ? sourcePath
        : join(ASSET_REPO_ROOT, sourcePath);
    const bytes = await readFile(absoluteSourcePath);
    const digest = sha256(bytes);
    const declaration = records.get(source.logicalPath);

    verifyDeclaration(caseId, source.logicalPath, declaration, bytes, digest);
    if (source.kind === 'module' && !source.filename.startsWith(`${digest}.`)) {
      throw new Error(
        `${caseId}:${source.logicalPath}: runtime filename is not content-addressed`,
      );
    }

    const mediaType =
      declaration?.mediaType ??
      declaration?.contentType ??
      mediaTypeFor(source.logicalPath);
    const entry = {
      logicalPath: source.logicalPath,
      role: assetRole(source.logicalPath, source.mediaKind, mediaType),
      mediaType,
      sha256: digest,
      bytes: bytes.length,
    };

    if (shellPaths.has(source.logicalPath)) {
      bundledShell.push({
        ...entry,
        currentSource:
          source.kind === 'module'
            ? `app/assets/cases/runtime/${source.filename}`
            : sourcePath,
      });
      continue;
    }

    const extension = normalizedExtension(source.logicalPath, source.filename);
    const blobFilename = `${digest}${extension}`;
    const blobPath = `lastseen/case-packs/v1/blobs/${blobFilename}`;
    const previousSource = blobSources.get(blobFilename);
    if (previousSource) {
      const previousBytes = await readFile(previousSource);
      if (!previousBytes.equals(bytes)) {
        throw new Error(`${blobFilename}: content-address collision`);
      }
    } else {
      blobSources.set(blobFilename, absoluteSourcePath);
      await copyFile(absoluteSourcePath, join(BLOB_ROOT, blobFilename));
    }
    assets.push({ ...entry, blobPath });
  }

  assets.sort(compareLogicalPath);
  bundledShell.sort(compareLogicalPath);
  const uniqueAssets = new Map(
    assets.map((asset) => [asset.sha256, asset]),
  );
  const manifest = {
    schemaVersion: 1,
    packVersion: 'v1',
    caseId,
    locale: casePackage.locale,
    contentRevision: casePackage.contentRevision,
    source: {
      packageSha256: sha256(casePackageBytes),
      reconstructionManifest: sourceManifestLabel(manifestPath),
      reconstructionManifestSha256: sha256(sourceManifestBytes),
    },
    delivery: {
      baseUrl:
        'https://raw.githubusercontent.com/qnkhuat/stalkin-assets/main/',
      integrity: 'sha256',
      cacheKey: 'sha256',
    },
    summary: {
      downloadableEntries: assets.length,
      uniqueDownloadBlobs: uniqueAssets.size,
      uniqueDownloadBytes: sum([...uniqueAssets.values()], 'bytes'),
      bundledShellEntries: bundledShell.length,
      bundledShellBytes: sum(bundledShell, 'bytes'),
    },
    assets,
    bundledShell,
  };
  const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(MANIFEST_ROOT, `${caseId}.json`), rendered);
  manifests.push(manifest);
}

const index = {
  schemaVersion: 1,
  packVersion: 'v1',
  baseUrl: 'https://raw.githubusercontent.com/qnkhuat/stalkin-assets/main/',
  manifests: await Promise.all(
    manifests.map(async (manifest) => ({
      caseId: manifest.caseId,
      path: `lastseen/case-packs/v1/manifests/${manifest.caseId}.json`,
      sha256: sha256(
        await readFile(join(MANIFEST_ROOT, `${manifest.caseId}.json`)),
      ),
      ...manifest.summary,
    })),
  ),
};
await writeFile(
  join(OUTPUT_ROOT, 'index.json'),
  `${JSON.stringify(index, null, 2)}\n`,
);

const outputFiles = await Promise.all(
  [...blobSources.keys()].map(async (filename) => {
    const path = join(BLOB_ROOT, filename);
    return { filename, bytes: (await stat(path)).size };
  }),
);
process.stdout.write(
  `wrote ${manifests.length} manifests and ${outputFiles.length} unique blobs ` +
    `(${sum(outputFiles, 'bytes')} bytes)\n`,
);

function parseGeneratedSources(source) {
  const cases = new Map();
  let currentCase;
  for (const line of source.split('\n')) {
    const caseMatch = line.match(/^  ("(?:[^"\\]|\\.)*"): \{$/);
    if (caseMatch) {
      currentCase = JSON.parse(caseMatch[1]);
      cases.set(currentCase, []);
      continue;
    }
    if (currentCase && line === '  },') {
      currentCase = undefined;
      continue;
    }
    if (!currentCase) continue;

    const moduleMatch = line.match(
      /^    ("(?:[^"\\]|\\.)*"): \{ native: require\(("(?:[^"\\]|\\.)*")\), android: "(?:[^"\\]|\\.)*", kind: "(image|audio)" \},$/,
    );
    if (moduleMatch) {
      const requiredPath = JSON.parse(moduleMatch[2]);
      cases.get(currentCase).push({
        logicalPath: JSON.parse(moduleMatch[1]),
        kind: 'module',
        filename: requiredPath.split('/').at(-1),
        mediaKind: moduleMatch[3],
      });
      continue;
    }

    const uriMatch = line.match(
      /^    ("(?:[^"\\]|\\.)*"): ("https?:\/\/(?:[^"\\]|\\.)*"),$/,
    );
    if (uriMatch) {
      const uri = JSON.parse(uriMatch[2]);
      cases.get(currentCase).push({
        logicalPath: JSON.parse(uriMatch[1]),
        kind: 'uri',
        uri,
        mediaKind: /\.(?:aac|m4a|mp3|ogg|wav)$/i.test(uri)
          ? 'audio'
          : 'image',
      });
    }
  }
  if (cases.size === 0) throw new Error('No case assets found in generated module');
  return cases;
}

async function sourceManifestPath(root, caseId) {
  const candidates = [
    join(
      root,
      `src/data/fixtures/lastseen-v2/${caseId}.en.runtime-preview-manifest.json`,
    ),
    join(
      root,
      `src/data/fixtures/lastseen-v2/${caseId}.en.conversion-manifest.json`,
    ),
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`${caseId}: reconstruction manifest unavailable`);
}

function sourceManifestLabel(path) {
  return path.split('/').at(-1);
}

function indexSourceRecords(entries) {
  const records = new Map();
  for (const entry of entries) {
    if (!entry?.logicalPath) continue;
    const previous = records.get(entry.logicalPath);
    if (!previous) {
      records.set(entry.logicalPath, { ...entry });
      continue;
    }
    for (const key of ['sha256', 'bytes', 'mediaType', 'contentType']) {
      if (
        previous[key] != null &&
        entry[key] != null &&
        previous[key] !== entry[key]
      ) {
        throw new Error(`${entry.logicalPath}: conflicting declared ${key}`);
      }
      if (previous[key] == null && entry[key] != null) previous[key] = entry[key];
    }
  }
  return records;
}

function shellLogicalPaths(casePackage, records) {
  const refs = new Set([
    casePackage.metadata?.cardAsset,
    casePackage.metadata?.presentation?.caseCardAsset,
    casePackage.metadata?.presentation?.caseIntroBackgroundAsset,
  ]);
  const guide = casePackage.people?.find(
    (person) => person.id === casePackage.metadata?.guide?.id,
  );
  refs.add(guide?.avatarAsset);
  for (const app of casePackage.phone?.apps ?? []) refs.add(app.iconAsset);

  const paths = new Set();
  for (const record of records.values()) {
    if (refs.has(record.ref)) paths.add(record.logicalPath);
  }
  return paths;
}

function githubRawLocalPath(value) {
  const url = new URL(value);
  const prefix = '/qnkhuat/stalkin-assets/';
  if (url.hostname !== 'raw.githubusercontent.com' || !url.pathname.startsWith(prefix)) {
    throw new Error(`Asset is not hosted by qnkhuat/stalkin-assets: ${value}`);
  }
  const segments = url.pathname.slice(prefix.length).split('/');
  if (segments.length < 2) throw new Error(`Invalid GitHub raw URL: ${value}`);
  segments.shift();
  const localPath = decodeURIComponent(segments.join('/'));
  if (!localPath.startsWith('lastseen/')) {
    throw new Error(`Asset is outside lastseen/: ${value}`);
  }
  return localPath;
}

function verifyDeclaration(caseId, logicalPath, declaration, bytes, digest) {
  if (!declaration) {
    throw new Error(`${caseId}:${logicalPath}: source declaration unavailable`);
  }
  if (declaration.bytes != null && declaration.bytes !== bytes.length) {
    throw new Error(
      `${caseId}:${logicalPath}: expected ${declaration.bytes} bytes, received ${bytes.length}`,
    );
  }
  if (declaration.sha256 && declaration.sha256 !== digest) {
    throw new Error(`${caseId}:${logicalPath}: SHA-256 mismatch`);
  }
}

function assetRole(logicalPath, mediaKind, mediaType) {
  if (mediaKind === 'audio' || mediaType.startsWith('audio/')) return 'audio';
  if (mediaType === 'application/pdf') return 'document';
  if (/(?:^|[/_-])(?:avatar|profile|contact)(?:[/_.-]|$)/i.test(logicalPath)) {
    return 'avatar';
  }
  if (/(?:safari_tabs|favicon|thumbnail|thumb|preview)/i.test(logicalPath)) {
    return 'thumbnail';
  }
  if (/(?:^|[/_-])(?:photo|photos|instagram|snapchat|spark|bereal)(?:[/_.-]|$)/i.test(logicalPath)) {
    return 'photo';
  }
  return 'image';
}

function normalizedExtension(logicalPath, filename) {
  const extension = extname(filename ?? logicalPath).toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(extension)) {
    throw new Error(`${logicalPath}: extension unavailable`);
  }
  return extension;
}

function mediaTypeFor(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.aac' || extension === '.m4a') return 'audio/mp4';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.ogg') return 'audio/ogg';
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function compareLogicalPath(left, right) {
  return left.logicalPath.localeCompare(right.logicalPath);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sum(entries, key) {
  return entries.reduce((total, entry) => total + entry[key], 0);
}
