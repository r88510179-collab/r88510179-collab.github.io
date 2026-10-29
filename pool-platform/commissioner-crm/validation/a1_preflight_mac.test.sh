#!/usr/bin/env bash
# Regression tests for a1_preflight_mac.sh. Linux only, as root, on a disposable machine. The preflight runs
# unchanged in a fake macOS home: a fake uname answers Darwin, a fake psql answers only --version (and records any
# other call), a throwaway SSH key stands in for the owner's, and /opt is a private tmpfs, so the Homebrew psql
# location can be simulated. It re-executes itself in new network and mount namespaces; nothing leaves the machine.
#
#   bash pool-platform/commissioner-crm/validation/a1_preflight_mac.test.sh
#
# A1_TEST_BASH runs the preflight under another bash (for example a bash 3.2 build, the version of macOS /bin/bash);
# A1_TEST_AWK runs it with another awk (for example original-awk, the BWK awk macOS ships); A1_TEST_KEEP=1 keeps the
# work directory.
set -euo pipefail
export LC_ALL=C
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

[ "$(uname -s)" = Linux ] || { echo 'a1_preflight_mac.test.sh runs on Linux only' >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo 'a1_preflight_mac.test.sh needs root (unshare, mount)' >&2; exit 2; }
if [ "${A1_TEST_NS:-}" != 1 ]; then
  exec unshare --net --mount --propagation private -- env A1_TEST_NS=1 bash "$0" "$@"
fi
ip link set lo up
mkdir -p /opt
mount -t tmpfs tmpfs /opt

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
PREFLIGHT="$HERE/a1_preflight_mac.sh"
TBASH=${A1_TEST_BASH:-/bin/bash}
HOST='ep-still-recipe-b5g7680z.c-7.us-east-2.aws.neon.tech'
KITREL=pool-platform/commissioner-crm/validation
WORK=$(mktemp -d /var/tmp/a1-preflight-test.XXXXXX)
trap 'if [ "${A1_TEST_KEEP:-}" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi' EXIT
SECRET="a1-preflight-fake-secret-$(openssl rand -hex 8)"

