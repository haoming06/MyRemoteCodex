#!/usr/bin/env bash

set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS installer builds require macOS." >&2
  exit 1
fi

cd "$project_root"
npm run build

for architecture in arm64 x86_64; do
  echo "Building My Remote Codex for $architecture..."
  TARGET_ARCH="$architecture" \
  REMOTE_CODEX_SKIP_APP_BUILD=true \
  REMOTE_CODEX_BUILD_ROOT="$project_root/dist/macos-installer-$architecture" \
    "$project_root/scripts/build-macos-installer.sh"
done

version="$(node -p 'require("./package.json").version')"
echo
echo "Architecture-specific installers:"
missing_dmg=false
for architecture in arm64 x86_64; do
  dmg="$project_root/dist/installers/My-Remote-Codex-${version}-${architecture}.dmg"
  pkg="$project_root/dist/installers/My-Remote-Codex-${version}-${architecture}.pkg"
  if [ -f "$dmg" ]; then
    echo "  $dmg"
  else
    echo "Missing required DMG: $dmg" >&2
    missing_dmg=true
  fi
  echo "  $pkg"
done

if [ "$missing_dmg" = "true" ]; then
  echo "Both architecture-specific DMGs are required." >&2
  exit 1
fi
