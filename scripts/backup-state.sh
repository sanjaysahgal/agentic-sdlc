#!/bin/bash
# Block L1 backup script — daily snapshot of file-backed state.
# See docs/BACKUP_STRATEGY.md for the full strategy.
#
# Usage:
#   bash scripts/backup-state.sh
#
# Cron (daily at 03:00):
#   0 3 * * * cd /path/to/agentic-sdlc && bash scripts/backup-state.sh >> backups/backup.log 2>&1

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BACKUP_DIR="$REPO_ROOT/backups"
mkdir -p "$BACKUP_DIR"

DATE_TAG=$(date +%Y-%m-%d)
SNAPSHOT="$BACKUP_DIR/state-$DATE_TAG.tar.gz"

# Three state files. Missing files are tolerated (tar -cz with -h --ignore-failed-read).
FILES=(
  ".conversation-state.json"
  ".confirmed-agents.json"
  ".conversation-history.json"
)

PRESENT=()
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then PRESENT+=("$f"); fi
done

if [ ${#PRESENT[@]} -eq 0 ]; then
  echo "[backup] No state files present — nothing to snapshot. ($DATE_TAG)"
  exit 0
fi

tar -czf "$SNAPSHOT" "${PRESENT[@]}"
echo "[backup] Wrote $SNAPSHOT containing ${#PRESENT[@]} file(s): ${PRESENT[*]}"

# Retain 30 days; delete older snapshots.
find "$BACKUP_DIR" -name "state-*.tar.gz" -type f -mtime +30 -print -delete
echo "[backup] Retention pass: kept snapshots from the last 30 days."