PASSED=0
FAILED=0
FAILS=''
ok(){ PASSED=$((PASSED + 1)); printf 'ok   %s\n' "$1"; }
bad(){ FAILED=$((FAILED + 1)); FAILS="$FAILS
  $1"; printf 'FAIL %s\n' "$1"; }
check(){ local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

# --- the fake Mac: home, checkout, key, signatures, psql configuration ---------------------------------------------
H="$WORK/home"
CO="$H/Documents/commissioner-crm-a1"
KIT="$CO/$KITREL"
mkdir -p "$H/Documents" "$H/.ssh" "$WORK/tmp"
git clone -q --shared "$REPO" "$CO"
git -C "$CO" checkout -q "$(git -C "$REPO" rev-parse HEAD)"
for f in A1_AUTHORIZATION.md a1_run.sh A1_RUNNER_ACK.txt P1_identity_helpers_004.sql P2_private_schema_inventory.sql P3_crm_preconditions.sql; do
  cp "$HERE/$f" "$KIT/$f"
done
ssh-keygen -q -t ed25519 -N '' -C 'a1 preflight test key' -f "$H/.ssh/crm_a1_signing_ed25519"
ssh-keygen -q -t ed25519 -N '' -C 'another key' -f "$WORK/other_key"
sign(){ rm -f "$2.sig"; ssh-keygen -q -Y sign -f "$1" -n file "$2" > /dev/null 2>&1; }
sign "$H/.ssh/crm_a1_signing_ed25519" "$KIT/A1_AUTHORIZATION.md"
sign "$H/.ssh/crm_a1_signing_ed25519" "$KIT/A1_RUNNER_ACK.txt"
# The preflight must not need the private key: it is gone before the first run.
rm "$H/.ssh/crm_a1_signing_ed25519"
cp "$KIT/A1_AUTHORIZATION.md.sig" "$WORK/auth.sig"
cp "$H/.ssh/crm_a1_signing_ed25519.pub" "$WORK/pub.backup"
cp "$KIT/A1_RUNNER_ACK.txt.sig" "$WORK/ack.sig"
: > "$WORK/cert.pem"
write_service(){ # extra lines for the production entry
  {
    printf '# psql service file\n[other]\nhost=localhost\ndbname=postgres\n\n'
    printf '[crm-a1-prod]\nhost=%s\nport=5432\ndbname=neondb\nuser=neondb_owner\nsslmode=verify-full\nsslrootcert=%s\n' "$HOST" "$WORK/cert.pem"
    printf '%s\n' "$@"
  } > "$H/.pg_service.conf"
}
write_pgpass(){ printf '%s\n' "$@" > "$H/.pgpass"; chmod 600 "$H/.pgpass"; }
reset_config(){
  write_service
  write_pgpass "$HOST:5432:neondb:neondb_owner:$SECRET"
  chmod 600 "$H/.pg_service.conf"
  rm -rf "$H/commissioner-crm-a1-evidence" "$H/.postgresql" "$H/elsewhere.pgpass"
  cp "$WORK/pub.backup" "$H/.ssh/crm_a1_signing_ed25519.pub"
  cp "$WORK/auth.sig" "$KIT/A1_AUTHORIZATION.md.sig"
  cp "$WORK/ack.sig" "$KIT/A1_RUNNER_ACK.txt.sig"
  for f in A1_AUTHORIZATION.md a1_run.sh A1_RUNNER_ACK.txt; do cp "$HERE/$f" "$KIT/$f"; done
}

FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/uname" <<'EOF'
#!/bin/bash
case "${1:-}" in -r) echo 24.1.0 ;; *) echo "${FAKE_UNAME:-Darwin}" ;; esac
EOF
cat > "$FAKEBIN/sw_vers" <<'EOF'
#!/bin/bash
echo 15.1
EOF
cat > "$FAKEBIN/psql" <<'EOF'
#!/bin/bash
if [ "${1:-}" = --version ]; then echo "psql (PostgreSQL) ${FAKE_PSQL_VERSION:-18.0} (Homebrew)"; exit 0; fi
echo "psql called with: $*" >> "${FAKE_PSQL_LOG:?}"
exit 99
EOF
chmod 755 "$FAKEBIN"/*
AWKBIN="$WORK/awkbin"
mkdir -p "$AWKBIN"
if [ -n "${A1_TEST_AWK:-}" ]; then ln -s "$(command -v "$A1_TEST_AWK")" "$AWKBIN/awk"; fi
NOPSQL="$WORK/nopsql"
mkdir -p "$NOPSQL"
ln -s "$FAKEBIN/uname" "$NOPSQL/uname"
ln -s "$FAKEBIN/sw_vers" "$NOPSQL/sw_vers"
# Exactly the tools the preflight uses, and no psql (this machine has one in /usr/bin, which is /bin too).
TOOLS="$WORK/tools"
mkdir -p "$TOOLS"
for t in shasum ssh-keygen awk sed grep ls mktemp head git cut env tr rm sort; do
  if [ "$t" = awk ] && [ -e "$AWKBIN/awk" ]; then ln -s "$AWKBIN/awk" "$TOOLS/awk"; else ln -s "$(command -v "$t")" "$TOOLS/$t"; fi
done

cat > "$WORK/tty_run.py" <<'PY'
import os, sys
out_path, err_path = sys.argv[1:3]
cmd = sys.argv[3:]
pid, fd = os.forkpty()
if pid == 0:
    try:
        out = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        err = os.open(err_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.dup2(out, 1)
        os.dup2(err, 2)
        os.execv(cmd[0], cmd)
    finally:
        os._exit(127)
while True:
    try:
        if not os.read(fd, 4096):
            break
    except OSError:
        break
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
PY

# run NAME [VAR=value]... : the preflight with a minimal environment on a pseudo-terminal (NOTTY=1: none).
run(){
  local name=$1 a k notty=0
  shift
  CASE="$WORK/cases/$name"
  mkdir -p "$CASE"
  declare -A E=([HOME]="$H" [PATH]="$FAKEBIN:$TOOLS" [TMPDIR]="$WORK/tmp" [FAKE_PSQL_LOG]="$CASE/psql-calls")
  for a in "$@"; do
    case $a in NOTTY=1) notty=1 ;; -*) unset "E[${a#-}]" ;; *=*) E[${a%%=*}]=${a#*=} ;; esac
  done
  local -a envl=()
  for k in "${!E[@]}"; do envl+=("$k=${E[$k]}"); done
  BEFORE=$(cd "$H" && find . -path ./Documents -prune -o -print | sort; ls -la "$KIT" 2>/dev/null || true)
  RC=0
  if [ "$notty" = 1 ]; then
    setsid -w env -i "${envl[@]}" "$TBASH" "$PREFLIGHT" > "$CASE/stdout" 2> "$CASE/stderr" < /dev/null || RC=$?
  else
    env -i "${envl[@]}" /usr/bin/python3 -I "$WORK/tty_run.py" "$CASE/stdout" "$CASE/stderr" "$TBASH" "$PREFLIGHT" || RC=$?
  fi
  AFTER=$(cd "$H" && find . -path ./Documents -prune -o -print | sort; ls -la "$KIT" 2>/dev/null || true)
}
says(){ grep -qF -- "$1" "$CASE/stdout"; }
# expect NAME CODE TEXT...: exit code, the result line, each TEXT, and the invariants every run keeps.
expect(){
  local name=$1 code=$2 t
  shift 2
  check "$name: exit $code" [ "$RC" -eq "$code" ]
  case $code in
    0) check "$name: READY" [ "$(tail -n 1 "$CASE/stdout")" = 'PREFLIGHT RESULT: READY' ] ;;
    1) check "$name: NOT READY" bash -c "tail -n 1 '$CASE/stdout' | grep -q '^PREFLIGHT RESULT: NOT READY ('" ;;
  esac
  for t in "$@"; do check "$name: says: $t" says "$t"; done
  check "$name: no password is printed" bash -c "! grep -rqF -- '$SECRET' '$CASE'"
  check "$name: no private key material is printed" bash -c "! grep -rqE 'PRIVATE KEY|password=' '$CASE'"
  check "$name: psql was asked for its version only" [ ! -e "$CASE/psql-calls" ]
  check "$name: nothing in the home directory or the kit changed" [ "$BEFORE" = "$AFTER" ]
  check "$name: nothing is written to stderr" [ ! -s "$CASE/stderr" ]
}
RUNNER_SHA=$(sha256sum < "$HERE/a1_run.sh" | awk '{print $1}')
CMD_LINE='  PP_SERVICE=crm-a1-prod PP_REPO="$HOME/Documents/commissioner-crm-a1" \'

echo '# ready'
reset_config
run ready
expect ready 0 '[ok]   A1_RUNNER_ACK.txt.sig: Good "file" signature for crm-a1-owner' '[ok]   A1_AUTHORIZATION.md.sig: Good "file" signature for crm-a1-owner' \
  "$CMD_LINE" "  PP_RUNNER_SHA256=$RUNNER_SHA \\" '  PP_OUT="$HOME/commissioner-crm-a1-evidence/run-$(date -u +%Y%m%dT%H%M%SZ)" \' \
  '  bash "$HOME/Documents/commissioner-crm-a1/pool-platform/commissioner-crm/validation/a1_run.sh"' \
  '[ok]   service entry [crm-a1-prod]' 'has 1 line(s) for this host, port, database and role (passwords not shown)'
check 'ready: the printed command needs no PATH change when psql is on PATH' bash -c "! grep -q 'PATH=' '$CASE/stdout'"
check 'ready: no placeholder in the output' bash -c "! grep -qE '<[a-z][a-z _-]*>' '$CASE/stdout'"
FP=$(ssh-keygen -l -f "$H/.ssh/crm_a1_signing_ed25519.pub" | awk '{print $2}')
check 'ready: prints the key fingerprint in full' says "$FP"

echo '# signatures and pinned files'
reset_config; rm "$KIT/A1_RUNNER_ACK.txt.sig"
run ack-unsigned
expect ack-unsigned 1 '[TODO] read' "ssh-keygen -Y sign -f \"$H/.ssh/crm_a1_signing_ed25519\" -n file \"$KIT/A1_RUNNER_ACK.txt\""
check 'ack-unsigned: no A1 command is printed' bash -c "! grep -q 'PP_RUNNER_SHA256' '$CASE/stdout'"
reset_config; rm "$KIT/A1_AUTHORIZATION.md.sig"
run auth-sig-missing
expect auth-sig-missing 1 '[STOP] your detached signature A1_AUTHORIZATION.md.sig is not in'
reset_config; sign "$WORK/other_key" "$KIT/A1_AUTHORIZATION.md"
run auth-sig-other-key
expect auth-sig-other-key 1 '[STOP] A1_AUTHORIZATION.md.sig does not verify'
reset_config; sign "$WORK/other_key" "$KIT/A1_RUNNER_ACK.txt"
run ack-sig-other-key
expect ack-sig-other-key 1 '[STOP] A1_RUNNER_ACK.txt.sig does not verify'
reset_config; printf ' ' >> "$KIT/A1_RUNNER_ACK.txt"
run ack-tampered
expect ack-tampered 1 '[STOP] A1_RUNNER_ACK.txt does not match its pinned SHA-256'
check 'ack-tampered: no signing instruction for the altered text' bash -c "! grep -q 'ssh-keygen -Y sign' '$CASE/stdout'"
reset_config; printf ' ' >> "$KIT/A1_AUTHORIZATION.md"
run auth-tampered
expect auth-tampered 1 '[STOP] A1_AUTHORIZATION.md does not match its pinned SHA-256'
reset_config; git -C "$REPO" show 9aa4659:"$KITREL/a1_run.sh" > "$KIT/a1_run.sh"
run runner-v1
expect runner-v1 1 "[STOP] this checkout still has runner version 1; update it with: git -C \"$CO\" pull --ff-only origin ccr-321cd6b3-fu8f1j"
reset_config; printf '\n' >> "$KIT/a1_run.sh"
run runner-altered
expect runner-altered 1 '[STOP] a1_run.sh does not match its pinned SHA-256'
reset_config; rm "$H/.ssh/crm_a1_signing_ed25519.pub"
run no-public-key
expect no-public-key 1 "[STOP] your public signing key is not at $H/.ssh/crm_a1_signing_ed25519.pub"
# A checkout without the AUTH-C commit: a single-branch clone, in a second home.
H2="$WORK/home2"
cp -a "$H" "$H2"
rm -rf "$H2/Documents/commissioner-crm-a1"
git clone -q --no-local --single-branch --branch "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" "$REPO" "$H2/Documents/commissioner-crm-a1"
for f in A1_AUTHORIZATION.md a1_run.sh A1_RUNNER_ACK.txt A1_AUTHORIZATION.md.sig A1_RUNNER_ACK.txt.sig; do cp "$KIT/$f" "$H2/Documents/commissioner-crm-a1/$KITREL/$f"; done
cp "$WORK/pub.backup" "$H2/.ssh/crm_a1_signing_ed25519.pub"
check 'setup: the second checkout lacks the AUTH-C commit' bash -c "! git -C '$H2/Documents/commissioner-crm-a1' cat-file -e 2c6e2a805fa816638808cb2d96d430ee177453e6^{commit} 2>/dev/null"
run no-authc HOME="$H2"
expect no-authc 1 "[STOP] the AUTH-C commit is not in this checkout; fetch it with: git -C \"$H2/Documents/commissioner-crm-a1\" fetch origin 2c6e2a805fa816638808cb2d96d430ee177453e6"
rm -rf "$H/Documents/commissioner-crm-a1.moved"
mv "$CO" "$H/Documents/commissioner-crm-a1.moved"
run no-checkout
mv "$H/Documents/commissioner-crm-a1.moved" "$CO"
expect no-checkout 1 "[STOP] there is no git checkout at $CO"

echo '# the service entry'
svc(){ # the whole service file, one argument per line
  printf '%s\n' "$@" > "$H/.pg_service.conf"
  chmod 600 "$H/.pg_service.conf"
}
PROD="host=$HOST"
reset_config; rm "$H/.pg_service.conf"
run no-service-file
expect no-service-file 1 "[STOP] there is no psql service file at $H/.pg_service.conf"
reset_config; svc '[crm-a1-prod]' "host=ep-still-recipe-b5g7680z-pooler.c-7.us-east-2.aws.neon.tech" dbname=neondb user=neondb_owner "sslrootcert=$WORK/cert.pem"
run pooler
expect pooler 1 '[STOP] the service entry in' 'uses the pooler host; A1 needs the direct host'
reset_config; svc '[elsewhere]' host=localhost dbname=neondb
run no-entry
expect no-entry 1 "[STOP] no entry in $H/.pg_service.conf has host=$HOST"
reset_config; svc '[a]' "$PROD" dbname=neondb user=neondb_owner "sslrootcert=$WORK/cert.pem" '[b]' "$PROD" dbname=neondb user=neondb_owner "sslrootcert=$WORK/cert.pem"
run two-entries
expect two-entries 1 "[STOP] more than one entry in $H/.pg_service.conf has host=$HOST (a b ): keep one"
reset_config; write_service 'hostaddr=203.0.113.7'
run hostaddr
expect hostaddr 1 '[STOP] the entry [crm-a1-prod] sets hostaddr'
reset_config; svc '[crm-a1-prod]' "$PROD" port=6543 dbname=neondb user=neondb_owner "sslrootcert=$WORK/cert.pem"
run port
expect port 1 '[STOP] the entry [crm-a1-prod] has port=6543; Neon uses 5432'
reset_config; svc '[crm-a1-prod]' "$PROD" dbname=postgres user=neondb_owner "sslrootcert=$WORK/cert.pem"
run dbname
expect dbname 1 '[STOP] the entry [crm-a1-prod] must have dbname=neondb (it has "postgres")'
reset_config; svc '[crm-a1-prod]' "$PROD" dbname=neondb user=authenticator "sslrootcert=$WORK/cert.pem"
run user
expect user 1 '[STOP] the entry [crm-a1-prod] must have user=neondb_owner (it has "authenticator")'
reset_config; svc '[crm-a1-prod]' "$PROD" dbname=neondb user=neondb_owner
run no-rootcert
expect no-rootcert 1 'has no sslrootcert, and' 'add the line sslrootcert=/etc/ssl/cert.pem'
reset_config; svc '[crm-a1-prod]' "$PROD" dbname=neondb user=neondb_owner; mkdir -p "$H/.postgresql"; : > "$H/.postgresql/root.crt"
run default-rootcert
expect default-rootcert 0 "[ok]   no sslrootcert in the entry; $H/.postgresql/root.crt will be used" "[ok]   port 5432 (default)"
reset_config; svc '[crm-a1-prod]' "$PROD" dbname=neondb user=neondb_owner sslrootcert=system
run rootcert-system-16 FAKE_PSQL_VERSION=16.4
expect rootcert-system-16 0 '[ok]   sslrootcert=system (the macOS trust store)'
run rootcert-system-15 FAKE_PSQL_VERSION=15.8
expect rootcert-system-15 1 '[STOP] sslrootcert=system needs psql 16 or later'
reset_config; svc '[crm-a1-prod]' "$PROD" dbname=neondb user=neondb_owner 'sslrootcert=~/cert.pem'
run rootcert-tilde
expect rootcert-tilde 1 'write the full path, libpq does not expand ~'
reset_config; svc '[crm-a1-prod]' "$PROD" dbname=neondb user=neondb_owner "sslrootcert=$WORK/missing.pem"
run rootcert-missing
expect rootcert-missing 1 "[STOP] the entry [crm-a1-prod] has sslrootcert=$WORK/missing.pem, which does not exist"
reset_config; write_service 'sslmode=require'
run duplicate-key
expect duplicate-key 1 '[STOP] the entry [crm-a1-prod] gives sslmode more than once: keep one line for each'
reset_config; svc '[crm-a1-prod]' "host=evil.example" "$PROD" dbname=neondb user=neondb_owner "sslrootcert=$WORK/cert.pem"
run duplicate-host
expect duplicate-host 1 "[STOP] no entry in $H/.pg_service.conf has host=$HOST"
reset_config; svc '[crm-a1-prod]' "$PROD" dbname=neondb user=neondb_owner "sslrootcert=$WORK/cert.pem" sslmode=require
run sslmode-require-only
expect sslmode-require-only 0 '[note] the entry has sslmode=require; the runner uses sslmode=verify-full regardless'
reset_config; svc '[crm a1]' "$PROD" dbname=neondb user=neondb_owner "sslrootcert=$WORK/cert.pem"
run entry-name
expect entry-name 1 '[STOP] the entry name [crm a1] may use only letters, digits, dot, underscore and hyphen'
reset_config; write_service 'sslcompression verify'
run odd-line
expect odd-line 1 '[STOP] the entry [crm-a1-prod] has a line that is not key=value without spaces'
reset_config; write_service "application_name=$SECRET" "options=-c statement_timeout=$SECRET"
run other-keys
expect other-keys 0 '[note] the entry also sets: application_name options'

echo '# the password source'
reset_config; write_service "password=$SECRET"; chmod 644 "$H/.pg_service.conf"; rm "$H/.pgpass"
run service-password-readable
expect service-password-readable 1 '[note] the entry [crm-a1-prod] holds a password (not shown)' "chmod 600 \"$H/.pg_service.conf\""
reset_config; write_service "password=$SECRET"; chmod 600 "$H/.pg_service.conf"; rm "$H/.pgpass"
run service-password-private
expect service-password-private 0 '[note] the entry [crm-a1-prod] holds a password (not shown)'
reset_config; chmod 644 "$H/.pgpass"
run pgpass-readable
expect pgpass-readable 1 "[STOP] $H/.pgpass is readable by others, so libpq ignores it: chmod 600 \"$H/.pgpass\""
reset_config; rm "$H/.pgpass"
run pgpass-missing
expect pgpass-missing 1 "[STOP] there is no password file at $H/.pgpass"
reset_config; write_pgpass "localhost:5432:neondb:neondb_owner:$SECRET" "$HOST:5432:postgres:neondb_owner:$SECRET"
run pgpass-no-line
expect pgpass-no-line 1 "has no line for this connection: add one that starts with $HOST:5432:neondb:neondb_owner: and continues with the password"
reset_config; write_pgpass "# a comment $SECRET" "*:*:*:*:$SECRET" "$HOST:5432:neondb:neondb_owner:$SECRET"
run pgpass-two-lines
expect pgpass-two-lines 0 'has 2 line(s) for this host' '[note] libpq uses the first of those lines'
reset_config; mv "$H/.pgpass" "$H/elsewhere.pgpass"
run pgpassfile-env PGPASSFILE="$H/elsewhere.pgpass"
expect pgpassfile-env 0 "[ok]   $H/elsewhere.pgpass is private and has 1 line(s)"
reset_config; mv "$H/.pgpass" "$H/elsewhere.pgpass"; write_service "passfile=$H/elsewhere.pgpass"
run passfile-key
expect passfile-key 0 "[ok]   $H/elsewhere.pgpass is private and has 1 line(s)"
reset_config
run pgpassword-set PGPASSWORD="$SECRET"
expect pgpassword-set 1 '[STOP] PGPASSWORD is set in this shell (value not shown)'
run pg-variables PGHOST=elsewhere.example PGOPTIONS=-csearch_path=x
expect pg-variables 0 '[note] this shell sets PGHOST PGOPTIONS (values not shown); the runner clears them'

echo '# the evidence directory'
reset_config; mkdir -m 755 "$H/commissioner-crm-a1-evidence"
run evidence-readable
expect evidence-readable 1 "[STOP] $H/commissioner-crm-a1-evidence is readable by others: chmod 700"
reset_config; mkdir -m 700 "$H/commissioner-crm-a1-evidence"
run evidence-private
expect evidence-private 0 "[ok]   evidence directory $H/commissioner-crm-a1-evidence is private"
reset_config; mkdir -m 700 "$WORK/ev-target"; ln -s "$WORK/ev-target" "$H/commissioner-crm-a1-evidence"
run evidence-symlink
expect evidence-symlink 1 "[STOP] $H/commissioner-crm-a1-evidence is a symbolic link"
reset_config; : > "$H/commissioner-crm-a1-evidence"
run evidence-file
expect evidence-file 1 "[STOP] $H/commissioner-crm-a1-evidence exists and is not a directory"

echo '# psql'
reset_config
run psql-13 FAKE_PSQL_VERSION=13.16
expect psql-13 1 'A1 needs psql 14 or later'
mkdir -p /opt/homebrew/opt/libpq/bin
ln -s "$FAKEBIN/psql" /opt/homebrew/opt/libpq/bin/psql
NOPSQL_PATH="$NOPSQL:$TOOLS"
run psql-homebrew PATH="$NOPSQL_PATH"
expect psql-homebrew 0 '[ok]   psql /opt/homebrew/opt/libpq/bin/psql' '[note] psql is not on PATH; the A1 command below puts /opt/homebrew/opt/libpq/bin first' \
  '  PATH="/opt/homebrew/opt/libpq/bin:$PATH" PP_SERVICE=crm-a1-prod PP_REPO="$HOME/Documents/commissioner-crm-a1" \'
rm /opt/homebrew/opt/libpq/bin/psql
run psql-none PATH="$NOPSQL_PATH"
expect psql-none 1 '[STOP] psql is not installed: install it with: brew install libpq'

echo '# who and where'
reset_config
run not-macos FAKE_UNAME=Linux
check 'not-macos: refused' [ "$RC" -eq 2 ]
check 'not-macos: says so' says 'This preflight is for macOS only.'
run agent CLAUDECODE=1
check 'agent: refused' [ "$RC" -eq 2 ]
check 'agent: says so' says 'Run this yourself in Terminal, not from an AI agent or a CI job (CLAUDECODE is set).'
run ci CI=true
check 'ci: refused' [ "$RC" -eq 2 ]
run no-terminal NOTTY=1
check 'no-terminal: refused' [ "$RC" -eq 2 ]
check 'no-terminal: says so' says 'Run this yourself in a Terminal window.'

printf '\n%s passed, %s failed (preflight %s, bash %s, awk %s)\n' "$PASSED" "$FAILED" "$(sha256sum < "$PREFLIGHT" | awk '{print $1}')" \
  "$("$TBASH" -c 'echo $BASH_VERSION')" "${A1_TEST_AWK:-$(readlink -f "$(command -v awk)")}"
if [ "$FAILED" -ne 0 ]; then printf 'failed:%s\n' "$FAILS"; exit 1; fi
