#!/bin/bash
# Keeps the family_share server running on this Mac: starts it at login and restarts it if it stops.
# Usage (from the project folder, after `npm run build`):
#   bash scripts/install-service.sh            install and start
#   bash scripts/install-service.sh --print    only print the launchd plist
#   bash scripts/install-service.sh --remove   stop and remove
set -euo pipefail

LABEL="com.familyshare.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cd "$(dirname "$0")/.."
DIR="$(pwd)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已停止并移除 / stopped and removed ($LABEL)"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node not found on PATH (install Node 24: brew install node@24)" >&2
  exit 1
fi
if [ ! -f "$DIR/dist/server/index.js" ]; then
  echo "dist/server/index.js not found — run: npm run build" >&2
  exit 1
fi
if [ ! -f "$DIR/.env" ]; then
  echo ".env not found in $DIR — copy .env.example to .env and fill it in first" >&2
  exit 1
fi

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
X_DIR="$(printf '%s' "$DIR" | xml)"
X_NODE="$(printf '%s' "$NODE" | xml)"
LOG="$X_DIR/data/logs/server.log"

PLIST_XML="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$X_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$X_NODE</string>
    <string>$X_DIR/dist/server/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>"

if [ "${1:-}" = "--print" ]; then
  printf '%s\n' "$PLIST_XML"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data/logs"
chmod 700 "$DIR/data"
printf '%s\n' "$PLIST_XML" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
echo "已启动 / started ($LABEL). 日志 / log: $DIR/data/logs/server.log"
tail -n 12 "$DIR/data/logs/server.log" 2>/dev/null || true
