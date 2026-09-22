#!/bin/bash
# Priority 13 — real browser UI test. Skips cleanly if Playwright is absent.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

PW="${PLAYWRIGHT_MODULE:-}"
if [ -z "$PW" ] || [ ! -d "$PW" ]; then
  c_head "REAL BROWSER UI TEST"
  printf '  \033[33mSKIPPED\033[0m  Playwright not available.\n'
  printf '           Install it outside the project and re-run:\n'
  printf '             npm i playwright && npx playwright install chromium\n'
  printf '             PLAYWRIGHT_MODULE=/path/to/node_modules/playwright bash test/ui_browser.sh\n'
  exit 0
fi

start_server 4126
c_head "REAL BROWSER UI TEST (Chromium driving the actual admin interface)"
PLAYWRIGHT_MODULE="$PW" BASE_URL="$BASE" DATABASE_PATH="$DATABASE_PATH" \
  ADMIN_EMAIL=superadmin@lalco.demo ADMIN_PASSWORD="$DEMO_PASSWORD" \
  "$NODE" test/ui_browser.js
RESULT=$?
stop_server
exit $RESULT
