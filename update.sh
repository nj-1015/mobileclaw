#!/bin/bash
# MobileClaw — update from archive pushed via ADB
# Usage: bash update.sh
#
# Also used for first install:
#   cd ~/mobileclaw && bash update.sh

set -e

cd "$(dirname "$0")"

ARCHIVE="/sdcard/Download/mobileclaw-repo.tar.gz"

# Clean up legacy zip format
rm -f /sdcard/Download/mobileclaw-repo.zip 2>/dev/null || true

if [ ! -f "$ARCHIVE" ]; then
  echo "No update found at $ARCHIVE"
  echo ""
  echo "From your PC:"
  echo "  adb push mobileclaw-repo.tar.gz /sdcard/Download/"
  echo "Then run this script again."
  exit 1
fi

echo "=== MobileClaw Update ==="

# Stop running instance
pkill -f "node dist/index.js" 2>/dev/null || true
sleep 1

# Remove directories that tar will recreate (avoids permission errors
# from stale dirs left by earlier broken zip extractions)
rm -rf .claude/skills container/skills 2>/dev/null || true

# Clear cached agent-runner copies so new pre-compiled JS is picked up
rm -rf data/sessions/*/agent-runner-src 2>/dev/null || true

# Extract update
echo "Extracting..."
tar xzf "$ARCHIVE"
rm -f "$ARCHIVE"
echo "[ok] Files updated"

# Rebuild (start.sh handles deps + build + launch)
echo ""
exec bash start.sh
