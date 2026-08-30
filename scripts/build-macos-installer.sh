#!/usr/bin/env bash

set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$project_root/native/macos-host"
architecture="${TARGET_ARCH:-$(uname -m)}"
capture_build="$project_root/native/macos-capture/.build/installers/$architecture"
capture_app="$capture_build/My Remote Codex Capture.app"
build_root="${REMOTE_CODEX_BUILD_ROOT:-$project_root/dist/macos-installer}"
app_path="$build_root/My Remote Codex.app"
contents="$app_path/Contents"
resources="$contents/Resources"
runtime="$resources/runtime"
runtime_app="$resources/app"
swift_build="$package_dir/.build/installers/$architecture"
installer_dir="$project_root/dist/installers"
version="$(node -p 'require("./package.json").version')"
node_version="${REMOTE_CODEX_NODE_VERSION:-$(node -p 'process.versions.node')}"
dmg_path="$installer_dir/My-Remote-Codex-${version}-${architecture}.dmg"
pkg_path="$installer_dir/My-Remote-Codex-${version}-${architecture}.pkg"
component_plist="$package_dir/Resources/PackageComponent.plist"
identity="${CODESIGN_IDENTITY:--}"
installer_identity="${INSTALLER_IDENTITY:-}"
frpc_cache="$package_dir/.cache/frpc-v0.71.0-${architecture}"
node_architecture="$architecture"
if [ "$architecture" = "x86_64" ]; then
  node_architecture="x64"
fi
node_cache="$package_dir/.cache/node-v${node_version}-darwin-${node_architecture}/bin/node"

verify_architecture() {
  local binary="$1"
  local actual
  actual="$(lipo -archs "$binary" 2>/dev/null || true)"
  if [ "$actual" != "$architecture" ]; then
    echo "Unexpected architecture for $binary: ${actual:-unknown} (expected $architecture)" >&2
    exit 1
  fi
}

cd "$project_root"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS installer builds require macOS." >&2
  exit 1
fi
if [ "$architecture" != "arm64" ] && [ "$architecture" != "x86_64" ]; then
  echo "Unsupported macOS architecture: $architecture" >&2
  exit 1
fi

mkdir -p \
  "$package_dir/.cache" \
  "$package_dir/.cache/$architecture" \
  "$package_dir/.module-cache/$architecture" \
  "$package_dir/.swiftpm-config" \
  "$package_dir/.swiftpm-security" \
  "$(dirname "$node_cache")" \
  "$installer_dir"

if [ "${REMOTE_CODEX_SKIP_APP_BUILD:-false}" != "true" ]; then
  npm run build
fi
TARGET_ARCH="$architecture" \
REMOTE_CODEX_NATIVE_BUILD_DIR="$capture_build" \
  npm run build:native:macos

export SWIFTPM_MODULECACHE_OVERRIDE="$package_dir/.module-cache/$architecture"
export CLANG_MODULE_CACHE_PATH="$package_dir/.module-cache/$architecture"
swift_options=(
  -c release \
  --arch "$architecture" \
  --package-path "$package_dir" \
  --cache-path "$package_dir/.cache/$architecture" \
  --config-path "$package_dir/.swiftpm-config" \
  --security-path "$package_dir/.swiftpm-security" \
  --scratch-path "$swift_build" \
  --manifest-cache local \
  --disable-sandbox
)
swift build "${swift_options[@]}"
swift_binary_dir="$(swift build "${swift_options[@]}" --show-bin-path)"

if [ -n "${REMOTE_CODEX_NODE_BINARY:-}" ]; then
  node_binary="$REMOTE_CODEX_NODE_BINARY"
else
  "$project_root/scripts/download-node-macos.sh" \
    --version "$node_version" \
    --arch "$architecture" \
    --output "$node_cache"
  node_binary="$node_cache"
fi
verify_architecture "$node_binary"

rm -rf "$build_root"
mkdir -p "$contents/MacOS" "$runtime" "$runtime_app" "$resources/scripts"

"$project_root/scripts/generate-app-icon.sh" \
  "$package_dir/Resources/AppIcon.png" \
  "$resources/AppIcon.icns"

install -m 755 "$swift_binary_dir/my-remote-codex-host" "$contents/MacOS/my-remote-codex-host"
install -m 644 "$package_dir/Resources/Info.plist" "$contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$contents/Info.plist"
install -m 755 "$node_binary" "$runtime/node"
strip -S "$runtime/node"
install -m 755 "$project_root/scripts/launch-codex-macos.sh" "$resources/scripts/launch-codex-macos.sh"

