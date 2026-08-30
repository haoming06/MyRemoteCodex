#!/usr/bin/env bash

set -Eeuo pipefail

die() {
  echo "Error: $*" >&2
  exit 1
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

version=""
architecture=""
output=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 ;;
    --arch) architecture="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --version VERSION --arch arm64|x86_64 --output PATH"
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version must be a semantic Node.js version"
case "$architecture" in
  arm64) node_arch="arm64" ;;
  x86_64) node_arch="x64" ;;
  *) die "--arch must be arm64 or x86_64" ;;
esac
[ -n "$output" ] || die "--output is required"
[ -d "$(dirname "$output")" ] || die "Output directory does not exist: $(dirname "$output")"

if [ -x "$output" ] && [ "$(lipo -archs "$output" 2>/dev/null || true)" = "$architecture" ]; then
  echo "Node.js v$version for $architecture is already available at $output"
  exit 0
fi

for command_name in curl tar shasum lipo; do
  command -v "$command_name" >/dev/null 2>&1 || die "Required command not found: $command_name"
done

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/my-remote-codex-node.XXXXXX")"
trap 'rm -rf "$temporary_directory"' EXIT

archive_name="node-v${version}-darwin-${node_arch}.tar.gz"
archive="$temporary_directory/$archive_name"
checksums="$temporary_directory/SHASUMS256.txt"
base_url="https://nodejs.org/dist/v${version}"

echo "Downloading official Node.js v$version for macOS/$architecture..."
curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
  --connect-timeout 15 --max-time 300 \
  "$base_url/$archive_name" --output "$archive"
curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
  --connect-timeout 15 --max-time 60 \
  "$base_url/SHASUMS256.txt" --output "$checksums"

expected_checksum="$(awk -v filename="$archive_name" '$2 == filename {print $1; exit}' "$checksums")"
[ -n "$expected_checksum" ] || die "Node.js checksum is missing for $archive_name"
actual_checksum="$(sha256_file "$archive")"
[ "$actual_checksum" = "$expected_checksum" ] || \
  die "Node.js checksum mismatch (expected $expected_checksum, got $actual_checksum)"

tar -xzf "$archive" -C "$temporary_directory"
source_binary="$temporary_directory/node-v${version}-darwin-${node_arch}/bin/node"
[ -x "$source_binary" ] || die "Node.js executable is missing from $archive_name"
[ "$(lipo -archs "$source_binary")" = "$architecture" ] || \
  die "Downloaded Node.js executable does not match $architecture"

install -m 0755 "$source_binary" "$output"
echo "Installed Node.js v$version for $architecture at $output"
