#!/bin/bash
# MobileClaw — start script
# Usage: bash start.sh

set -e

cd "$(dirname "$0")"

echo ""
echo "=== MobileClaw ==="
echo ""

# 1. Check Claude auth
if [ ! -d "$HOME/.claude" ]; then
  echo "  Claude Code is not authenticated."
  echo "  Run:  claude login"
  exit 1
fi
echo "[ok] Claude auth"

# 2. Install dependencies if needed
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run)..."
  npm install --ignore-scripts 2>&1 | tail -1
fi
echo "[ok] Dependencies"

# 3. Build if source is newer than dist
if [ ! -f dist/index.js ] || [ "$(find src -newer dist/index.js -name '*.ts' 2>/dev/null | head -1)" ]; then
  echo "Building..."
  npm run build
fi
echo "[ok] Build"

# 4. Clear stale sessions (prevents "No conversation found" errors after rebuild)
if [ -f store/messages.db ]; then
  if command -v sqlite3 &>/dev/null; then
    sqlite3 store/messages.db "DELETE FROM sessions;" 2>/dev/null || true
  fi
  # If sqlite3 is not available, sessions will be stale but we do NOT delete
  # the entire DB — that would destroy registered groups and message history.
fi
echo "[ok] Sessions cleared"

# 5. Kill any existing instance
pkill -f "node dist/index.js" 2>/dev/null || true
sleep 1

# 6. Sync .env to container data dir
if [ -f .env ]; then
  mkdir -p data/env
  cp .env data/env/env
fi

# 7. Start
echo ""
echo "Starting MobileClaw..."
echo "  Web UI: http://localhost:3002"
echo ""
exec node dist/index.js
