#!/usr/bin/env bash
# Runs the protocol tests in headless Chrome. No installs, no network beyond localhost.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8765}"
PROFILE="$ROOT/test/.chrome-profile"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$PROFILE"' EXIT
sleep 1

google-chrome --headless=new --disable-gpu --no-first-run --user-data-dir="$PROFILE" \
  --virtual-time-budget=5000 --dump-dom "http://127.0.0.1:$PORT/test/index.html" 2>/dev/null \
  | sed -n '/<pre id="out">/,/<\/pre>/p' | sed -e 's/<[^>]*>//g' -e 's/&gt;/>/g' -e 's/&lt;/</g' -e 's/&amp;/\&/g' \
  | tee /dev/stderr | grep -q 'PASSED'
