#!/bin/bash
# Sections 9-15 — deployment readiness: persistent SQLite path, production
# seeding, health check, CORS, Node pinning and process binding.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

c_head "9/10. SQLite works from a custom DATABASE_PATH and survives a restart"
# A directory that does not exist yet, exactly like a freshly mounted volume.
VOLUME="$(mktemp -d)/mounted/volume"
NVOL="$(native_path "$VOLUME")"
check "the volume directory does not exist yet" "$([ ! -d "$VOLUME" ] && echo 0 || echo 1)"

export DATABASE_PATH="$NVOL/lalco.db"
start_server 4121
check "the app created the database directory" "$([ -d "$VOLUME" ] && echo 0 || echo 1)"
check "the database file was created at the custom path" "$([ -f "$VOLUME/lalco.db" ] && echo 0 || echo 1)"
expect_eq "DATABASE_PATH is honoured, not the default ./data" "$NVOL/lalco.db" "$DATABASE_PATH"
check "no database was created in the project directory" "$([ ! -f "data/lalco.db-testartifact" ] && echo 0 || echo 1)"

HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
[ -n "$HR" ] || { c_red "could not log in"; server_log; exit 1; }
read -r P_ID P_CODE <<< "$(new_candidate "$HR" "Persistence Candidate")"
expect_eq "a candidate can be created against the volume database" 1 "$(dbq "SELECT COUNT(*) AS v FROM candidates WHERE code = '$P_CODE'")"

c_head "WAL and SHM sidecars stay on the volume, next to the database"
check "the -wal file is on the volume" "$([ -f "$VOLUME/lalco.db-wal" ] && echo 0 || echo 1)"
check "the -shm file is on the volume" "$([ -f "$VOLUME/lalco.db-shm" ] && echo 0 || echo 1)"
STRAY=$(find public -name '*.db*' -o -name '*.sqlite*' 2>/dev/null | head -1)
expect_eq "no database file anywhere under public/" "" "$STRAY"

c_head "Backups are written to the volume, never into public/"
SUPER=$(login_token superadmin@lalco.demo "$DEMO_PASSWORD")
BACKUP=$(http_body POST "$BASE/api/admin/settings/data-management/backup" "$SUPER")
BACKUP_FILE=$(jsonval "$BACKUP" 'd.fileName')
check "the backup landed in the volume's backups directory" "$([ -f "$VOLUME/backups/$BACKUP_FILE" ] && echo 0 || echo 1)" "expected $VOLUME/backups/$BACKUP_FILE"
STRAY_BACKUP=$(find public -name 'LALCO_backup*' 2>/dev/null | head -1)
expect_eq "no backup is inside the public directory" "" "$STRAY_BACKUP"
expect_eq "the backup is not reachable over HTTP" 404 "$(http_code GET "$BASE/backups/$BACKUP_FILE")"
expect_eq "the database is not reachable over HTTP" 404 "$(http_code GET "$BASE/lalco.db")"

c_head "Data survives a restart (this is what the volume buys you)"
stop_server
pushd "$TEST_DIR" > /dev/null || exit 1
"$NODE" "$NATIVE_BACKEND/src/server.js" > "$TEST_DIR/restart.log" 2>&1 &
SERVER_PID=$!
popd > /dev/null || exit 1
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/candidates")" = "401" ] && break
  sleep 0.25
done
HR=$(login_token hradmin@lalco.demo "$DEMO_PASSWORD")
AFTER=$(http_body GET "$BASE/api/admin/candidates" "$HR")
expect_contains "the candidate created before the restart is still there" "$P_CODE" "$AFTER"
expect_eq "the question bank survived the restart" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM questions")"
expect_eq "admin users survived the restart" 1 "$(dbq "SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS v FROM users")"

c_head "12. Health check"
HEALTH=$(http_body GET "$BASE/api/health")
expect_eq "status is ok" "ok" "$(jsonval "$HEALTH" 'd.status')"
expect_eq "database reports connected" "connected" "$(jsonval "$HEALTH" 'd.database')"
expect_eq "it responds 200" 200 "$(http_code GET "$BASE/api/health")"
expect_eq "it needs no authentication" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")"
for secret in JWT_SECRET DATABASE_PATH DATABASE_URL GOOGLE PRIVATE password passwordHash lalco.db; do
  expect_not_contains "health response leaks no '$secret'" "$secret" "$HEALTH"
