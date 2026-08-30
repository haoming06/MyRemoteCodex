#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="${project_root}/native/macos-capture"
architecture="${TARGET_ARCH:-$(uname -m)}"
build_dir="${REMOTE_CODEX_NATIVE_BUILD_DIR:-${package_dir}/.build}"
app_path="${build_dir}/My Remote Codex Capture.app"
executable_dir="${app_path}/Contents/MacOS"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS native builds require macOS." >&2
  exit 1
fi
if [ "$architecture" != "arm64" ] && [ "$architecture" != "x86_64" ]; then
  echo "Unsupported macOS architecture: $architecture" >&2
  exit 1
fi

mkdir -p \
  "${package_dir}/.cache/${architecture}" \
  "${package_dir}/.module-cache/${architecture}" \
  "${package_dir}/.swiftpm-config" \
  "${package_dir}/.swiftpm-security"

export SWIFTPM_MODULECACHE_OVERRIDE="${package_dir}/.module-cache/${architecture}"
export CLANG_MODULE_CACHE_PATH="${package_dir}/.module-cache/${architecture}"

swift_options=(
  -c release \
  --arch "${architecture}" \
  --package-path "${package_dir}" \
  --cache-path "${package_dir}/.cache/${architecture}" \
  --config-path "${package_dir}/.swiftpm-config" \
  --security-path "${package_dir}/.swiftpm-security" \
  --scratch-path "${build_dir}" \
  --manifest-cache local \
  --disable-sandbox
)
swift build "${swift_options[@]}"
binary_dir="$(swift build "${swift_options[@]}" --show-bin-path)"

mkdir -p "${executable_dir}"
install -m 755 \
  "${binary_dir}/remote-codex-capture" \
  "${executable_dir}/remote-codex-capture"
install -m 644 \
  "${package_dir}/Resources/Info.plist" \
  "${app_path}/Contents/Info.plist"

codesign \
  --force \
  --sign - \
  --identifier com.myremotecodex.capture \
  "${app_path}"

codesign --verify --deep --strict "${app_path}"
echo "Built ${app_path}"
