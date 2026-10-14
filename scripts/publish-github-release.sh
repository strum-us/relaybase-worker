#!/usr/bin/env bash
# Pack the versioned Worker, upload it to R2, then publish the same files
# as a GitHub Release.
# Assets: worker.{version}.js, install ZIP (+ alias), worker-install-manifest.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
if [[ -z "$VERSION" || "$VERSION" == "0.0.0" ]]; then
  echo "Set a release version in package.json" >&2
  exit 1
fi

TAG="v${VERSION}"
REPO="${RELAYBASE_WORKER_GITHUB_REPO:-strum-us/relaybase-worker}"
DOWNLOADS_ORIGIN="${RELAYBASE_DOWNLOADS_ORIGIN:-https://downloads.relaybase.email}"
export RELAYBASE_DOWNLOADS_DIR="${RELAYBASE_DOWNLOADS_DIR:-$ROOT/dist/downloads}"
export RELAYBASE_WORKER_GITHUB_REPO="$REPO"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-3adf03d991843094a7343eebc0a98007}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required. Install artifacts publish to R2 (${DOWNLOADS_ORIGIN}) and GitHub Releases." >&2
  echo "Token needs R2 edit on account ${CLOUDFLARE_ACCOUNT_ID}. One-time: pnpm run setup:downloads" >&2
  exit 1
fi

# Manifest zipUrl / workerJsUrl point at the public bucket. GitHub keeps a copy of the same bytes.
export RELAYBASE_DOWNLOAD_BASE="${RELAYBASE_DOWNLOAD_BASE:-${DOWNLOADS_ORIGIN}/v${VERSION}}"

pnpm run pack:customer-install

bash "$ROOT/scripts/publish-r2-downloads.sh"

WORKER_JS="$RELAYBASE_DOWNLOADS_DIR/worker.${VERSION}.js"
ZIP="$RELAYBASE_DOWNLOADS_DIR/relaybase-worker-install-${VERSION}.zip"
ZIP_ALIAS="$RELAYBASE_DOWNLOADS_DIR/relaybase-worker-install.zip"
MANIFEST="$RELAYBASE_DOWNLOADS_DIR/worker-install-manifest.json"
NOTES="$ROOT/release-notes/${VERSION}.md"

for f in "$WORKER_JS" "$ZIP" "$MANIFEST"; do
  if [[ ! -f "$f" ]]; then
    echo "Missing pack output: $f" >&2
    exit 1
  fi
done

NOTES_ARGS=()
if [[ -f "$NOTES" ]]; then
  NOTES_ARGS=(--notes-file "$NOTES")
else
  NOTES_ARGS=(--notes "Relaybase Worker ${VERSION}")
fi

NOTES_BODY="$(node -e "
const fs = require('fs');
const raw = fs.readFileSync(process.argv[1], 'utf8').replace(/\r\n/g, '\n');
const m = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
process.stdout.write((m ? m[1] : raw).trim());
" "$NOTES" 2>/dev/null || true)"
if [[ -z "${NOTES_BODY:-}" && -f "$NOTES" ]]; then
  NOTES_BODY="$(cat "$NOTES")"
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG exists — updating notes and uploading assets (clobber)."
  if [[ -n "${NOTES_BODY:-}" ]]; then
    gh release edit "$TAG" --repo "$REPO" --notes "$NOTES_BODY"
  fi
  gh release upload "$TAG" --repo "$REPO" --clobber \
    "$WORKER_JS" "$ZIP" "$ZIP_ALIAS" "$MANIFEST"
else
  echo "Creating release $TAG"
  gh release create "$TAG" --repo "$REPO" --title "Relaybase Worker ${VERSION}" \
    "${NOTES_ARGS[@]}" \
    "$WORKER_JS" "$ZIP" "$ZIP_ALIAS" "$MANIFEST"
fi

echo
echo "R2 manifest:        ${DOWNLOADS_ORIGIN}/worker-install-manifest.json"
echo "R2 ZIP:             ${DOWNLOADS_ORIGIN}/v${VERSION}/relaybase-worker-install-${VERSION}.zip"
echo "GitHub manifest:    https://github.com/${REPO}/releases/latest/download/worker-install-manifest.json"
echo "GitHub ZIP:         https://github.com/${REPO}/releases/download/${TAG}/relaybase-worker-install-${VERSION}.zip"
echo "Release page:       https://github.com/${REPO}/releases/tag/${TAG}"