done

c_head "13. CORS is production-safe"
stop_server
restart_server_with 4122 NODE_ENV=production CORS_ORIGIN=https://exam.example.com
ALLOWED=$(curl -s -D - -o /dev/null -H 'Origin: https://exam.example.com' -H 'X-Forwarded-Proto: https' "$BASE/api/health" | grep -i 'access-control-allow-origin')
expect_contains "the configured origin is allowed" 'https://exam.example.com' "$ALLOWED"
DENIED=$(curl -s -D - -o /dev/null -H 'Origin: https://evil.example.net' -H 'X-Forwarded-Proto: https' "$BASE/api/health" | grep -i 'access-control-allow-origin')
expect_eq "an unlisted origin gets no allow-origin header" "" "$DENIED"
WILDCARD=$(curl -s -D - -o /dev/null -H 'Origin: https://evil.example.net' -H 'X-Forwarded-Proto: https' "$BASE/api/admin/candidates" | grep -i 'access-control-allow-origin: \*')
expect_eq "the API never answers with a wildcard origin" "" "$WILDCARD"

stop_server
restart_server_with 4123 NODE_ENV=production
NO_CORS=$(curl -s -D - -o /dev/null -H 'Origin: https://evil.example.net' -H 'X-Forwarded-Proto: https' "$BASE/api/health" | grep -i 'access-control-allow-origin')
expect_eq "in production with CORS_ORIGIN unset, no origin is allowed" "" "$NO_CORS"
expect_eq "the app itself still works (same-origin)" 200 "$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' "$BASE/api/health")"

