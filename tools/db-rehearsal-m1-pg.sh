#!/bin/bash
# Local rehearsal of db/m1_access.sql on a real, throwaway PostgreSQL 17 server (two real connections),
# for what PGlite can't show: the run label in pg_stat_activity (active, waiting on a lock, idle in
# transaction; gone after commit or rollback), two runs started together (exactly one commits), and the run
# record read from a separate connection (present only for the run that committed).
#   PG_BIN=/path/to/postgres17/bin tools/db-rehearsal-m1-pg.sh <format5-backup.json>
# The server listens on a Unix socket in a temporary directory only (no TCP), and is removed at the
# end. Output: pass/fail and counts only; never record contents.
set -u
BACKUP="${1:?usage: PG_BIN=… tools/db-rehearsal-m1-pg.sh <format5-backup.json>}"
: "${PG_BIN:?set PG_BIN to a PostgreSQL 17 bin directory}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/m1pg.XXXXXX")"
DATA="$WORK/data"; SOCK="$WORK/sock"; mkdir -p "$SOCK"
FAILED=0
ok() { if [ "$1" = 0 ]; then echo "  ok   $2"; else echo "  FAIL $2"; FAILED=$((FAILED + 1)); fi; }
cleanup() { "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
A=00000000-0000-4000-8000-00000000000a
DB=m1
PSQL() { "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCK" -U postgres -d "$DB" "$@"; }
Q() { PSQL -At -c "$1"; }

echo "[server]"
"$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null || exit 1
"$PG_BIN/pg_ctl" -D "$DATA" -o "-c listen_addresses='' -c unix_socket_directories='$SOCK' -c timezone=UTC" -l "$WORK/log" -w start >/dev/null || exit 1
"$PG_BIN/createdb" -h "$SOCK" -U postgres m1 || exit 1
ok $? "a throwaway server on a Unix socket only (listen_addresses empty)"

echo "[replica]"
for f in db/test/supabase_shim.sql db/test/replica_schema.sql db/phase0_restore_v1.sql db/phase1b_ownership.sql db/restore_backup.sql \
         db/phase1c_tv_schema.sql db/tv_model.sql db/rpc.sql db/admin/tv_enrich.sql; do PSQL -f "$ROOT/$f" >/dev/null || { echo "  FAIL $f"; exit 1; }; done
Q "update private.migration_stage set stage = 'final'" >/dev/null
for f in db/phase3b_org.sql db/phase3b2_org_write.sql db/phase4a_catalog.sql db/phase4b_add_to_show.sql db/phase5a_expand.sql db/phase5c_contract.sql; do
  PSQL -f "$ROOT/$f" >/dev/null || { echo "  FAIL $f"; exit 1; }; done
{ echo "select set_config('watchlist.b45_choices', '{\"shows\": {}, \"films\": {}}', false);"; cat "$ROOT/db/b45_expand.sql"; } | PSQL >/dev/null || { echo "  FAIL b45"; exit 1; }
Q "insert into auth.users (id, email) values ('$A', 'a@test.invalid')" >/dev/null
{ printf '\\set doc `cat %q`\n' "$BACKUP"; echo "begin; select set_config('request.jwt.claims', '', true), set_config('role', 'anon', true); select public.restore_backup(:'doc'::jsonb, false) is not null; commit;"; } | PSQL >/dev/null
ok $? "contracted-b45 replica holding the backup (restored as the pre-M1 page does)"
"$PG_BIN/createdb" -h "$SOCK" -U postgres -T m1 m1twin; ok $? "a copy of it for the two-runs check"
STATE0="$(Q "select md5(string_agg(x, '|' order by x)) from (select (to_jsonb(w) - 'user_id')::text x from public.watchlist_items w union all select (to_jsonb(s) - 'user_id')::text from public.tv_shows s) q")"
LABEL() { Q "select coalesce(string_agg(state || '/' || coalesce(wait_event_type, '-'), ','), 'absent') from pg_stat_activity where application_name = 'watchlist-m1-$1'"; }
APPLIED() { Q "select public.stage5_capabilities() ? 'access'"; }
# The run record as a separate connection sees it: 'none' when the table doesn't exist (yet) or lacks that id.
RUNREC() { if [ -z "$(Q "select to_regclass('private.migration_runs')")" ]; then echo none; else Q "select coalesce(string_agg(run_id, ','), 'none') from private.migration_runs where run_id = '$1'"; fi; }
pre() { echo "select set_config('watchlist.m1_owner', '$A', false), set_config('watchlist.m1_run', '$1', false);"; }
BODY="$(sed '/^commit;$/d' "$ROOT/db/m1_access.sql")"

echo "[label: idle in transaction, then rollback]"
mkfifo "$WORK/f1"
PSQL < "$WORK/f1" > "$WORK/s1.out" 2>&1 & P1=$!
exec 3> "$WORK/f1"
{ pre run-idle-1; echo "$BODY"; } >&3
for i in $(seq 1 60); do L="$(LABEL run-idle-1)"; [ "$L" = "idle in transaction/Client" ] && break; sleep 0.5; done
[ "$L" = "idle in transaction/Client" ]; ok $? "the label is visible while the transaction is idle in transaction (uncommitted): $L"
[ "$(APPLIED)" = "f" ]; ok $? "meanwhile a state read shows the old state (not decisive while the label is present)"
[ "$(RUNREC run-idle-1)" = "none" ]; ok $? "meanwhile no run record is visible to another connection (uncommitted)"
echo "rollback;" >&3; exec 3>&-; wait $P1
[ "$(LABEL run-idle-1)" = "absent" ]; ok $? "after rollback the label is gone"
[ "$(APPLIED)" = "f" ] && [ "$(Q "select md5(string_agg(x, '|' order by x)) from (select (to_jsonb(w) - 'user_id')::text x from public.watchlist_items w union all select (to_jsonb(s) - 'user_id')::text from public.tv_shows s) q")" = "$STATE0" ]
ok $? "observed, then absent, with the old state: ended without committing"
[ "$(RUNREC run-idle-1)" = "none" ]; ok $? "the rolled-back run left no run record"

echo "[label: waiting on a lock, then commit]"
mkfifo "$WORK/f2"
PSQL < "$WORK/f2" > "$WORK/s2.out" 2>&1 & P2=$!
exec 4> "$WORK/f2"
echo "begin; lock table public.watchlist_items in access share mode;" >&4
sleep 1
{ pre run-lock-1; cat "$ROOT/db/m1_access.sql"; } | PSQL > "$WORK/m1.out" 2>&1 & PM=$!
for i in $(seq 1 30); do L="$(LABEL run-lock-1)"; case "$L" in active/Lock*) break;; esac; sleep 0.3; done
case "$L" in active/Lock*) R=0;; *) R=1;; esac; ok $R "the label is visible while M1 waits on a lock: $L"
echo "commit;" >&4; exec 4>&-; wait $P2
wait $PM; RM=$?
ok $RM "M1 commits once the lock is released"
[ "$(LABEL run-lock-1)" = "absent" ] && [ "$(APPLIED)" = "t" ]; ok $? "observed, then absent, with the new state: committed"
[ "$(RUNREC run-lock-1)" = "run-lock-1" ]; ok $? "a fresh read from another connection finds this run's record (run-lock-1)"
[ "$(RUNREC run-idle-1)" = "none" ]; ok $? "and none for the earlier rolled-back run"