/usr/bin/ditto "$project_root/dist/client" "$runtime_app/dist/client"
/usr/bin/ditto "$project_root/dist/server" "$runtime_app/dist/server"
/usr/bin/ditto "$project_root/node_modules" "$runtime_app/node_modules"
install -m 644 "$project_root/package.json" "$runtime_app/package.json"
install -m 644 "$project_root/package-lock.json" "$runtime_app/package-lock.json"
npm prune --omit=dev --ignore-scripts --prefix "$runtime_app"
find "$runtime_app/node_modules" -type f \
  \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) \
  -delete
find "$runtime_app/dist" -type f -name '*.map' -delete
rm -f "$runtime_app/package-lock.json"

/usr/bin/ditto "$capture_app" "$resources/My Remote Codex Capture.app"
if [ -n "${REMOTE_CODEX_FRPC_BINARY:-}" ]; then
  [ "$("$REMOTE_CODEX_FRPC_BINARY" --version)" = "0.71.0" ] || {
    echo "REMOTE_CODEX_FRPC_BINARY must be frpc v0.71.0" >&2
    exit 1
  }
  install -m 755 "$REMOTE_CODEX_FRPC_BINARY" "$runtime/frpc"
else
  "$project_root/scripts/setup-frp.sh" download \
    --binary frpc \
    --os Darwin \
    --arch "$architecture" \
    --output "$frpc_cache"
  install -m 755 "$frpc_cache" "$runtime/frpc"
fi

verify_architecture "$contents/MacOS/my-remote-codex-host"
verify_architecture "$runtime/node"
verify_architecture "$runtime/frpc"
verify_architecture "$resources/My Remote Codex Capture.app/Contents/MacOS/remote-codex-capture"

sign_options=(--force --sign "$identity")
if [ "$identity" != "-" ]; then
  sign_options+=(--options runtime --timestamp)
fi
node_sign_options=("${sign_options[@]}")
if [ "$identity" != "-" ]; then
  node_sign_options+=(--entitlements "$package_dir/Resources/Node.entitlements")
fi
codesign "${node_sign_options[@]}" "$runtime/node"
codesign "${sign_options[@]}" "$runtime/frpc"
codesign "${sign_options[@]}" "$resources/My Remote Codex Capture.app"
codesign "${sign_options[@]}" "$app_path"
codesign --verify --deep --strict "$app_path"

package_root="$build_root/pkg-root"
mkdir -p "$package_root/Applications"
/usr/bin/ditto "$app_path" "$package_root/Applications/My Remote Codex.app"
pkg_options=(
  --root "$package_root"
  --install-location /
  --component-plist "$component_plist"
  --identifier com.myremotecodex.host
  --version "$version"
)
if [ -n "$installer_identity" ]; then
  pkg_options+=(--sign "$installer_identity")
fi
rm -f "$pkg_path"
pkgbuild "${pkg_options[@]}" "$pkg_path"

dmg_stage="$build_root/dmg"
mkdir -p "$dmg_stage"
/usr/bin/ditto "$app_path" "$dmg_stage/My Remote Codex.app"
ln -s /Applications "$dmg_stage/Applications"
rm -f "$dmg_path"
if hdiutil create \
    -volname "My Remote Codex" \
    -srcfolder "$dmg_stage" \
    -ov \
    -format UDZO \
    "$dmg_path"; then
  if [ "$identity" != "-" ]; then
    codesign --force --sign "$identity" --timestamp "$dmg_path"
    codesign --verify --strict --verbose=2 "$dmg_path"
  fi
  echo "Built $dmg_path"
else
  rm -f "$dmg_path"
  echo "Warning: this environment cannot create a DMG; the PKG installer is complete." >&2
fi

if [ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]; then
  [ "$identity" != "-" ] && [ -f "$dmg_path" ] || {
    echo "DMG notarization requires a Developer ID Application identity and a built DMG." >&2
    exit 1
  }
  xcrun notarytool submit "$dmg_path" --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" --wait
  xcrun stapler staple "$dmg_path"
  xcrun stapler validate "$dmg_path"

  if [ -n "$installer_identity" ]; then
    xcrun notarytool submit "$pkg_path" --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" --wait
    xcrun stapler staple "$pkg_path"
    xcrun stapler validate "$pkg_path"
  fi
fi

echo "Built $pkg_path"
