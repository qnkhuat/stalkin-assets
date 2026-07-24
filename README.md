# stalkin-assets

Image assets for the Stalkie iOS and Android app (case photos, profile pictures, app icons).
During the R2 migration, released fixtures still use repository-hosted raw-file URLs.

Paths mirror the in-app case data references. Do not rename without updating the app fixtures.

## Cloudflare R2 migration

The R2 tooling keeps logical paths stable in a deterministic manifest while storing file bytes
once under content-addressed keys:

```text
logical path: cases/example/assets/images/calendar.webp
object key:   blobs/sha256/55/55ea43bafde811eeeb89fff5d359466ca0f3a69d7b98ec7fbcb21482d96b50fb
public URL:   https://assets.example.com/blobs/sha256/55/55ea43bafde811eeeb89fff5d359466ca0f3a69d7b98ec7fbcb21482d96b50fb
```

Identical files share one object key. Existing app fixtures can migrate from logical paths to
the generated public manifest without renaming source files in this repository.

### One-time configuration

1. Create an R2 bucket and an Object Read & Write token restricted to that bucket.
2. Copy the example and fill in the non-secret values:

   ```sh
   cp r2.config.example.json r2.config.json
   ```

   ```json
   {
     "accountId": "your-cloudflare-account-id",
     "bucket": "stalkie-assets",
     "publicBaseUrl": "https://assets.example.com",
     "manifestPath": "r2-manifest.json",
     "concurrency": 16
   }
   ```

   `accountId`, bucket name, and public domain are deployment configuration and should be
   checked in. The uploader derives the S3 endpoint as
   `https://<accountId>.r2.cloudflarestorage.com` and always uses region `auto`.

3. Keep only the two S3 credentials local:

   ```sh
   export R2_ACCESS_KEY_ID='...'
   export R2_SECRET_ACCESS_KEY='...'
   ```

   Do not put either value in JSON or commit them. No credentials are needed to build a
   manifest or run a dry run.

4. Connect the bucket to the configured custom domain in R2 bucket settings. Use the custom
   domain for production; Cloudflare documents `r2.dev` as a rate-limited development endpoint.

The custom domain publishes object keys directly below its root. Configure Cloudflare Cache for
that hostname as desired; uploads also set:

```text
Cache-Control: public, max-age=31536000, immutable
Content-Type:  inferred from the logical file extension
x-amz-meta-sha256: <lowercase SHA-256 hex>
```

### Commands

Install the pinned dependencies:

```sh
npm ci
```

Generate the deterministic logical-path manifest:

```sh
npm run r2:manifest
```

The scanner includes common image, audio, video, icon, SVG, and PDF extensions. It skips `.git`
and `node_modules`. Run it from a full checkout when producing the complete repository manifest;
a sparse checkout intentionally produces a manifest for only the materialized files.

Generate the app-ready logical-path map after configuring the public domain:

```sh
npm run r2:export
```

`r2-public-manifest.json` maps every logical path to an immutable `uri`, SHA-256, byte count, and
media type. It is deterministic and directly matches the metadata shape used by app fixtures.

Check that a committed manifest still matches the repository:

```sh
npm run r2:manifest -- --check
```

Review local counts, deduplication, and the maximum possible uploads without making network
requests or reading credentials:

```sh
npm run r2:dry-run
```

Dry run hashes the current checkout and rejects a stale manifest before reporting.

Upload missing content-addressed objects:

```sh
npm run r2:sync
```

The sync runs concurrent `HeadObject` checks, uploads only absent keys with `PutObject`, then
checks every upload again. Uploads include `Content-MD5`, so R2 rejects corrupted request bodies.
If an existing content-addressed key has different size, MIME type, cache policy, or SHA-256
metadata, sync stops instead of overwriting an immutable key.

Strictly verify every unique object in the manifest without uploading:

```sh
npm run r2:verify
```

Verification downloads each unique object and recomputes its SHA-256; matching metadata alone is
not considered proof of content integrity.

All commands accept explicit paths and concurrency when needed:

```sh
node scripts/r2-assets.mjs manifest --root . --manifest r2-manifest.json
node scripts/r2-assets.mjs export --config r2.config.json --output r2-public-manifest.json
node scripts/r2-assets.mjs sync --config r2.config.json --concurrency 24
node scripts/r2-assets.mjs verify --config r2.config.json --manifest r2-manifest.json
```

Run the local test suite:

```sh
npm test
```

### References

- [Cloudflare R2 S3 setup](https://developers.cloudflare.com/r2/get-started/s3/)
- [Cloudflare R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [Cloudflare R2 public buckets and custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3)
