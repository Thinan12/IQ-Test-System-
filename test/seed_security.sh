#!/bin/bash
# Seed hardening: DEMO_PASSWORD must be supplied, must meet the production
# password policy, must never be printed, and the whole seed must be one
# transaction. Runs entirely against throwaway databases.
cd "$(dirname "$0")/.." || exit 1
source test/lib.sh

# This suite never starts a server, so the values start_server would normally
# export are set here instead.
export JWT_SECRET="${JWT_SECRET:-seed-suite-secret-0123456789abcdef}"
NATIVE_BACKEND="$(native_path "$BACKEND_DIR")"
WEAK_DEFAULT='ChangeMe123!'
STRONG='Seed-Test-Passw0rd!2026'

# run_seed <db-path> <DEMO_PASSWORD value ("" = unset)> [extra env]  -> writes
# stdout+stderr to $SEED_OUT and returns the exit code.
run_seed() {
  local dbfile="$1" pw="$2" extra="$3"
  local dir; dir="$(mktemp -d)"
  SEED_DB="$(native_path "$dir")/$dbfile"
  SEED_OUT="$dir/out.txt"
  SEED_DIR="$dir"
  if [ -z "$pw" ]; then
    ( cd "$dir" && env -u DEMO_PASSWORD DATABASE_PATH="$SEED_DB" JWT_SECRET="$JWT_SECRET" $extra \
        "$NODE" "$NATIVE_BACKEND/src/seed.js" ) > "$SEED_OUT" 2>&1
  else
    ( cd "$dir" && DEMO_PASSWORD="$pw" DATABASE_PATH="$SEED_DB" JWT_SECRET="$JWT_SECRET" $extra \
        "$NODE" "$NATIVE_BACKEND/src/seed.js" ) > "$SEED_OUT" 2>&1
  fi
  return $?
}

