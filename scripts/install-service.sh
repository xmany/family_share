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
X_HOME="$(printf '%s' "$HOME" | xml)"
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
    <key>PATH</key><string>$X_HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
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
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns while the old server is still shutting down (it gives in-flight work up to 10 s), and launchd
# refuses to load a service it has not finished unloading: "Bootstrap failed: 5: Input/output error", which left
# the server stopped. So wait until the old one is gone (up to 30 s), and retry the load in case it still was not.
for _ in $(seq 1 150); do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.2
done
LOADED=0
for _ in 1 2 3 4 5; do
  if BOOT_ERR="$(launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1)"; then
    LOADED=1
    break
  fi
  sleep 2
done
if [ "$LOADED" != 1 ]; then
  printf '%s\n' "$BOOT_ERR" >&2
  echo "没有启动 / NOT started ($LABEL): 服务器现在是停着的，请再运行一次 / the server is stopped now, run this script again" >&2
  exit 1
fi
sleep 2
echo "已启动 / started ($LABEL). 日志 / log: $DIR/data/logs/server.log"
tail -n 12 "$DIR/data/logs/server.log" 2>/dev/null || true
