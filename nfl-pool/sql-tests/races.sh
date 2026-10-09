#!/usr/bin/env bash
# HDC-13 and HDC-14 SQL race suite. Run by run.sh after behavior.sql, against the same throwaway PostgreSQL 17.11 container
# ($HDC13_PG_CONTAINER). Every write session connects as authenticator and makes the call the way the Data API does
# (request.jwt.claims for the transaction, SET LOCAL ROLE authenticated), so each race is two real concurrent requests.
#
# Races are deterministic, never timed: a gate session holds advisory lock 4242; session A makes its write and then waits
# on the gate inside its open transaction (still holding the per-contest lock, its row lock or its uncommitted row); B
# starts only when A is proven to be waiting on the gate, and the gate opens only when B is proven to be blocked behind A
# (pg_locks / pg_stat_activity). A then commits and B continues against A's committed result. Each assertion prints
# "HDC13-RACE ok: <name>" or "HDC13-RACE FAIL: <name>: <detail>".
set -uo pipefail

: "${HDC13_PG_CONTAINER:?races.sh is run by run.sh (HDC13_PG_CONTAINER is not set)}"
C="$HDC13_PG_CONTAINER"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
COMMISSIONER='{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}'
GATE=4242
passed=0
failed=0

ok() { passed=$((passed + 1)); echo "HDC13-RACE ok: $1"; }
fail() { failed=$((failed + 1)); echo "HDC13-RACE FAIL: $1: $2"; }
check() { if [ "$2" = "t" ]; then ok "$1"; else fail "$1" "${3:-condition is false}"; fi; }

# One statement as the superuser; prints the single value.
q() { docker exec -i "$C" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d nfl_pool -c "$1"; }

# start <name> <login role> <sql>: the SQL in a background session started by this shell (so it can be waited for);
# its PID is left in $pid, its output (stdout and stderr) in $work/<name>.out.
start() {
  printf '%s\n' "$3" > "$work/$1.sql"
  docker exec -i -e PGAPPNAME="$1" "$C" psql -X -At -v ON_ERROR_STOP=0 -v VERBOSITY=verbose -U "$2" -d nfl_pool \
    < "$work/$1.sql" > "$work/$1.out" 2>&1 &
  pid=$!
}

# Waits until the predicate (SQL returning t/f) holds; fails early when one of the given background sessions has ended.
wait_for() {
  local what="$1" sql="$2" i pid
  shift 2
  for ((i = 0; i < 300; i++)); do
    [ "$(q "$sql")" = "t" ] && return 0
    for pid in "$@"; do
      if ! kill -0 "$pid" 2>/dev/null; then echo "  ... $what: a session ended first"; return 1; fi
    done
    sleep 0.1
  done
  echo "  ... timed out waiting for: $what"
  return 1
}
waiting_on_gate() {
  echo "SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = '$1'
    AND l.locktype = 'advisory' AND l.objsubid = 1 AND l.objid = $GATE AND NOT l.granted)"
}
waiting_on_contest_lock() {
  echo "SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = '$1'
    AND l.locktype = 'advisory' AND l.objsubid = 2 AND NOT l.granted)"
}
waiting_on_row() {
  echo "SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.application_name = '$1' AND a.wait_event_type = 'Lock'
    AND a.wait_event IN ('transactionid', 'tuple'))"
}

# The gate: a session holding advisory lock $GATE until gate_release.
gate_open() {
  rm -f "$work/gate.fifo"
  mkfifo "$work/gate.fifo"
  docker exec -i -e PGAPPNAME=race-gate "$C" psql -X -q -At -U postgres -d nfl_pool < "$work/gate.fifo" > "$work/gate.out" 2>&1 &
  gate_pid=$!
  exec 7> "$work/gate.fifo"
  echo "SELECT pg_advisory_lock($GATE);" >&7
  wait_for "the gate" "SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = 'race-gate'
    AND l.locktype = 'advisory' AND l.objsubid = 1 AND l.objid = $GATE AND l.granted)" "$gate_pid"
}
gate_release() {
  echo "SELECT pg_advisory_unlock($GATE);" >&7
  exec 7>&-
  wait "$gate_pid" 2>/dev/null
}

