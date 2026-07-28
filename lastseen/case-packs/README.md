# Last Seen case packs

Versioned, content-addressed media delivery for Last Seen cases.

- `v1/index.json` lists one manifest per case.
- `v1/manifests/<case>.json` maps every case logical path to a verified blob.
- `v1/blobs/<sha256>.<ext>` stores downloadable case media shared across packs.
- `bundledShell` lists catalog cards, guide portraits, and app icons that stay
  in the app binary. They are deliberately not copied into the downloadable
  blob set.

Consumers download the selected case manifest, fetch each unique `blobPath`,
verify its `sha256` and `bytes`, then cache it by SHA-256. A case should open
only after its pack is complete, so clue media remains available offline.
Using `main` is supported by the manifest, but a released app should pin the
asset-repository commit containing the matching index.

Regenerate from a Last Seen checkout:

```bash
node lastseen/case-packs/build-from-lastseen.mjs /path/to/lastseen/app
```

The generator reads Last Seen's deterministic package/manifests and generated
runtime registry. It verifies every declared hash and byte count, verifies all
remote inputs are already under `qnkhuat/stalkin-assets/lastseen`, and refuses
external asset hosts.
