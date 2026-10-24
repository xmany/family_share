#!/bin/bash
# Runs scripts/backup.sh every night at 03:30 on this Mac (launchd): database and recordings backup, log rotation and,
# when AUDIO_KEEP_DAYS is set, deleting old recordings. It reads its settings from .env on every run, so changing
# BACKUP_DIR, BACKUP_KEEP_DAYS or AUDIO_KEEP_DAYS needs no reinstall. The server's own job is not touched.
# Usage (from the project folder):
#   bash scripts/install-backup.sh            back up once now, then install the nightly job
#   bash scripts/install-backup.sh --print    only print the launchd plist
#   bash scripts/install-backup.sh --remove   remove the nightly job (backups already made are kept)
set -euo pipefail

LABEL="com.familyshare.backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cd "$(dirname "$0")/.."
DIR="$(pwd)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已移除 / removed ($LABEL). 已有的备份没有删除 / existing backups were kept."
  exit 0
fi

# sqlite3 and rsync come with macOS; node is only needed for AUDIO_KEEP_DAYS (prune-audio)
JOB_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NODE="$(command -v node || true)"
if [ -n "$NODE" ]; then JOB_PATH="$(dirname "$NODE"):$JOB_PATH"; fi

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
X_DIR="$(printf '%s' "$DIR" | xml)"
X_PATH="$(printf '%s' "$JOB_PATH" | xml)"
LOG="$X_DIR/data/logs/backup.log"

PLIST_XML="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$X_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$X_DIR/scripts/backup.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$X_PATH</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>"

if [ "${1:-}" = "--print" ]; then
  printf '%s\n' "$PLIST_XML"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data/logs"
echo "先备份一次 / backing up once now:"
PATH="$JOB_PATH" /bin/bash "$DIR/scripts/backup.sh"
printf '%s\n' "$PLIST_XML" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已安装 / installed ($LABEL): 每天 03:30 备份 / runs daily at 03:30. 日志 / log: $DIR/data/logs/backup.log"