# SQL text of one Data API call. Arguments are SQL literals (NULL for none), in the RPC's order.
rpc() {
  printf "SELECT 'RESULT ' || public.nfl_append_incident_ruling(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)::text;\n" "$@"
}
data_api_begin() {
  printf "BEGIN;\nSELECT set_config('request.jwt.claims', '%s', true) IS NOT NULL AS claims_set;\nSET LOCAL ROLE authenticated;\n" "$COMMISSIONER"
}
gate_wait_sql() { echo "SELECT pg_advisory_xact_lock_shared($GATE) IS NULL AS gate_passed;"; }

result_of() { grep -m1 '^RESULT {' "$work/$1.out" > /dev/null && echo t || echo f; }
error_of() { grep -m1 -F "ERROR:  $2" "$work/$1.out" > /dev/null && echo t || echo f; }
show() { sed 's/^/    | /' "$work/$1.out"; }

rule() { # contest week away home consequence event note
  rpc "'$1'" "$2" "'$3'" "'$4'" "'rule'" "'$5'" 1 NULL "'STATUS_CANCELED'" "'$6'" "'nflscores2'" "'$7'" NULL
}

echo "== race 1: two first rulings of one incident (two tabs): one lands, the other is HDC13_STALE_CHAIN"
gate_open
start race-a authenticator "$( data_api_begin; rule pool-center-2026-pickem 10 LAR SEA void 401438001 'Canceled; void (tab 1).'; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; rule pool-center-2026-pickem 10 LAR SEA void 401438001 'Canceled; void (tab 2).'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
check "two first rulings: B was blocked behind A on the per-contest lock" "$(q "$(waiting_on_contest_lock race-b)")"
gate_release; wait "$a" "$b"
check "two first rulings: A lands" "$(result_of race-a)" "$(show race-a)"
check "two first rulings: B is refused with HDC13_STALE_CHAIN" "$(error_of race-b 'P0001: HDC13_STALE_CHAIN')" "$(show race-b)"
check "two first rulings: exactly one root exists" "$(q "SELECT count(*) = 1 FROM public.nfl_incident_rulings WHERE week = 10 AND away_team = 'LAR'")"

echo "== race 2: retry and resubmit of the same request: concurrent (double submit) and after the first landed"
gate_open
start race-a authenticator "$( data_api_begin; rule pool-center-2026-pickem 10 ATL TB void 401438002 'Canceled; void.'; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; rule pool-center-2026-pickem 10 ATL TB void 401438002 'Canceled; void.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
gate_release; wait "$a" "$b"
check "double submit: the first request lands" "$(result_of race-a)" "$(show race-a)"
check "double submit: the identical second request is HDC13_STALE_CHAIN" "$(error_of race-b 'P0001: HDC13_STALE_CHAIN')" "$(show race-b)"
start race-c authenticator "$( data_api_begin; rule pool-center-2026-pickem 10 ATL TB void 401438002 'Canceled; void.'; echo 'COMMIT;'; )"; c=$pid
wait "$c"
check "retry after the response was lost: the resubmitted request is HDC13_STALE_CHAIN" "$(error_of race-c 'P0001: HDC13_STALE_CHAIN')" "$(show race-c)"
check "retry and resubmit: still exactly one row" "$(q "SELECT count(*) = 1 FROM public.nfl_incident_rulings WHERE week = 10 AND away_team = 'ATL'")"