echo "[two runs started together]"
DB=m1twin
SLOW="$(sed 's/^commit;$/select pg_sleep(3);\ncommit;/' "$ROOT/db/m1_access.sql")"
{ pre run-twin-1; echo "$SLOW"; } | PSQL > "$WORK/t1.out" 2>&1 & T1=$!
{ pre run-twin-2; echo "$SLOW"; } | PSQL > "$WORK/t2.out" 2>&1 & T2=$!
wait $T1; R1=$?; wait $T2; R2=$?
[ $((R1 == 0 ? 1 : 0)) -ne $((R2 == 0 ? 1 : 0)) ]; ok $? "exactly one run commits (exit codes $R1, $R2)"
grep -q "already applied" "$WORK/t1.out" "$WORK/t2.out"; ok $? "the other waited on the locks, then refused (already applied), changing nothing"
[ "$(Q "select count(*) from private.library_members")" = "1" ] && [ "$(APPLIED)" = "t" ]; ok $? "one member, M1 applied once"
if [ "$R1" = 0 ]; then WIN=run-twin-1; LOSE=run-twin-2; else WIN=run-twin-2; LOSE=run-twin-1; fi
[ "$(RUNREC $WIN)" = "$WIN" ] && [ "$(RUNREC $LOSE)" = "none" ] && [ "$(Q "select count(*) from private.migration_runs")" = "1" ]
ok $? "exactly the committed run's record ($WIN); none for the refused one ($LOSE)"

echo
if [ "$FAILED" = 0 ]; then echo "all pg checks passed"; else echo "FAILED: $FAILED"; fi
exit $((FAILED > 0))
