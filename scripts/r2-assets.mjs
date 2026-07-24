#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_PUBLIC_MANIFEST_PATH,
  assertManifestCurrent,
  buildManifest,
  buildPublicManifest,
  createR2ClientConfig,
  readManifest,
  serializeManifest,
  summarizeManifest,
  syncManifest,
  validateDeploymentConfig,
  verifyManifest,
  writeManifest,
} from './lib/r2-assets.mjs';

const { command, options } = parseArguments(process.argv.slice(2));
const rootDirectory = path.resolve(options.root ?? '.');

if (command === 'manifest') {
  validateOptions(command, options);
  const manifestPath = path.resolve(options.manifest ?? DEFAULT_MANIFEST_PATH);
  const manifest = await buildManifest(rootDirectory);
  if (options.check) {
    const current = await readFile(manifestPath, 'utf8').catch(() => '');
    if (current !== serializeManifest(manifest)) {
      throw new Error(`${path.relative(process.cwd(), manifestPath)} is stale`);
    }
  } else {
    await writeManifest(manifestPath, manifest);
  }
  printSummary(options.check ? 'Manifest is current' : 'Manifest written', summarizeManifest(manifest));
  process.exit(0);
}

if (command === 'sync' && options.dryRun) {
  validateOptions(command, options);
  const config = options.config
    ? await readConfig(path.resolve(options.config))
    : {};
  const manifest = await readManifest(
    path.resolve(options.manifest ?? config.manifestPath ?? DEFAULT_MANIFEST_PATH),
  );
  await assertManifestCurrent(manifest, rootDirectory);
  const concurrency = parseConcurrency(options.concurrency ?? config.concurrency ?? 16);
  const summary = await syncManifest({
    manifest,
    rootDirectory,
    concurrency,
    dryRun: true,
  });
  printSummary('Dry run (no network requests)', summary);
  process.exit(0);
}

if (command !== 'sync' && command !== 'verify' && command !== 'export') {
  usage();
  process.exit(1);
}
validateOptions(command, options);

const configPath = path.resolve(options.config ?? 'r2.config.json');
const config = await readConfig(configPath);
const manifestPath = path.resolve(
  options.manifest ?? config.manifestPath ?? DEFAULT_MANIFEST_PATH,
);
const manifest = await readManifest(manifestPath);
const concurrency = parseConcurrency(options.concurrency ?? config.concurrency ?? 16);
if (command === 'export') {
  await assertManifestCurrent(manifest, rootDirectory);
  const outputPath = path.resolve(options.output ?? DEFAULT_PUBLIC_MANIFEST_PATH);
  await writeManifest(outputPath, buildPublicManifest(manifest, config.publicBaseUrl));
  console.log(`Public manifest written: ${path.relative(process.cwd(), outputPath)}`);
} else if (command === 'sync') {
  await assertManifestCurrent(manifest, rootDirectory);
  const client = createClient(config);
  const summary = await syncManifest({
    client,
    bucket: config.bucket,
    manifest,
    rootDirectory,
    concurrency,
  });
  printSummary('R2 sync complete', summary);
} else if (command === 'verify') {
  const client = createClient(config);
  const summary = await verifyManifest({
    client,
    bucket: config.bucket,
    manifest,
    concurrency,
  });
  printSummary('R2 verification complete', summary);
}

function createClient(config) {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required for sync/verify',
    );
  }
  return new S3Client({
    ...createR2ClientConfig(config.accountId, { accessKeyId, secretAccessKey }),
  });
}

async function readConfig(configFile) {
  try {
    return validateDeploymentConfig(JSON.parse(await readFile(configFile, 'utf8')));
  } catch (error) {
    throw new Error(`${configFile}: ${error.message}`);
  }
}

function parseArguments(args) {
  const command = args[0];
  const options = {};
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--dry-run') options.dryRun = true;
    else if (value === '--check') options.check = true;
    else if (value.startsWith('--')) {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`);
      options[value.slice(2)] = next;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  return { command, options };
}

function parseConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  return parsed;
}

function validateOptions(commandName, optionsToValidate) {
  const allowed = {
    manifest: new Set(['root', 'manifest', 'check']),
    export: new Set(['root', 'config', 'manifest', 'output']),
    sync: new Set(['root', 'config', 'manifest', 'concurrency', 'dryRun']),
    verify: new Set(['config', 'manifest', 'concurrency']),
  }[commandName];
  for (const option of Object.keys(optionsToValidate)) {
    if (!allowed?.has(option)) {
      const optionName = option.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      throw new Error(`--${optionName} is not valid for ${commandName}`);
    }
  }
}

function printSummary(title, summary) {
  console.log(title);
  for (const [key, value] of Object.entries(summary)) {
    console.log(`  ${key}: ${value}`);
  }
}

function usage() {
  console.error(`Usage:
  node scripts/r2-assets.mjs manifest [--root .] [--manifest r2-manifest.json] [--check]
  node scripts/r2-assets.mjs export [--root .] [--config r2.config.json] [--manifest path] [--output r2-public-manifest.json]
  node scripts/r2-assets.mjs sync [--dry-run] [--config r2.config.json] [--manifest path] [--root .] [--concurrency 16]
  node scripts/r2-assets.mjs verify [--config r2.config.json] [--manifest path] [--concurrency 16]`);
}