echo "== race 3: reaffirm against withdraw from the same page state: one lands, the other is HDC13_STALE_CHAIN"
start race-setup authenticator "$( data_api_begin; rule pool-center-2026-pickem 10 CAR NO void 401438003 'Canceled; void.'; echo 'COMMIT;'; )"; wait "$pid"
root=$(q "SELECT ruling_id FROM public.nfl_incident_rulings WHERE week = 10 AND away_team = 'CAR' AND chain_seq = 1")
check "reaffirm against withdraw: the active ruling exists" "$( [ -n "$root" ] && echo t || echo f )" "$(show race-setup)"
gate_open
start race-a authenticator "$( data_api_begin; rpc "'pool-center-2026-pickem'" 10 "'CAR'" "'NO'" "'withdraw'" NULL 1 "${root:-0}" NULL NULL NULL "'Withdrawn.'" "'Withdrawn in tab 1.'"; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; rpc "'pool-center-2026-pickem'" 10 "'CAR'" "'NO'" "'reaffirm'" NULL 1 "${root:-0}" NULL NULL NULL "'Reaffirmed.'" NULL; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
gate_release; wait "$a" "$b"
check "reaffirm against withdraw: the withdrawal lands" "$(result_of race-a)" "$(show race-a)"
check "reaffirm against withdraw: the reaffirm is HDC13_STALE_CHAIN" "$(error_of race-b 'P0001: HDC13_STALE_CHAIN')" "$(show race-b)"
check "reaffirm against withdraw: the chain is exactly void, withdrawn" "$(q "SELECT string_agg(consequence, ',' ORDER BY chain_seq) = 'void,withdrawn' FROM public.nfl_incident_rulings WHERE week = 10 AND away_team = 'CAR'")"

echo "== race 4: double-team coverage (Survivor): a second incident naming a covered team is refused by the HDC-12 trigger"
gate_open
start race-a authenticator "$( data_api_begin; rule pool-center-2026-survivor 1 PIT CLE advance_team_used 401547101 'Canceled; pickers advance.'; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; rule pool-center-2026-survivor 1 PIT NYG advance_team_used 401547102 'Canceled; pickers advance.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
gate_release; wait "$a" "$b"
check "double coverage: the first incident lands" "$(result_of race-a)" "$(show race-a)"
check "double coverage: the second incident is refused by the unchanged HDC-12 check (23514, already covered)" \
  "$( [ "$(error_of race-b '23514:')" = t ] && grep -q 'is already covered by another incident' "$work/race-b.out" && echo t || echo f )" "$(show race-b)"
check "double coverage: PIT is covered by exactly one Week 1 incident" "$(q "SELECT count(*) = 1 FROM public.nfl_incident_rulings WHERE contest_id = 'pool-center-2026-survivor' AND week = 1 AND 'PIT' IN (away_team, home_team)")"

echo "== race 5: a policy revision committed first: the ruling naming the old revision is HDC13_STALE_POLICY"
gate_open
start race-a nfl_pool_owner "$( echo 'BEGIN;'; echo "INSERT INTO public.nfl_contest_policies (contest_id, contest_type, revision, effective_week, halted_game_policy, public_note) VALUES ('fixture-2099-pickem', 'pickem', 2, 6, 'void', 'Revision 2 from Week 6.') RETURNING 'POLICY ' || revision;"; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; rule fixture-2099-pickem 6 CHI DET void 409900601 'Canceled; void.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
gate_release; wait "$a" "$b"
check "policy first: revision 2 is committed" "$(grep -q '^POLICY 2$' "$work/race-a.out" && echo t || echo f)" "$(show race-a)"
check "policy first: the ruling naming revision 1 is HDC13_STALE_POLICY" "$(error_of race-b 'P0001: HDC13_STALE_POLICY')" "$(show race-b)"
check "policy first: no ruling was written for Week 6" "$(q "SELECT count(*) = 0 FROM public.nfl_incident_rulings WHERE contest_id = 'fixture-2099-pickem' AND week = 6")"

