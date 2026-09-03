#!/usr/bin/env bash
# Pack the versioned Worker and publish a GitHub Release.
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
export RELAYBASE_DOWNLOADS_DIR="${RELAYBASE_DOWNLOADS_DIR:-$ROOT/dist/downloads}"
export RELAYBASE_WORKER_GITHUB_REPO="$REPO"

pnpm run pack:customer-install

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

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "Release $TAG exists — uploading assets (clobber)."
  gh release upload "$TAG" --repo "$REPO" --clobber \
    "$WORKER_JS" "$ZIP" "$ZIP_ALIAS" "$MANIFEST"
else
  echo "Creating release $TAG"
  gh release create "$TAG" --repo "$REPO" --title "Relaybase Worker ${VERSION}" \
    "${NOTES_ARGS[@]}" \
    "$WORKER_JS" "$ZIP" "$ZIP_ALIAS" "$MANIFEST"
fi

echo
echo "Manifest (latest):  https://github.com/${REPO}/releases/latest/download/worker-install-manifest.json"
echo "ZIP (versioned):    https://github.com/${REPO}/releases/download/${TAG}/relaybase-worker-install-${VERSION}.zip"
echo "Worker JS:          https://github.com/${REPO}/releases/download/${TAG}/worker.${VERSION}.js"
echo "Release page:       https://github.com/${REPO}/releases/tag/${TAG}"
