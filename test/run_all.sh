#!/bin/bash
# Runs every verification suite. Each one uses its own throwaway database and
# its own port, so the real data/lalco.db is never touched.
#
#   ./test/run_all.sh
#   NODE=/path/to/node ./test/run_all.sh    # if `node` on PATH is the wrong ABI
cd "$(dirname "$0")/.." || exit 1
export NODE="${NODE:-node}"

SUITES=(
  "e2e_test.sh:Core assessment workflow (regression, section 22)"
  "test/ui_actions.sh:UI / button action audit (all controls)"
  "test/admin_controls.sh:Candidate, link, exam-time and user controls (P1-P5, P10)"
  "test/ui_browser.sh:Real browser UI test (P13)"
  "test/hardening.sh:Production hardening (passwords, JWT rotation, custom LALCO ID)"
  "test/seed_security.sh:Seed security (DEMO_PASSWORD policy, transactional seed)"
  "test/bilingual.sh:Bilingual question bank + candidate language switch"
  "test/security_check.sh:Security verification (section 16)"
  "test/auto_submit.sh:Auto-submit on time expiry (sections 1-8)"
  "test/deployment.sh:Deployment readiness (sections 9-15)"
  "test/multi_candidate.sh:Multi-candidate isolation (section 19)"
  "test/mobile_markup.sh:Mobile markup + resume checks (section 20, static only)"
  "test/google_sync.sh:Google Sheets reporting + failure paths (sections 13-16)"
  "test/data_lifecycle.sh:Demo data + deletion lifecycle (section 21)"
)

OVERALL=0
RESULTS=()
for entry in "${SUITES[@]}"; do
  script="${entry%%:*}"; label="${entry#*:}"
  printf '\n\033[1m########## %s ##########\033[0m\n' "$label"
  if bash "$script"; then
    RESULTS+=("PASS  $label")
  else
    RESULTS+=("FAIL  $label")
    OVERALL=1
  fi
done

printf '\n\033[1m========== SUMMARY ==========\033[0m\n'
for r in "${RESULTS[@]}"; do
  case "$r" in
    PASS*) printf '\033[32m%s\033[0m\n' "$r" ;;
    *)     printf '\033[31m%s\033[0m\n' "$r" ;;
  esac
done
exit $OVERALL