echo "== race 6: a ruling committed first: the policy revision reaching its week is refused by the HDC-12 check"
gate_open
start race-a authenticator "$( data_api_begin; rpc "'fixture-2099-pickem'" 7 "'CLE'" "'BAL'" "'rule'" "'void'" 2 NULL "'STATUS_POSTPONED'" "'409900701'" "'nflscores2'" "'Postponed; void.'" NULL; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b nfl_pool_owner "$( echo 'BEGIN;'; echo "INSERT INTO public.nfl_contest_policies (contest_id, contest_type, revision, effective_week, halted_game_policy, public_note) VALUES ('fixture-2099-pickem', 'pickem', 3, 7, 'void', 'Revision 3 from Week 7.') RETURNING 'POLICY ' || revision;"; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
gate_release; wait "$a" "$b"
check "ruling first: the ruling under revision 2 lands" "$(result_of race-a)" "$(show race-a)"
check "ruling first: revision 3 reaching Week 7 is refused (23514, Week 7 already has a ruling)" \
  "$( [ "$(error_of race-b '23514:')" = t ] && grep -q 'which already has a ruling' "$work/race-b.out" && echo t || echo f )" "$(show race-b)"
check "ruling first: the contest still has two policy revisions" "$(q "SELECT count(*) = 2 FROM public.nfl_contest_policies WHERE contest_id = 'fixture-2099-pickem'")"

echo "== race 7: a publish update committed first: the ruling validates against the new published week (HDC13_NOT_PUBLISHED)"
gate_open
start race-a authenticator "$( data_api_begin; echo "UPDATE public.nfl_pool_weeks w SET config = jsonb_set(w.config, '{games}', (SELECT jsonb_agg(g) FROM jsonb_array_elements(w.config->'games') g WHERE g->>'away' <> 'GB')), revision = w.revision + 1, updated_at = now() WHERE w.season = 2026 AND w.week = 11 AND w.revision = 1 RETURNING 'UPDATED ' || w.revision;"; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; rule pool-center-2026-pickem 11 GB MIN void 401438011 'Canceled; void.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the published week row" "$(waiting_on_row race-b)" "$b"
check "publish first: the ruling waited for the uncommitted publish of its week" "$(q "$(waiting_on_row race-b)")"
gate_release; wait "$a" "$b"
check "publish first: the publish lands (revision 2)" "$(grep -q '^UPDATED 2$' "$work/race-a.out" && echo t || echo f)" "$(show race-a)"
check "publish first: the ruling for the game the publish removed is HDC13_NOT_PUBLISHED" "$(error_of race-b 'P0001: HDC13_NOT_PUBLISHED')" "$(show race-b)"
check "publish first: no ruling was written for GB @ MIN" "$(q "SELECT count(*) = 0 FROM public.nfl_incident_rulings WHERE week = 11 AND away_team = 'GB'")"

echo "== race 8: a ruling committed first: the publish update of its week waits for it"
gate_open
start race-a authenticator "$( data_api_begin; rule pool-center-2026-pickem 11 HOU TEN void 401438012 'Canceled; void.'; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; echo "UPDATE public.nfl_pool_weeks w SET config = jsonb_set(w.config, '{label}', '\"Week 11 (corrected)\"'), revision = w.revision + 1, updated_at = now() WHERE w.season = 2026 AND w.week = 11 AND w.revision = 2 RETURNING 'UPDATED ' || w.revision;"; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the published week row" "$(waiting_on_row race-b)" "$b"
check "ruling first: the publish waited for the ruling that validated against its week" "$(q "$(waiting_on_row race-b)")"
gate_release; wait "$a" "$b"
check "ruling first: the ruling lands" "$(result_of race-a)" "$(show race-a)"
check "ruling first: the publish lands after it (revision 3)" "$(grep -q '^UPDATED 3$' "$work/race-b.out" && echo t || echo f)" "$(show race-b)"

echo "== race 9: two different actions from two tabs on one active chain (withdraw against withdraw)"
root=$(q "SELECT ruling_id FROM public.nfl_incident_rulings WHERE week = 11 AND away_team = 'HOU' AND chain_seq = 1")
gate_open
start race-a authenticator "$( data_api_begin; rpc "'pool-center-2026-pickem'" 11 "'HOU'" "'TEN'" "'withdraw'" NULL 1 "${root:-0}" NULL NULL NULL "'Withdrawn.'" "'Tab 1.'"; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; rpc "'pool-center-2026-pickem'" 11 "'HOU'" "'TEN'" "'withdraw'" NULL 1 "${root:-0}" NULL NULL NULL "'Withdrawn.'" "'Tab 2.'"; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
gate_release; wait "$a" "$b"
check "withdraw twice at once: the first withdrawal lands" "$(result_of race-a)" "$(show race-a)"
check "withdraw twice at once: the second is HDC13_STALE_CHAIN" "$(error_of race-b 'P0001: HDC13_STALE_CHAIN')" "$(show race-b)"
check "withdraw twice at once: exactly one withdrawal" "$(q "SELECT string_agg(consequence, ',' ORDER BY chain_seq) = 'void,withdrawn' FROM public.nfl_incident_rulings WHERE week = 11 AND away_team = 'HOU'")"

# ---------------------------------------------------------------------------------------------------------------------
# HDC-14: the absent-game write path (public.nfl_append_absent_incident_ruling, migration 005) under the same locks: the
# per-contest advisory lock of the HDC-12 insert checks and the published week (Pick'em) or same-week slate (Survivor)
# read FOR SHARE.
# ---------------------------------------------------------------------------------------------------------------------
# SQL text of one Data API call of the absent-game RPC. Arguments are SQL literals (NULL for none), in the RPC's order.
arpc() {
  printf "SELECT 'RESULT ' || public.nfl_append_absent_incident_ruling(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)::text;\n" "$@"
}
arule() { # contest week away home consequence revision note
  arpc "'$1'" "$2" "'$3'" "'$4'" "'rule'" "'$5'" "$6" NULL "'$7'" NULL
}

echo "== race 10: an absent-game first ruling against a normal first ruling of one incident: exactly one establishes the chain"
gate_open
start race-a authenticator "$( data_api_begin; arule pool-center-2026-pickem 12 MIA NE void 1 'Absent from the Week 12 feed; void.'; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; rule pool-center-2026-pickem 12 MIA NE void 401438124 'Canceled; void.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
check "absent first: the normal ruling was blocked behind the absent-game ruling on the per-contest lock" "$(q "$(waiting_on_contest_lock race-b)")"
gate_release; wait "$a" "$b"
check "absent first: the absent-game ruling lands" "$(result_of race-a)" "$(show race-a)"
check "absent first: the normal first ruling is HDC13_STALE_CHAIN" "$(error_of race-b 'P0001: HDC13_STALE_CHAIN')" "$(show race-b)"
check "absent first: exactly one root, an attested absence" "$(q "SELECT count(*) = 1 AND bool_and(incident_status = 'STATUS_ABSENT' AND evidence_source = 'commissioner-attestation') FROM public.nfl_incident_rulings WHERE contest_id = 'pool-center-2026-pickem' AND week = 12 AND away_team = 'MIA'")"
gate_open
start race-a authenticator "$( data_api_begin; rule pool-center-2026-pickem 12 LV KC void 401438130 'Canceled; void.'; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; arule pool-center-2026-pickem 12 LV KC void 1 'Absent from the Week 12 feed; void.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
check "normal first: the absent-game ruling was blocked behind the normal ruling on the per-contest lock" "$(q "$(waiting_on_contest_lock race-b)")"
gate_release; wait "$a" "$b"
check "normal first: the normal ruling lands" "$(result_of race-a)" "$(show race-a)"
check "normal first: the absent-game first ruling is HDC14_STALE_CHAIN" "$(error_of race-b 'P0001: HDC14_STALE_CHAIN')" "$(show race-b)"
check "normal first: exactly one root, feed evidence" "$(q "SELECT count(*) = 1 AND bool_and(incident_status = 'STATUS_CANCELED' AND evidence_source = 'nflscores2') FROM public.nfl_incident_rulings WHERE contest_id = 'pool-center-2026-pickem' AND week = 12 AND away_team = 'LV'")"

echo "== race 11: an absent-game ruling against a republish of its week: serialized on the published row"
gate_open
start race-a authenticator "$( data_api_begin; echo "UPDATE public.nfl_pool_weeks w SET config = jsonb_set(w.config, '{games}', (SELECT jsonb_agg(g) FROM jsonb_array_elements(w.config->'games') g WHERE g->>'away' <> 'SEA')), revision = w.revision + 1, updated_at = now() WHERE w.season = 2026 AND w.week = 12 AND w.revision = 1 RETURNING 'UPDATED ' || w.revision;"; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; arule pool-center-2026-pickem 12 SEA SF void 1 'Absent from the Week 12 feed; void.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the published week row" "$(waiting_on_row race-b)" "$b"
check "republish first: the absent-game ruling waited for the uncommitted republish of its week" "$(q "$(waiting_on_row race-b)")"
gate_release; wait "$a" "$b"
check "republish first: the republish lands (revision 2)" "$(grep -q '^UPDATED 2$' "$work/race-a.out" && echo t || echo f)" "$(show race-a)"
check "republish first: the absent-game ruling for the game the republish removed is HDC14_NOT_PUBLISHED" "$(error_of race-b 'P0001: HDC14_NOT_PUBLISHED')" "$(show race-b)"
check "republish first: no ruling was written for SEA @ SF" "$(q "SELECT count(*) = 0 FROM public.nfl_incident_rulings WHERE week = 12 AND away_team = 'SEA'")"
gate_open
start race-a authenticator "$( data_api_begin; arule pool-center-2026-pickem 12 ATL NO void 1 'Absent from the Week 12 feed; void.'; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; echo "UPDATE public.nfl_pool_weeks w SET config = jsonb_set(w.config, '{label}', '\"Week 12 (corrected)\"'), revision = w.revision + 1, updated_at = now() WHERE w.season = 2026 AND w.week = 12 AND w.revision = 2 RETURNING 'UPDATED ' || w.revision;"; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the published week row" "$(waiting_on_row race-b)" "$b"
check "ruling first: the republish waited for the absent-game ruling that validated against its week" "$(q "$(waiting_on_row race-b)")"
gate_release; wait "$a" "$b"
check "ruling first: the absent-game ruling lands" "$(result_of race-a)" "$(show race-a)"
check "ruling first: the republish lands after it (revision 3)" "$(grep -q '^UPDATED 3$' "$work/race-b.out" && echo t || echo f)" "$(show race-b)"

echo "== race 12: an absent-game ruling submitted twice (double click) and retried: one lands, the others are HDC14_STALE_CHAIN"
gate_open
start race-a authenticator "$( data_api_begin; arule pool-center-2026-pickem 12 CHI GB void 1 'Absent from the Week 12 feed; void.'; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; arule pool-center-2026-pickem 12 CHI GB void 1 'Absent from the Week 12 feed; void.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
check "absent double submit: the second request was blocked behind the first on the per-contest lock" "$(q "$(waiting_on_contest_lock race-b)")"
gate_release; wait "$a" "$b"
check "absent double submit: the first request lands" "$(result_of race-a)" "$(show race-a)"
check "absent double submit: the identical second request is HDC14_STALE_CHAIN" "$(error_of race-b 'P0001: HDC14_STALE_CHAIN')" "$(show race-b)"
start race-c authenticator "$( data_api_begin; arule pool-center-2026-pickem 12 CHI GB void 1 'Absent from the Week 12 feed; void.'; echo 'COMMIT;'; )"; c=$pid
wait "$c"
check "absent retry after the response was lost: the resubmitted request is HDC14_STALE_CHAIN" "$(error_of race-c 'P0001: HDC14_STALE_CHAIN')" "$(show race-c)"
check "absent double submit and retry: still exactly one row" "$(q "SELECT count(*) = 1 FROM public.nfl_incident_rulings WHERE week = 12 AND away_team = 'CHI'")"

echo "== race 13: a policy revision against an absent-game ruling: the HDC-12 semantics, either order"
gate_open
start race-a nfl_pool_owner "$( echo 'BEGIN;'; echo "INSERT INTO public.nfl_contest_policies (contest_id, contest_type, revision, effective_week, halted_game_policy, public_note) VALUES ('fixture-2099-pickem', 'pickem', 3, 9, 'void', 'Revision 3 from Week 9.') RETURNING 'POLICY ' || revision;"; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; arule fixture-2099-pickem 9 DAL WAS void 2 'Absent from the Week 9 feed; void.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
gate_release; wait "$a" "$b"
check "policy first: revision 3 is committed" "$(grep -q '^POLICY 3$' "$work/race-a.out" && echo t || echo f)" "$(show race-a)"
check "policy first: the absent-game ruling naming revision 2 is HDC14_STALE_POLICY" "$(error_of race-b 'P0001: HDC14_STALE_POLICY')" "$(show race-b)"
check "policy first: no ruling was written for Week 9" "$(q "SELECT count(*) = 0 FROM public.nfl_incident_rulings WHERE contest_id = 'fixture-2099-pickem' AND week = 9")"
gate_open
start race-a authenticator "$( data_api_begin; arule fixture-2099-pickem 10 CAR ATL void 3 'Absent from the Week 10 feed; void.'; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b nfl_pool_owner "$( echo 'BEGIN;'; echo "INSERT INTO public.nfl_contest_policies (contest_id, contest_type, revision, effective_week, halted_game_policy, public_note) VALUES ('fixture-2099-pickem', 'pickem', 4, 10, 'void', 'Revision 4 from Week 10.') RETURNING 'POLICY ' || revision;"; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the per-contest lock" "$(waiting_on_contest_lock race-b)" "$b"
gate_release; wait "$a" "$b"
check "absent ruling first: the absent-game ruling under revision 3 lands" "$(result_of race-a)" "$(show race-a)"
check "absent ruling first: revision 4 reaching Week 10 is refused (23514, Week 10 already has a ruling)" \
  "$( [ "$(error_of race-b '23514:')" = t ] && grep -q 'which already has a ruling' "$work/race-b.out" && echo t || echo f )" "$(show race-b)"
check "absent ruling first: the contest still has three policy revisions" "$(q "SELECT count(*) = 3 FROM public.nfl_contest_policies WHERE contest_id = 'fixture-2099-pickem'")"

echo "== race 14: a Survivor absent-game ruling against a republish of its same-week Pick'em slate"
gate_open
start race-a authenticator "$( data_api_begin; echo "UPDATE public.nfl_pool_weeks w SET config = jsonb_set(w.config, '{games}', (SELECT jsonb_agg(g) FROM jsonb_array_elements(w.config->'games') g WHERE g->>'away' <> 'IND')), revision = w.revision + 1, updated_at = now() WHERE w.season = 2099 AND w.week = 8 AND w.revision = 1 RETURNING 'UPDATED ' || w.revision;"; gate_wait_sql; echo 'COMMIT;'; )"; a=$pid
wait_for "A waits on the gate" "$(waiting_on_gate race-a)" "$a"
start race-b authenticator "$( data_api_begin; arule fixture-2099-survivor 8 IND HOU advance_team_used 1 'Absent from the Week 8 feed; pickers advance.'; echo 'COMMIT;'; )"; b=$pid
wait_for "B is blocked on the slate row" "$(waiting_on_row race-b)" "$b"
check "slate republish first: the Survivor ruling waited for the uncommitted republish of its same-week slate" "$(q "$(waiting_on_row race-b)")"
gate_release; wait "$a" "$b"
check "slate republish first: the republish lands (revision 2)" "$(grep -q '^UPDATED 2$' "$work/race-a.out" && echo t || echo f)" "$(show race-a)"
check "slate republish first: the Survivor ruling the slate no longer proves is HDC14_ABSENCE_NOT_ATTESTABLE" "$(error_of race-b 'P0001: HDC14_ABSENCE_NOT_ATTESTABLE')" "$(show race-b)"
check "slate republish first: no Survivor ruling was written for IND @ HOU" "$(q "SELECT count(*) = 0 FROM public.nfl_incident_rulings WHERE contest_id = 'fixture-2099-survivor' AND away_team = 'IND'")"

echo "HDC13-RACE-SUMMARY races=14 passed=$passed failed=$failed"
[ "$failed" -eq 0 ] && [ "$passed" -eq 61 ]
