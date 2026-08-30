#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_icon="${1:-}"
output_icon="${2:-}"

if [ -z "$source_icon" ] || [ -z "$output_icon" ]; then
  echo "Usage: $0 SOURCE_PNG OUTPUT_ICNS" >&2
  exit 1
fi
if [ ! -f "$source_icon" ]; then
  echo "Source icon not found: $source_icon" >&2
  exit 1
fi

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/my-remote-codex-icon.XXXXXX")"
iconset="$temporary_root/AppIcon.iconset"

cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

mkdir -p "$iconset" "$(dirname "$output_icon")"

render_icon() {
  local pixels="$1"
  local filename="$2"
  sips -s format png -z "$pixels" "$pixels" "$source_icon" \
    --out "$iconset/$filename" >/dev/null
}

render_icon 16 icon_16x16.png
render_icon 32 icon_16x16@2x.png
render_icon 32 icon_32x32.png
render_icon 64 icon_32x32@2x.png
render_icon 128 icon_128x128.png
render_icon 256 icon_128x128@2x.png
render_icon 256 icon_256x256.png
render_icon 512 icon_256x256@2x.png
render_icon 512 icon_512x512.png
render_icon 1024 icon_512x512@2x.png

node "$script_dir/build-icns.mjs" "$iconset" "$output_icon"
