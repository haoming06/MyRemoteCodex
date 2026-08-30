#!/bin/bash

set -Eeuo pipefail

CDP_PORT="${REMOTE_CODEX_CDP_PORT:-9341}"
EXPECTED_TEAM_ID="2DC432GLL2"
CODEX_BUNDLE=""

case "$CDP_PORT" in
  ''|*[!0-9]*) echo "Invalid CDP port: $CDP_PORT" >&2; exit 1 ;;
esac
if [ "$CDP_PORT" -lt 1024 ] || [ "$CDP_PORT" -gt 65535 ]; then
  echo "CDP port must be between 1024 and 65535." >&2
  exit 1
fi

for candidate in \
  "/Applications/ChatGPT.app" \
  "$HOME/Applications/ChatGPT.app" \
  "/Applications/Codex.app" \
  "$HOME/Applications/Codex.app"; do
  if [ -f "$candidate/Contents/Info.plist" ]; then
    identifier="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$candidate/Contents/Info.plist" 2>/dev/null || true)"
    if [ "$identifier" = "com.openai.codex" ]; then
      CODEX_BUNDLE="$candidate"
      break
    fi
  fi
done

if [ -z "$CODEX_BUNDLE" ]; then
  echo "Could not find the official Codex/ChatGPT desktop app." >&2
  exit 1
fi

team_id="$(/usr/bin/codesign -dv --verbose=4 "$CODEX_BUNDLE" 2>&1 | /usr/bin/awk -F= '/^TeamIdentifier=/{print $2; exit}')"
if [ "$team_id" != "$EXPECTED_TEAM_ID" ]; then
  echo "Unexpected app signature Team ID: ${team_id:-missing}" >&2
  exit 1
fi

executable_name="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$CODEX_BUNDLE/Contents/Info.plist")"
executable="$CODEX_BUNDLE/Contents/MacOS/$executable_name"
if /usr/bin/pgrep -f "$executable" >/dev/null 2>&1; then
  echo "Codex is already running. Close it cleanly before launching CDP mode." >&2
  exit 2
fi

echo "Launching $CODEX_BUNDLE with CDP on 127.0.0.1:$CDP_PORT"
/usr/bin/open -na "$CODEX_BUNDLE" --args \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CDP_PORT"