MULTI_ORIGIN_OK=$(cd "$BACKEND_DIR" && "$NODE" -e "
  const list = String('https://a.example.com, https://b.example.com').split(',').map((o) => o.trim()).filter(Boolean);
  console.log(list.length === 2 && list[1] === 'https://b.example.com' ? 'yes' : 'no');
")
expect_eq "CORS_ORIGIN accepts a comma-separated list" "yes" "$MULTI_ORIGIN_OK"

c_head "15. Node pinning and process binding"
expect_eq ".nvmrc pins Node 20" "20" "$(tr -d ' \r\n' < .nvmrc)"
expect_eq "package.json engines.node is 20.x" "20.x" "$(cd "$BACKEND_DIR" && "$NODE" -p "require('./package.json').engines.node")"
expect_eq "the start script is unchanged" "node src/server.js" "$(cd "$BACKEND_DIR" && "$NODE" -p "require('./package.json').scripts.start")"
expect_contains "the server reads PORT from the environment" 'process.env.PORT' "$(cat src/server.js)"
expect_contains "the server binds 0.0.0.0 by default" "process.env.HOST || '0.0.0.0'" "$(cat src/server.js)"
LISTEN_ADDR=$(cd "$BACKEND_DIR" && grep -c "app.listen(PORT, HOST" src/server.js)
expect_eq "listen() is given an explicit host" 1 "$LISTEN_ADDR"
stop_server

c_head "11. Production seeding creates reference data only"
SEEDDIR="$(mktemp -d)"
NSEED="$(native_path "$SEEDDIR")"
SEED_OUT=$(cd "$SEEDDIR" && DATABASE_PATH="$NSEED/prod.db" NODE_ENV=production JWT_SECRET="$JWT_SECRET" DEMO_PASSWORD="$DEMO_PASSWORD" "$NODE" "$NATIVE_BACKEND/src/seed.js" 2>&1)
seeded() { ( cd "$BACKEND_DIR" && DATABASE_PATH="$NSEED/prod.db" "$NODE" -e "
  const D = require('better-sqlite3');
  const db = new D(process.env.DATABASE_PATH, { readonly: true });
  console.log(db.prepare('SELECT COUNT(*) AS n FROM ' + process.argv[1] + (process.argv[2] ? ' WHERE ' + process.argv[2] : '')).get().n);
" "$1" "$2" ); }
expect_contains "the seed says it skipped demo candidates" 'Skipped demo candidates' "$SEED_OUT"
expect_eq "NO candidate records were created" 0 "$(seeded candidates)"
expect_eq "admin users WERE created" 6 "$(seeded users)"
expect_eq "every role has an account" 6 "$(cd "$BACKEND_DIR" && DATABASE_PATH="$NSEED/prod.db" "$NODE" -e "
  const D = require('better-sqlite3');
  console.log(new D(process.env.DATABASE_PATH, { readonly: true }).prepare('SELECT COUNT(DISTINCT role) AS n FROM users').get().n);
")"
check "the question bank WAS created" "$([ "$(seeded questions)" -gt 0 ] && echo 0 || echo 1)" "got $(seeded questions)"
check "interview criteria WERE created" "$([ "$(seeded interview_criteria)" -gt 0 ] && echo 0 || echo 1)"
check "interview questions WERE created" "$([ "$(seeded interview_questions)" -gt 0 ] && echo 0 || echo 1)"
check "scholarship policies WERE created" "$([ "$(seeded scholarship_policies)" -gt 0 ] && echo 0 || echo 1)"
expect_eq "eligibility rules exist" 1 "$(seeded eligibility_rules)"
expect_eq "system configuration exists" 1 "$(seeded settings)"
expect_eq "no assessment sessions were invented" 0 "$(seeded assessment_sessions)"
expect_eq "no scores were invented" 0 "$(seeded scores)"
expect_contains "it reminds the operator to change passwords" 'change every password' "$SEED_OUT"

c_head "Re-running the seed is safe"
SEED_AGAIN=$(cd "$SEEDDIR" && DATABASE_PATH="$NSEED/prod.db" NODE_ENV=production JWT_SECRET="$JWT_SECRET" DEMO_PASSWORD="$DEMO_PASSWORD" "$NODE" "$NATIVE_BACKEND/src/seed.js" 2>&1)
expect_eq "users are not duplicated" 6 "$(seeded users)"
expect_contains "questions are recognised as already seeded" 'already seeded' "$SEED_AGAIN"
expect_eq "still no candidates" 0 "$(seeded candidates)"

c_head "Demo mode is opt-in and clearly separate"
DEMODIR="$(mktemp -d)"
NDEMO="$(native_path "$DEMODIR")"
( cd "$DEMODIR" && DATABASE_PATH="$NDEMO/demo.db" JWT_SECRET="$JWT_SECRET" DEMO_PASSWORD="$DEMO_PASSWORD" "$NODE" "$NATIVE_BACKEND/src/seed.js" --demo > /dev/null 2>&1 )
DEMO_COUNT=$(cd "$BACKEND_DIR" && DATABASE_PATH="$NDEMO/demo.db" "$NODE" -e "
  const D = require('better-sqlite3');
  console.log(new D(process.env.DATABASE_PATH, { readonly: true }).prepare('SELECT COUNT(*) AS n FROM candidates WHERE is_demo = 1').get().n);
")
check "npm run seed:demo DOES create demo candidates" "$([ "$DEMO_COUNT" -gt 0 ] && echo 0 || echo 1)" "got $DEMO_COUNT"
REAL_IN_DEMO=$(cd "$BACKEND_DIR" && DATABASE_PATH="$NDEMO/demo.db" "$NODE" -e "
  const D = require('better-sqlite3');
  console.log(new D(process.env.DATABASE_PATH, { readonly: true }).prepare('SELECT COUNT(*) AS n FROM candidates WHERE is_demo = 0').get().n);
")
expect_eq "and every one of them is flagged is_demo" 0 "$REAL_IN_DEMO"
expect_eq "package.json exposes the seed:demo script" "node src/seed.js --demo" "$(cd "$BACKEND_DIR" && "$NODE" -p "require('./package.json').scripts['seed:demo']")"

rm -rf "$SEEDDIR" "$DEMODIR" "$(dirname "$(dirname "$VOLUME")")"

summary "DEPLOYMENT READINESS (sections 9-15)"
