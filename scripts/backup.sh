#!/bin/bash
# Nightly maintenance for family_share, run at 03:30 by launchd (see scripts/install-backup.sh). Safe to run by hand.
#   1. Backs up the database with sqlite3 .backup (consistent while the server runs in WAL mode) and checks it.
#   2. Copies the voice recordings next to it. Recordings never change, so the ones already in the previous backup
#      become hard links to it and take no extra space.
#   3. Deletes backups older than BACKUP_KEEP_DAYS.
#   4. Rotates data/logs/*.log once a log passes 10 MB.
#   5. When AUDIO_KEEP_DAYS is set, deletes older recordings (npm run family -- prune-audio).
# Settings come from the environment, else .env, else these defaults:
#   BACKUP_DIR=~/Backups/family_share   BACKUP_KEEP_DAYS=14   AUDIO_KEEP_DAYS= (empty: keep every recording)
# Usage: bash scripts/backup.sh
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="$(pwd)"
# backups hold the family's data: readable by this account only
umask 077
LOG_MAX_BYTES=$((10 * 1024 * 1024))
LOG_KEEP=5
SNAPSHOT='[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]'

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() {
  echo "error: $*" >&2
  exit 1
}
STEP="settings"
trap 'rc=$?; [ $rc -eq 0 ] || log "失败 / FAILED: $STEP (exit $rc)" >&2' EXIT

# A KEY=value setting from .env read the way the server reads it: the last line wins, `export` and quotes are
# dropped, and an unquoted value ends at #.
dotenv() {
  [ -f .env ] || return 0
  local v
  v="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" .env | tail -n 1)"
  case "$v" in
    \"*) v="${v#\"}" && v="${v%%\"*}" ;;
    \'*) v="${v#\'}" && v="${v%%\'*}" ;;
    *) v="${v%%#*}" && v="${v%"${v##*[![:space:]]}"}" ;;
  esac
  printf '%s' "$v"
}
# setting NAME DEFAULT: the environment wins over .env
setting() {
  local v="${!1:-}"
  [ -n "$v" ] || v="$(dotenv "$1")"
  printf '%s' "${v:-$2}"
}
whole_days() { case "$1" in '' | *[!0-9]* | 0*) return 1 ;; esac; }

DATA="$(setting DATA_DIR ./data)"
BACKUP_DIR="$(setting BACKUP_DIR "$HOME/Backups/family_share")"
KEEP_DAYS="$(setting BACKUP_KEEP_DAYS 14)"
AUDIO_DAYS="$(setting AUDIO_KEEP_DAYS '')"
case "$BACKUP_DIR" in "~" | "~/"*) BACKUP_DIR="$HOME${BACKUP_DIR:1}" ;; esac
whole_days "$KEEP_DAYS" || die "BACKUP_KEEP_DAYS must be a whole number of days (got \"$KEEP_DAYS\")"
[ -z "$AUDIO_DAYS" ] || whole_days "$AUDIO_DAYS" ||
  die "AUDIO_KEEP_DAYS must be a whole number of days, or unset to keep every recording (got \"$AUDIO_DAYS\")"
for tool in sqlite3 rsync; do
  command -v "$tool" >/dev/null || die "$tool not found (PATH=$PATH)"
done
[ -d "$DATA" ] || die "data folder $DATA not found (DATA_DIR)"
DATA="$(cd "$DATA" && pwd)"
[ -f "$DATA/family.db" ] || die "no database at $DATA/family.db"
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

# Each backup is a folder named after its start time. It is built as NAME.partial and renamed when complete,
# so a folder without the suffix always holds a whole backup.
STEP="database backup"
NAME="$(date +%Y-%m-%d_%H%M%S)"
SNAP="$BACKUP_DIR/$NAME"
PART="$SNAP.partial"
PREV=""
for d in "$BACKUP_DIR"/$SNAPSHOT; do
  if [ -d "$d" ]; then PREV="$d"; fi # sorted, so the last one is the newest
done
# left by an interrupted run (one that is still running is minutes old)
find "$BACKUP_DIR" -maxdepth 1 -type d -name '*.partial' -mmin +1440 -exec rm -rf {} +
mkdir "$PART"
(cd "$PART" && sqlite3 -cmd ".timeout 10000" "$DATA/family.db" ".backup family.db")
# The copy keeps the server's WAL mode, which adds -wal/-shm files whenever it is opened; make it one plain file.
[ "$(sqlite3 "$PART/family.db" 'PRAGMA journal_mode=DELETE')" = delete ] || die "could not switch the backup out of WAL mode"
rm -f "$PART/family.db-shm"
CHECK="$(sqlite3 "$PART/family.db" 'PRAGMA integrity_check')"
[ "$CHECK" = ok ] || die "the backup failed PRAGMA integrity_check: $CHECK"

STEP="recordings backup"
FILES=0
if [ -d "$DATA/audio" ]; then
  if [ -n "$PREV" ] && [ -d "$PREV/audio" ]; then
    rsync -a --link-dest="$PREV/audio" "$DATA/audio/" "$PART/audio/"
  else
    rsync -a "$DATA/audio/" "$PART/audio/"
  fi
  FILES="$(find "$PART/audio" -type f | wc -l | tr -d ' ')"
fi
mv "$PART" "$SNAP"
log "备份完成 / backup ok: $SNAP (database $(du -h "$SNAP/family.db" | cut -f1 | tr -d ' '), $FILES recording files)"

STEP="deleting old backups"
# keep today and the KEEP_DAYS - 1 days before it
CUTOFF="$(date -v-"$((KEEP_DAYS - 1))"d +%Y-%m-%d 2>/dev/null || date -d "$((KEEP_DAYS - 1)) days ago" +%Y-%m-%d)"
for d in "$BACKUP_DIR"/$SNAPSHOT; do
  name="${d##*/}"
  if [ -d "$d" ] && [ "$d" != "$SNAP" ] && [[ "${name%%_*}" < "$CUTOFF" ]]; then
    rm -rf "$d"
    log "deleted backup $name (keeping the last $KEEP_DAYS days)"
  fi
done

STEP="log rotation"
# launchd keeps the logs open in append mode, so a log is copied and then emptied in place (a moved log would keep
# being written to). Lines written between the copy and the truncate are lost; at 03:30 there are none.
rotate_log() {
  local f="$1" i
  [ "$(($(wc -c <"$f")))" -ge "$LOG_MAX_BYTES" ] || return 0
  rm -f "$f.$LOG_KEEP.gz"
  for ((i = LOG_KEEP - 1; i >= 1; i--)); do
    if [ -f "$f.$i.gz" ]; then mv "$f.$i.gz" "$f.$((i + 1)).gz"; fi
  done
  cp -p "$f" "$f.1"
  : >"$f"
  gzip -f "$f.1"
  log "rotated ${f#"$DIR"/} (old copies: .1.gz to .$LOG_KEEP.gz)"
}
for f in "$DIR"/data/logs/*.log; do
  if [ -f "$f" ]; then rotate_log "$f"; fi
done

if [ -n "$AUDIO_DAYS" ]; then
  STEP="deleting recordings older than $AUDIO_DAYS days"
  [ -f dist/server/cli/family.js ] || die "AUDIO_KEEP_DAYS is set but dist/server/cli/family.js is missing: run npm run build"
  command -v node >/dev/null || die "AUDIO_KEEP_DAYS is set but node is not on PATH ($PATH)"
  OUT="$(node dist/server/cli/family.js prune-audio --days "$AUDIO_DAYS")" || die "prune-audio failed"
  log "$OUT"
fi
STEP="done"
