# Worker install release workflow

Customer-facing Worker installs ship as **pre-built JS bundles** (not TypeScript source).

Desktop and Worker share **one product semver** — always bump both together.
First public release: **0.1.1**. Policy: sibling repo
[`relaybase/docs/version-sync.md`](../../relaybase/docs/version-sync.md).

**CRITICAL (Pre-launch):** Version is frozen at **`0.1.1`**. Do **NOT** bump versions for pre-launch bug fixes or repackaging. After official launch, later updates bump the **patch** only (`0.1.2`, `0.1.3`, …). There is no separate
dev / `+local` channel. Desktop install/update uploads **only** this hosted ZIP.

Desktop releases: [`relaybase/desktop/docs/release.md`](../../relaybase/desktop/docs/release.md).

---

## Git workflow

Every Worker release uses a dedicated branch. Do **not** bump versions or
commit download artifacts straight on `main`.

```text
release-worker-<semver>    # e.g. release-worker-0.1.1
```

1. `git checkout main && git pull`
2. `git checkout -b release-worker-X.Y.Z`
3. All release work on that branch
4. Push branch
5. Merge into `main`, push `main`
6. Tag `vX.Y.Z` and publish a GitHub Release (`pnpm run publish:github`)
7. Keep `release-worker-X.Y.Z` on the remote

---

## Checklist

### 1. Version bump

Set the version in [`package.json`](../package.json) **and** bump Desktop in the sibling `relaybase` repo to the same semver — see [`relaybase/docs/version-sync.md`](../../relaybase/docs/version-sync.md).

### 2. Release notes (required)

Create `release-notes/X.Y.Z.md`:

```markdown
---
date: YYYY-MM-DD
---

# Relaybase Worker X.Y.Z

## Highlights
- …

## Changes
- …
```

`pack-customer-install.mjs` **fails** if this file is missing.

### 3. Pack

From the sibling `relaybase` repo root (or this repo):

```bash
# from relaybase/
pnpm pack:worker-install

# or from this repo (writes into ../relaybase/hq/website/public/downloads when present)
pnpm run pack:customer-install
```

Pack runs `build:bundle` and writes versioned artifacts. Manifest `zipUrl` /
`workerJsUrl` point at GitHub Releases
(`https://github.com/strum-us/relaybase-worker/releases/download/vX.Y.Z/…`).
Override the output directory with `RELAYBASE_DOWNLOADS_DIR`.

### 4. Publish GitHub Release

From this repo (requires `gh` auth):

```bash
pnpm run publish:github
```

This creates tag `vX.Y.Z` (if needed) and uploads:

- `worker.X.Y.Z.js`
- `relaybase-worker-install-X.Y.Z.zip`
- `relaybase-worker-install.zip` (latest alias)
- `worker-install-manifest.json`

Pushing a `v*` tag also runs `.github/workflows/release.yml`.

### 5. Verify

```bash
curl -sL https://github.com/strum-us/relaybase-worker/releases/latest/download/worker-install-manifest.json
curl -sI https://github.com/strum-us/relaybase-worker/releases/download/vX.Y.Z/worker.X.Y.Z.js | grep -i HTTP
```

---

## What the pack script produces

| Output | Purpose |
|--------|---------|
| `worker.{version}.js` | Wrangler-bundled Worker (all deps inlined) |
| `worker.js` | Same bytes as `worker.{version}.js` (compat alias for 0.1.1 desktops) |
| `wrangler.toml` | `main = "worker.{version}.js"`, `WORKER_VERSION`, D1/R2 bindings |
| `VERSION` | Plaintext version for staging |
| `worker-install-manifest.json` | `{ version, zipUrl, zipSha256, workerJs, workerJsUrl, publishedAt, notes }` |

Desktop auto-install and Worker updates download the GitHub Release manifest,
verify SHA-256, unzip, and upload the script — **no `npm install`**, no local overlay.

Public URLs (after publish):

| Asset | URL |
|-------|-----|
| Latest manifest | `https://github.com/strum-us/relaybase-worker/releases/latest/download/worker-install-manifest.json` |
| Versioned Worker JS | `https://github.com/strum-us/relaybase-worker/releases/download/vX.Y.Z/worker.X.Y.Z.js` |
| Versioned install ZIP | `https://github.com/strum-us/relaybase-worker/releases/download/vX.Y.Z/relaybase-worker-install-X.Y.Z.zip` |

## Desktop behavior

- **Fresh install:** downloads latest ZIP from manifest → deploy → stores `workerVersion` in `~/.relaybase/workspace.json`.
- **Startup banner:** compares stored version to manifest; prompts update.
- **Settings → Cloudflare:** manual check + “Update Worker” re-deploy.

## Local overrides

| Env var | Effect |
|---------|--------|
| `RELAYBASE_INSTALL_MANIFEST_URL` | Override manifest URL for desktop auto-install |