count() { # count <table>
  ( cd "$BACKEND_DIR" && "$NODE" -e "
    const D=require('better-sqlite3');
    let db; try { db=new D(process.argv[1],{readonly:true,fileMustExist:true}); } catch(e){ console.log('NODB'); process.exit(0); }
    try { console.log(db.prepare('SELECT COUNT(*) c FROM '+process.argv[2]).get().c); } catch(e){ console.log('NOTABLE'); }
  " "$SEED_DB" "$1" )
}

c_head "A. A weak or publicly known DEMO_PASSWORD is rejected"
run_seed weak.db "$WEAK_DEFAULT"; RC=$?
expect_eq "seeding with the published default exits non-zero" 1 "$RC"
expect_contains "it says the policy was not met" 'does not meet the password policy' "$(cat "$SEED_OUT")"
expect_contains "it names the reason" 'publicly known' "$(cat "$SEED_OUT")"
expect_contains "it states nothing was written" 'Nothing was written' "$(cat "$SEED_OUT")"
expect_eq "NO users row was created" "NODB" "$(count users)"
rm -rf "$SEED_DIR"

run_seed short.db 'Sh0rt!'; RC=$?
expect_eq "a too-short password is rejected" 1 "$RC"
expect_contains "and the length rule is quoted" 'at least 14 characters' "$(cat "$SEED_OUT")"
expect_eq "still no database rows" "NODB" "$(count users)"
rm -rf "$SEED_DIR"

run_seed classes.db 'alllowercaseonlypassword'; RC=$?
expect_eq "a single-character-class password is rejected" 1 "$RC"
expect_contains "and the class rule is quoted" 'at least 3 of' "$(cat "$SEED_OUT")"
rm -rf "$SEED_DIR"

run_seed named.db 'Superadmin-Passw0rd!'; RC=$?
expect_eq "a password echoing an account name is rejected" 1 "$RC"
rm -rf "$SEED_DIR"

c_head "A2. An unset DEMO_PASSWORD aborts rather than falling back to a default"
run_seed unset.db ""; RC=$?
expect_eq "seeding with DEMO_PASSWORD unset exits non-zero" 1 "$RC"
expect_contains "it says the variable is not set" 'DEMO_PASSWORD is not set' "$(cat "$SEED_OUT")"
expect_contains "it states no default exists" 'no default' "$(cat "$SEED_OUT")"
expect_eq "no database was created" "NODB" "$(count users)"
rm -rf "$SEED_DIR"

expect_eq "no hardcoded password remains anywhere in src/" 0 "$(grep -rc 'ChangeMe123' src/ 2>/dev/null | grep -v ':0' | wc -l)"

c_head "B + F. A strong DEMO_PASSWORD is accepted and seeds the reference data"
run_seed good.db "$STRONG"; RC=$?
expect_eq "seeding succeeds" 0 "$RC"
expect_eq "6 admin accounts created" 6 "$(count users)"
expect_eq "7 questions created" 7 "$(count questions)"
expect_eq "interview questions created" 4 "$(count interview_questions)"
expect_eq "interview criteria created" 4 "$(count interview_criteria)"
expect_eq "scholarship policies created" 4 "$(count scholarship_policies)"
expect_eq "eligibility rules row exists" 1 "$(count eligibility_rules)"
expect_eq "settings row exists" 1 "$(count settings)"
expect_eq "NO candidates were invented" 0 "$(count candidates)"
expect_contains "it reports the accounts without the password" 'admin accounts' "$(cat "$SEED_OUT")"

c_head "C. The seeded password satisfies the production policy and is bcrypt-hashed"
POLICY=$( cd "$BACKEND_DIR" && "$NODE" -e "
  const p=require('./src/lib/passwordPolicy');
  console.log(p.validatePassword(process.argv[1], {email:'superadmin@lalco.demo'}).ok ? 'ok' : 'rejected');
" "$STRONG")
expect_eq "the accepted password passes the same policy the reset workflow uses" "ok" "$POLICY"
HASHES=$( cd "$BACKEND_DIR" && "$NODE" -e "
  const D=require('better-sqlite3'); const db=new D(process.argv[1],{readonly:true});
  const rows=db.prepare('SELECT password_hash FROM users').all();
  console.log(rows.every(r=>/^\\\$2[aby]\\\$/.test(r.password_hash)) ? 'all-bcrypt' : 'NOT-BCRYPT');
" "$SEED_DB")
expect_eq "every stored password is a bcrypt hash" "all-bcrypt" "$HASHES"
PLAIN=$( cd "$BACKEND_DIR" && "$NODE" -e "
  const D=require('better-sqlite3'); const db=new D(process.argv[1],{readonly:true});
  console.log(db.prepare('SELECT COUNT(*) c FROM users WHERE password_hash = ?').get(process.argv[2]).c);
" "$SEED_DB" "$STRONG")
expect_eq "no row stores the password in plaintext" 0 "$PLAIN"

c_head "D. Nothing secret reaches stdout or stderr"
expect_not_contains "the password is never printed" "$STRONG" "$(cat "$SEED_OUT")"
expect_not_contains "no bcrypt hash is printed" '\$2b\$' "$(cat "$SEED_OUT")"
expect_not_contains "the old wording that leaked the password is gone" 'Password for all' "$(cat "$SEED_OUT")"
expect_not_contains "the JWT secret is never printed" "$JWT_SECRET" "$(cat "$SEED_OUT")"
SEED_KEEP="$SEED_DIR"

c_head "E. The seed is a single transaction — a mid-seed failure rolls everything back"
# interview_criteria.key is UNIQUE, and seedInterview guards only on
# interview_questions. Pre-seeding one criterion makes the criteria INSERT throw
# part-way through, after users would already have been written.
run_seed rollback.db "$STRONG" "SEED_FORCE_NOOP=1"
rm -f "$SEED_DB"
( cd "$BACKEND_DIR" && "$NODE" -e "
  const D=require('better-sqlite3'); const fs=require('fs'); const path=require('path');
  fs.mkdirSync(path.dirname(process.argv[1]), {recursive:true});
  const db=new D(process.argv[1]);
  db.exec(fs.readFileSync('src/schema.sql','utf8'));
  db.prepare('INSERT INTO interview_criteria (id,key,label,max_marks,hint,order_index) VALUES (?,?,?,?,?,?)')
    .run('pre_existing','communication','Pre-existing clash',10,'',1);
" "$SEED_DB" )
BEFORE_USERS=$(count users)
( cd "$SEED_DIR" && DEMO_PASSWORD="$STRONG" DATABASE_PATH="$SEED_DB" JWT_SECRET="$JWT_SECRET" \
    "$NODE" "$NATIVE_BACKEND/src/seed.js" ) > "$SEED_OUT" 2>&1
RC=$?
expect_eq "users table was empty before the failing seed" 0 "$BEFORE_USERS"
expect_eq "the failing seed exits non-zero" 1 "$RC"
expect_contains "it reports a rollback" 'rolled back' "$(cat "$SEED_OUT")"
expect_eq "NO users survived the rolled-back seed" 0 "$(count users)"
expect_eq "NO questions survived the rolled-back seed" 0 "$(count questions)"
expect_eq "the pre-existing row is untouched" 1 "$(count interview_criteria)"
rm -rf "$SEED_DIR" "$SEED_KEEP"

c_head "F2. Re-running a successful seed stays idempotent"
run_seed idem.db "$STRONG" > /dev/null 2>&1
FIRST_USERS=$(count users)
( cd "$SEED_DIR" && DEMO_PASSWORD="$STRONG" DATABASE_PATH="$SEED_DB" JWT_SECRET="$JWT_SECRET" \
    "$NODE" "$NATIVE_BACKEND/src/seed.js" ) > "$SEED_OUT" 2>&1
expect_eq "re-running does not duplicate users" "$FIRST_USERS" "$(count users)"
expect_eq "re-running does not duplicate questions" 7 "$(count questions)"
expect_contains "it reports questions as already seeded" 'already seeded' "$(cat "$SEED_OUT")"
rm -rf "$SEED_DIR"

summary "SEED SECURITY"
