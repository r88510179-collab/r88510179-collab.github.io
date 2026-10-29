#!/usr/bin/env bash
# Fail-closed regression tests for a1_run.sh, the A1 runner. Linux only, as root, on a disposable machine. It never
# reaches Neon or any other remote host: it re-executes itself in a new network namespace that has only the loopback
# interface, starts a throwaway local PostgreSQL 18 with TLS from a test CA, and drives the runner through a
# pseudo-terminal, since the runner asks for RUN A1 at the terminal.
#
#   bash pool-platform/commissioner-crm/validation/a1_run.test.sh
#
# Two forms of the runner are exercised:
#   - the runner itself, unmodified: every check before a connection; every check on the output, through a fake psql
#     that prints recorded rows and connects nowhere; and, against the local server, its TLS refusal (it pins the
#     production host name, which the local certificate does not carry);
#   - a test copy that differs from it in exactly one line, the expected host (a1-guard-test.invalid, a name that
#     cannot resolve), for real connections to the local server: TLS, the guard, the search-path check, the read-only
#     wrapper and the five SQL files, unchanged, against the Commercial V1 baseline (001 at 48e0ac4e, AUTH-C 002, 003,
#     AUTH-C 004) on a stub of Neon Auth.
#
# Options (environment): A1_TEST_PGBIN, the PostgreSQL 18 server and psql (default /usr/lib/postgresql/18/bin);
# A1_TEST_BASH, the bash that runs the runner (for example a bash 3.2 build, the version of macOS /bin/bash);
# A1_TEST_AWK, an awk to run as awk (for example original-awk, the BWK awk macOS ships); A1_TEST_KEEP=1 keeps the
# work directory. Every psql client found under /usr/lib/postgresql/*/bin also runs the baseline.
set -euo pipefail
export LC_ALL=C
# The suite's own git commands read no global or system configuration (no commit signing, hooks or aliases).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

[ "$(uname -s)" = Linux ] || { echo 'a1_run.test.sh runs on Linux only' >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo 'a1_run.test.sh needs root (unshare, runuser)' >&2; exit 2; }
if [ "${A1_TEST_NETNS:-}" != 1 ]; then
  exec unshare --net -- env A1_TEST_NETNS=1 bash "$0" "$@"
fi
ip link set lo up
if ip -o link show | awk -F': ' '{print $2}' | grep -qv '^lo$' || [ -n "$(ip route show)" ]; then
  echo 'the test network namespace has more than loopback: refusing to run' >&2
  exit 2
fi

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
RUNNER="$HERE/a1_run.sh"
PGBIN=${A1_TEST_PGBIN:-/usr/lib/postgresql/18/bin}
TBASH=${A1_TEST_BASH:-/bin/bash}
PROD_HOST='ep-still-recipe-b5g7680z.c-7.us-east-2.aws.neon.tech'
TEST_HOST='a1-guard-test.invalid'
AUTHC=2c6e2a805fa816638808cb2d96d430ee177453e6
BASE=48e0ac4e0d6a4cd745cdd4ed2a67fc56ef53cb60
V1_COMMIT=9aa4659
PORT=5432 # the runner pins 5432; inside this namespace the port is free
KIT=pool-platform/commissioner-crm/validation
for tool in "$PGBIN/postgres" "$PGBIN/psql" "$PGBIN/pg_dump" "$TBASH" /usr/bin/python3 /usr/bin/openssl /usr/bin/setsid /usr/sbin/runuser /usr/bin/shasum /usr/bin/sha256sum; do
  [ -x "$tool" ] || { echo "missing $tool" >&2; exit 2; }
done
"$PGBIN/postgres" --version | grep -q ' 18\.' || { echo "$PGBIN/postgres is not PostgreSQL 18" >&2; exit 2; }

WORK=$(mktemp -d /var/tmp/a1-runner-test.XXXXXX)
PGDIR=$(mktemp -d /var/lib/postgresql/a1t.XXXXXX)
chown postgres "$PGDIR"
cleanup(){
  runuser -u postgres -- "$PGBIN/pg_ctl" -D "$PGDIR/data" -m immediate stop > /dev/null 2>&1 || true
  if [ "${A1_TEST_KEEP:-}" = 1 ]; then echo "kept $WORK and $PGDIR"; else rm -rf "$WORK" "$PGDIR"; fi
}
trap cleanup EXIT
REPO_STATUS_BEFORE=$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)

PASSED=0
FAILED=0
FAILS=''
ok(){ PASSED=$((PASSED + 1)); printf 'ok   %s\n' "$1"; }
bad(){ FAILED=$((FAILED + 1)); FAILS="$FAILS
  $1"; printf 'FAIL %s\n' "$1"; }
check(){ local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
sha(){ sha256sum < "$1" | awk '{print $1}'; }
TABC=$(printf '\t')

# --- the runner under test and its one-line copies -----------------------------------------------------------------
RUNNER_SHA=$(sha "$RUNNER")
mkdir -p "$WORK/runner" "$WORK/pinrunner"
sed "s/^readonly EXPECT_HOST='$PROD_HOST'\$/readonly EXPECT_HOST='$TEST_HOST'/" "$RUNNER" > "$WORK/runner/a1_run.sh"
TEST_RUNNER="$WORK/runner/a1_run.sh"
TEST_RUNNER_SHA=$(sha "$TEST_RUNNER")
diff_is(){ # file-a file-b old-line new-line: the two files differ in exactly that one line
  local d
  d=$(diff "$1" "$2" | grep '^[<>]' || true)
  [ "$d" = "< $3
> $4" ]
}
check 'the test copy differs from the runner only in the expected host' \
  diff_is "$RUNNER" "$TEST_RUNNER" "readonly EXPECT_HOST='$PROD_HOST'" "readonly EXPECT_HOST='$TEST_HOST'"
# A copy whose pin for the identity audit is wrong: the AUTH-C files are checked like the others.
AUDIT_PIN=d512b94f8281fd201bcecb3efae3eb39fda2ab372b921d8f4a224bec012dca61
ZERO_PIN=0000000000000000000000000000000000000000000000000000000000000000
sed "s/^       $AUDIT_PIN)\$/       $ZERO_PIN)/" "$RUNNER" > "$WORK/pinrunner/a1_run.sh"
PIN_RUNNER="$WORK/pinrunner/a1_run.sh"
check 'the pin copy differs from the runner only in the identity-audit pin' \
  diff_is "$RUNNER" "$PIN_RUNNER" "       $AUDIT_PIN)" "       $ZERO_PIN)"

# --- repository checkouts the runner reads (it never writes to them) ------------------------------------------------
CLONE="$WORK/repo"
git clone -q --shared "$REPO" "$CLONE"
git -C "$CLONE" checkout -q "$(git -C "$REPO" rev-parse HEAD)"
git -C "$CLONE" cat-file -e "$AUTHC^{commit}"
TCLONE="$WORK/repo-tamper"
git clone -q --shared "$REPO" "$TCLONE"
git -C "$TCLONE" checkout -q "$(git -C "$REPO" rev-parse HEAD)"
for f in A1_AUTHORIZATION.md P1_identity_helpers_004.sql P2_private_schema_inventory.sql P3_crm_preconditions.sql; do
  cmp -s "$HERE/$f" "$CLONE/$KIT/$f" || { echo "the checkout's $f differs from the working tree" >&2; exit 2; }
done
NOAUTHC="$WORK/repo-no-authc"
mkdir -p "$NOAUTHC/$KIT"
cp "$CLONE/$KIT"/A1_AUTHORIZATION.md "$CLONE/$KIT"/P[123]_*.sql "$NOAUTHC/$KIT/"
git -C "$NOAUTHC" init -q
git -C "$NOAUTHC" add -A
git -C "$NOAUTHC" -c user.name=a1-test -c user.email=a1-test@example.invalid commit -q -m 'kit only'
OTHER_REPO="$WORK/other-repo"
git init -q "$OTHER_REPO"
CLONE_STATUS_BEFORE=$(git -C "$CLONE" status --porcelain=v1 --untracked-files=all)

# --- TLS: a test CA, a server certificate for the two test names, and an unrelated CA ---------------------------------
TLS="$WORK/tls"
mkdir -p "$TLS"
(
  cd "$TLS"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj '/CN=A1 test CA' 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=$TEST_HOST" 2>/dev/null
  printf 'subjectAltName=DNS:%s,DNS:other-host.invalid\n' "$TEST_HOST" > san.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile san.ext 2>/dev/null
  openssl req -x509 -newkey rsa:2048 -nodes -keyout wrong-ca.key -out wrong-ca.crt -days 2 -subj '/CN=A1 wrong CA' 2>/dev/null
)
install -o postgres -m 600 "$TLS/server.key" "$PGDIR/server.key"
install -o postgres -m 644 "$TLS/server.crt" "$PGDIR/server.crt"

# --- the throwaway server: TCP on loopback with TLS only, plus a socket for the test's own administration -----------
PW="a1-test-only-$(openssl rand -hex 12)"
runuser -u postgres -- "$PGBIN/initdb" -D "$PGDIR/data" --auth=trust > "$WORK/initdb.log" 2>&1
mkdir -p "$PGDIR/sock"
chown postgres "$PGDIR/sock"
cat > "$PGDIR/data/pg_hba.conf" <<HBA
local   all  postgres                 peer
hostssl all  all       127.0.0.1/32   scram-sha-256
HBA
cat >> "$PGDIR/data/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
port = $PORT
unix_socket_directories = '$PGDIR/sock'
ssl = on
ssl_cert_file = '$PGDIR/server.crt'
ssl_key_file = '$PGDIR/server.key'
log_statement = 'all'
log_connections = on
log_line_prefix = '%m [%p] %u@%d '
CONF
chown postgres "$PGDIR/data/pg_hba.conf" "$PGDIR/data/postgresql.conf"
runuser -u postgres -- "$PGBIN/pg_ctl" -D "$PGDIR/data" -l "$PGDIR/server.log" -w start > /dev/null
admin(){ runuser -u postgres -- "$PGBIN/psql" -h "$PGDIR/sock" -p "$PORT" -X -q -v ON_ERROR_STOP=1 "$@"; }
owner(){ PGPASSWORD="$PW" "$PGBIN/psql" "host=127.0.0.1 port=$PORT dbname=neondb user=neondb_owner sslmode=require" -X -q -v ON_ERROR_STOP=1 "$@"; }
dump(){ runuser -u postgres -- "$PGBIN/pg_dump" --restrict-key=a1test -h "$PGDIR/sock" -p "$PORT" -d neondb 2>/dev/null; }

admin -d postgres -v pw="$PW" > /dev/null <<'SQL'
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anonymous NOLOGIN;
CREATE ROLE neondb_owner LOGIN NOSUPERUSER CREATEDB PASSWORD :'pw';
CREATE ROLE other_login LOGIN NOSUPERUSER PASSWORD :'pw';
GRANT authenticated TO neondb_owner;
CREATE DATABASE neondb OWNER neondb_owner;
CREATE DATABASE otherdb OWNER neondb_owner;
SQL
# Neon Auth stood in for as in the AUTH-C integration test (pool-platform/migration-integration.test.mjs).
admin -d neondb > /dev/null <<'SQL'
CREATE EXTENSION pgcrypto SCHEMA public;
CREATE SCHEMA neon_auth;
CREATE TABLE neon_auth."user" (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL, name text NOT NULL, email text NOT NULL,
  "emailVerified" boolean NOT NULL, image text, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, role text, banned boolean, "banReason" text,
  "banExpires" timestamptz, CONSTRAINT user_email_key UNIQUE (email));
CREATE TABLE neon_auth.account (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES neon_auth."user"(id) ON DELETE CASCADE, "accessToken" text, "refreshToken" text,
  "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, scope text, password text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz NOT NULL);
CREATE TABLE neon_auth.session (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL, "expiresAt" timestamptz NOT NULL, token text NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL, "updatedAt" timestamptz NOT NULL, "ipAddress" text,
  "userAgent" text, "userId" uuid NOT NULL REFERENCES neon_auth."user"(id) ON DELETE CASCADE, "impersonatedBy" text,
  "activeOrganizationId" text, CONSTRAINT session_token_key UNIQUE (token));
CREATE SCHEMA auth;
CREATE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('pp_test.user_id', true), '') $$;
CREATE FUNCTION auth.session() RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT COALESCE(NULLIF(current_setting('pp_test.session', true), '')::jsonb, 'null'::jsonb) $$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT USAGE ON SCHEMA neon_auth TO neondb_owner;
GRANT SELECT ON neon_auth."user", neon_auth.account, neon_auth.session TO neondb_owner;
-- The window's live sessions: D one, E two, A one, all verified users without an account row; and one synthetic,
-- unverified live-harness identity with a password account and no session.
INSERT INTO neon_auth."user"(name,email,"emailVerified") VALUES
  ('D','d.window@example.test',true),('E','e.window@example.test',true),('A','a.window@example.test',true),
  ('X','pp-cv1-r1-x.player@example.com',false);
INSERT INTO neon_auth.session("expiresAt",token,"updatedAt","userId")
  SELECT now() + interval '7 days', gen_random_uuid()::text, now(), u.id
  FROM neon_auth."user" u CROSS JOIN generate_series(1,2) g
  WHERE u.name IN ('D','E','A') AND (g = 1 OR u.name = 'E');
INSERT INTO neon_auth.account("accountId","providerId","userId",password,"updatedAt")
  SELECT id::text,'credential',id,'a1-test-password-hash',now() FROM neon_auth."user" WHERE name='X';
SQL
for m in "$BASE:pool-platform/migrations/001_foundation.sql" "$AUTHC:pool-platform/migrations/002_identity_submission_rls.sql" \
         "$BASE:pool-platform/migrations/003_submit_entry_authorization_order.sql" "$AUTHC:pool-platform/migrations/004_identity_pre_registration_hardening.sql"; do
  git -C "$REPO" show "$m" | owner -1 > /dev/null 2>> "$WORK/setup.log"
done
# pool_platform_private as the Data API listed it: present, reachable by no Data API role.
owner > /dev/null <<'SQL'
CREATE SCHEMA pool_platform_private;
CREATE TABLE pool_platform_private.private_note(id int PRIMARY KEY, note text);
CREATE FUNCTION pool_platform_private.private_helper() RETURNS int LANGUAGE sql AS 'SELECT 1';
SQL

# --- client configuration: service entries, password files, a home directory ------------------------------------------
# The runner pins host, port, database, role, sslmode and gssencmode in its connection string; an entry supplies the
# rest (here hostaddr, which points the pinned name at the local server, and the TLS root).
service(){ # name host hostaddr dbname user rootcert [extra]
  printf '[%s]\nhost=%s\nhostaddr=%s\nport=%s\ndbname=%s\nuser=%s\nsslrootcert=%s\n%s\n' "$1" "$2" "$3" "$PORT" "$4" "$5" "$6" "${7:-}"
}
{
  service a1test         "$TEST_HOST"       127.0.0.1 neondb  neondb_owner "$TLS/ca.crt"
  service a1test_nossl   "$TEST_HOST"       127.0.0.1 neondb  neondb_owner "$TLS/ca.crt" 'sslmode=disable'
  service a1test_gss     "$TEST_HOST"       127.0.0.1 neondb  neondb_owner "$TLS/ca.crt" 'gssencmode=require'
  service a1test_other   other-host.invalid 127.0.0.1 neondb  neondb_owner "$TLS/ca.crt"
  service a1test_db      "$TEST_HOST"       127.0.0.1 otherdb neondb_owner "$TLS/ca.crt"
  service a1test_role    "$TEST_HOST"       127.0.0.1 neondb  other_login  "$TLS/ca.crt"
  printf '[a1test_port]\nhost=%s\nhostaddr=127.0.0.1\nport=54330\nsslrootcert=%s\n\n' "$TEST_HOST" "$TLS/ca.crt"
  service a1test_badca   "$TEST_HOST"       127.0.0.1 neondb  neondb_owner "$TLS/wrong-ca.crt"
  service a1test_closed  "$TEST_HOST"       127.0.0.2 neondb  neondb_owner "$TLS/ca.crt"
  service a1test_options "$TEST_HOST"       127.0.0.1 neondb  neondb_owner "$TLS/ca.crt" 'options=-c search_path=a1t_evil,pg_catalog,public'
} > "$WORK/pg_service.conf"
{
  printf '%s:%s:neondb:neondb_owner:%s\n' "$TEST_HOST" "$PORT" "$PW"
  printf '%s:%s:otherdb:neondb_owner:%s\n' "$TEST_HOST" "$PORT" "$PW"
  printf '%s:%s:neondb:other_login:%s\n' "$TEST_HOST" "$PORT" "$PW"
  printf 'other-host.invalid:%s:neondb:neondb_owner:%s\n' "$PORT" "$PW"
} > "$WORK/pgpass"
printf '%s:%s:neondb:neondb_owner:wrong-%s\n' "$TEST_HOST" "$PORT" "$PW" > "$WORK/pgpass-wrong"
: > "$WORK/pgpass-empty"
chmod 600 "$WORK/pgpass" "$WORK/pgpass-wrong" "$WORK/pgpass-empty"
THOME="$WORK/home"
mkdir -p "$THOME/Documents" "$THOME/DOCUMENTS" "$THOME/Library/Mobile Documents/com~apple~CloudDocs"
ln -s "$THOME/Library/Mobile Documents/com~apple~CloudDocs" "$WORK/icloud"
HOME_LIST_BEFORE=$(cd "$THOME" && find . | sort)

# --- tools: the awk under test, the fake psql, restricted PATHs -------------------------------------------------------
AWKBIN="$WORK/awkbin"
mkdir -p "$AWKBIN"
if [ -n "${A1_TEST_AWK:-}" ]; then ln -s "$(command -v "$A1_TEST_AWK")" "$AWKBIN/awk"; fi
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/psql" <<'FAKE'
#!/bin/bash
# Fake psql: connects nowhere. Records its arguments, its environment and the script the runner sends, then prints
# the recorded rows for the file the script names, from $FAKE_FIX/<file>.stdout, .stderr, .rc and .kill (a signal).
set -u
if [ "${1:-}" = --version ]; then echo 'psql (PostgreSQL) 18.6 (a1 test fake)'; exit 0; fi
log=${FAKE_LOG:?}
fix=${FAKE_FIX:?}
/bin/mkdir -p "$log"
n=1
while [ -e "$log/args.$n" ]; do n=$((n + 1)); done
printf '%s\n' "$@" > "$log/args.$n"
/usr/bin/env > "$log/env.$n"
/bin/cat > "$log/stdin.$n"
file=''
while IFS= read -r line; do
  case $line in "\\i '"*) file=${line##*/}; file=${file%\'} ;; esac
done < "$log/stdin.$n"
printf '%s\n' "$file" >> "$log/files"
base=${file%.sql}
if [ -f "$fix/$base.stdout" ]; then /bin/cat "$fix/$base.stdout"; fi
if [ -f "$fix/$base.stderr" ]; then /bin/cat "$fix/$base.stderr" >&2; fi
if [ -f "$fix/$base.kill" ]; then
  sig=$(/bin/cat "$fix/$base.kill")
  case $sig in *-GROUP) kill -"${sig%-GROUP}" 0 ;; *) kill -"$sig" "$PPID" ;; esac
fi
rc=0
if [ -f "$fix/$base.rc" ]; then rc=$(/bin/cat "$fix/$base.rc"); fi
exit "$rc"
FAKE
chmod 755 "$FAKEBIN/psql"
RUNNER_TOOLS='git awk sed grep tr date cp mkdir chmod head wc ls dirname basename rmdir'
bindir(){ # name psql-source tool...: a directory holding exactly these tools
  local d="$WORK/bin-$1" src=$2 t p
  shift 2
  mkdir -p "$d"
  [ "$src" = none ] || ln -s "$src" "$d/psql"
  for t in "$@"; do
    if [ "$t" = awk ] && [ -e "$AWKBIN/awk" ]; then p="$AWKBIN/awk"; else p=$(command -v "$t"); fi
    ln -s "$p" "$d/$t"
  done
}
without(){ printf '%s\n' $RUNNER_TOOLS | grep -vx "$1"; }
bindir full-fake "$FAKEBIN/psql" $RUNNER_TOOLS shasum sha256sum openssl
bindir full-real "$PGBIN/psql" $RUNNER_TOOLS shasum sha256sum openssl
bindir shasum "$FAKEBIN/psql" $RUNNER_TOOLS shasum
bindir sha256sum "$FAKEBIN/psql" $RUNNER_TOOLS sha256sum
bindir openssl "$FAKEBIN/psql" $RUNNER_TOOLS openssl
bindir nosha "$FAKEBIN/psql" $RUNNER_TOOLS
bindir nopsql none $RUNNER_TOOLS shasum
bindir nogit "$FAKEBIN/psql" $(without git) shasum
bindir noawk "$FAKEBIN/psql" $(without awk) shasum
bindir notr "$FAKEBIN/psql" $(without tr) shasum
cat > "$WORK/fake-shasum" <<'FAKE'
#!/bin/bash
# shasum stand-in: hashes stdin as shasum -a 256 does, but fails on the manifest once it records the HOLD outcome.
t=$(/usr/bin/mktemp) || exit 1
/bin/cat > "$t"
if /bin/grep -qx 'outcome HOLD exit 10' "$t"; then /bin/rm -f "$t"; exit 1; fi
/usr/bin/sha256sum < "$t"
rc=$?
/bin/rm -f "$t"
exit "$rc"
FAKE
printf '#!/bin/bash\necho "ls: cannot open directory: Permission denied" >&2\nexit 2\n' > "$WORK/fake-ls"
chmod 755 "$WORK/fake-shasum" "$WORK/fake-ls"
bindir unhashable "$FAKEBIN/psql" $RUNNER_TOOLS
ln -s "$WORK/fake-shasum" "$WORK/bin-unhashable/shasum"
bindir lsfails "$FAKEBIN/psql" $(without ls) shasum
ln -s "$WORK/fake-ls" "$WORK/bin-lsfails/ls"
FAKE_PATH="$AWKBIN:$FAKEBIN:/usr/bin:/bin"
REAL_PATH="$AWKBIN:$PGBIN:/usr/bin:/bin"

# The pseudo-terminal driver: runs the command with stdout and stderr in files and answers the runner's prompt.
cat > "$WORK/tty_run.py" <<'PY'
import os, select, signal, sys, time
answer, out_path, err_path, tty_path, cwd = sys.argv[1:6]
cmd = sys.argv[6:]
pid, fd = os.forkpty()
if pid == 0:
    try:
        if cwd != '-':
            os.chdir(cwd)
        out = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        err = os.open(err_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.dup2(out, 1)
        os.dup2(err, 2)
        os.execv(cmd[0], cmd)
    finally:
        os._exit(127)
transcript, answered, status = b'', False, None
deadline = time.monotonic() + 300
while status is None:
    if time.monotonic() > deadline:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        transcript += b'\n[tty_run: timeout]\n'
        status = 124 << 8
        break
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if data:
            transcript += data
            if not answered and b'Type RUN A1' in transcript:
                answered = True
                os.write(fd, b'\x04' if answer == '__EOF__' else answer.encode() + b'\n')
            continue
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st
with open(tty_path, 'wb') as f:
    f.write(transcript)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
PY

# --- running one case ------------------------------------------------------------------------------------------------
# run_case NAME RUNNER ANSWER [VAR=value | -VAR]...: runs RUNNER with a minimal environment on a fresh evidence
# directory, through a pseudo-terminal that answers ANSWER (__EOF__ sends end-of-file), or with no terminal at all
# when ANSWER is NOTTY. A relative RUNNER needs PP_RUNNER_SHA256 given. Sets CASE, EV, RC and LOG_RUN (the server's
# log lines written during the case).
CWD='-'
run_case(){
  local name=$1 runner=$2 answer=$3 a k rsha='' log_start
  shift 3
  case $runner in /*) rsha=$(sha "$runner") ;; esac
  CASE="$WORK/cases/$name"
  EV="$WORK/ev/$name"
  mkdir -p "$CASE" "$WORK/ev"
  declare -A E=([PATH]="$FAKE_PATH" [HOME]="$THOME" [PGSERVICEFILE]="$WORK/pg_service.conf" [PGPASSFILE]="$WORK/pgpass"
                [PP_SERVICE]=a1test [PP_REPO]="$CLONE" [PP_OUT]="$EV" [PP_RUNNER_SHA256]="$rsha"
                [FAKE_FIX]="$FIX_BASE" [FAKE_LOG]="$CASE/fake")
  for a in "$@"; do
    case $a in -*) unset "E[${a#-}]" ;; *=*) E[${a%%=*}]=${a#*=} ;; esac
  done
  local -a envl=()
  for k in "${!E[@]}"; do envl+=("$k=${E[$k]}"); done
  log_start=$(wc -c < "$PGDIR/server.log")
  RC=0
  if [ "$answer" = NOTTY ]; then
    setsid -w env -i "${envl[@]}" "$TBASH" "$runner" > "$CASE/stdout" 2> "$CASE/stderr" < /dev/null || RC=$?
    : > "$CASE/tty"
  else
    env -i "${envl[@]}" /usr/bin/python3 -I "$WORK/tty_run.py" "$answer" "$CASE/stdout" "$CASE/stderr" "$CASE/tty" "$CWD" \
      "$TBASH" "$runner" || RC=$?
  fi
  LOG_RUN=$(tail -c +"$((log_start + 1))" "$PGDIR/server.log")
}
last_line(){ [ "$(tail -n 1 "$CASE/stdout")" = "$1" ]; }
said(){ grep -qF -- "$1" "$CASE/stdout" "$CASE/stderr"; }
not_said(){ ! grep -qF -- "$1" "$CASE/stdout" "$CASE/stderr" "$CASE/tty"; }
files_run(){ [ "$(cat "$CASE/fake/files" 2>/dev/null | tr '\n' ' ')" = "$1" ]; }
no_psql(){ [ ! -e "$CASE/fake/files" ]; }
outs(){ [ "$(cd "$EV/out" 2>/dev/null && ls *.tsv 2>/dev/null | tr '\n' ' ')" = "$1" ]; }
manifest_has(){ grep -qxF -- "$1" "$EV/manifest.txt"; }
sums_verify(){ (cd "$EV" && sha256sum --check --quiet --strict sha256sums.txt && shasum -a 256 --check --quiet sha256sums.txt); }
holds(){ [ "$(grep -c '^  - ' "$CASE/stdout")" -eq "$1" ]; }
only_owner_sessions(){ # every connection the server authorized during the case was neondb_owner on neondb, over TLS
  local n
  n=$(grep -c 'connection authorized:' <<<"$LOG_RUN" || true)
  [ "$n" -gt 0 ] && [ "$(grep 'connection authorized:' <<<"$LOG_RUN" | grep -c 'user=neondb_owner database=neondb .*SSL enabled')" -eq "$n" ]
}
# expect NAME CODE TEXT: the result line and code are CODE's, and the output says TEXT.
expect(){
  local name=$1 code=$2 text=$3 result
  case $code in 10) result='A1 RESULT: HOLD (exit 10)' ;; *) result="A1 RESULT: STOP (exit $code)" ;; esac
  check "$name: exit $code" [ "$RC" -eq "$code" ]
  check "$name: last line is the result" last_line "$result"
  check "$name: says: $text" said "$text"
}
P1=P1_identity_helpers_004.sql P2=P2_private_schema_inventory.sql P3=P3_crm_preconditions.sql
CV=neon-catalog-verify.sql IA=neon-identity-audit.sql
ALL_FILES="$P1 $P2 $P3 $CV $IA "
ALL_OUTS='P1_identity_helpers_004.tsv P2_private_schema_inventory.tsv P3_crm_preconditions.tsv neon-catalog-verify.tsv neon-identity-audit.tsv '
FIX_BASE="$WORK/fix/none"
mkdir -p "$FIX_BASE"
p2_hold(){ # relations functions other-objects foreign-keys views triggers outside-dependents: the P2 HOLD line
  printf 'P2: pool_platform_private holds %s relation(s), %s function(s) and %s other object(s); %s foreign key(s) and %s view dependency(ies) involve it, %s trigger(s) on its own relations call its code, and %s object(s) outside it depend on it, directly or through views and functions' "$@"
}
P2_HOLD=$(p2_hold 1 1 0 0 0 0 0)
P2_ABSENT='P2: pool_platform_private is absent, although the Data API listed it on 2026-10-28; the owner confirms why'
EXTRA_ZERO="A1-EXTRA${TABC}0${TABC}0${TABC}0${TABC}${TABC}0${TABC}${TABC}0${TABC}${TABC}0${TABC}"

# --- 1. the baseline, for real, through the test copy -----------------------------------------------------------------
echo '# real server, test copy: the baseline'
DUMP_BEFORE=$(dump)
run_case real-baseline "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH"
BASELINE_LOG=$LOG_RUN
expect real-baseline 10 "$P2_HOLD"
for pair in "$P1 H99" "$P3 X99" "$CV C99" "$IA I99"; do
  set -- $pair
  check "real-baseline: $1 $2 PASS" said "$1: $2 PASS, every required check ok"
done
check "real-baseline: $P2 kept whole for the owner" said "$P2: HOLD, 4 inventory rows and the runner's catalog row kept whole for the owner"
check 'real-baseline: exactly one HOLD item (P2)' holds 1
check 'real-baseline: all five outputs kept' outs "$ALL_OUTS"
check 'real-baseline: no diagnostics from psql' [ -z "$(cat "$EV"/out/*.stderr)" ]
check 'real-baseline: the manifest records the runner hash' manifest_has "a1_runner_sha256 $TEST_RUNNER_SHA"
check 'real-baseline: the staged runner copy has that hash' manifest_has "source a1_run.sh $TEST_RUNNER_SHA"
check 'real-baseline: the manifest records the authorization hash' manifest_has 'source A1_AUTHORIZATION.md 8de895da4d7f75eb5654497a41c6e7c0f888f64d65c76d2a711725d872331c12'
check 'real-baseline: the manifest records, for each session, the TLS flag and that the role cannot alter the Neon Auth tables' bash -c "[ \"\$(grep -c '^session .* server_ssl=true neon_auth_alterable=false\$' '$EV/manifest.txt')\" -eq 5 ]"
check 'real-baseline: the manifest records the outcome' manifest_has 'outcome HOLD exit 10'
check 'real-baseline: sha256sums.txt verifies with sha256sum and shasum' sums_verify
check 'real-baseline: sha256sums.txt covers the manifest, 7 sources and 10 outputs' [ "$(wc -l < "$EV/sha256sums.txt")" -eq 18 ]
check 'real-baseline: the evidence directory is private' [ "$(stat -c %a "$EV")" = 700 ]
check 'real-baseline: every evidence file is private' [ -z "$(find "$EV" -type f ! -perm 600)" ]
check 'real-baseline: the password appears nowhere in the evidence' bash -c "! grep -rqF -- '$PW' '$EV'"
check 'real-baseline: the password appears nowhere in the output' not_said "$PW"
check 'real-baseline: the database is unchanged (pg_dump before and after)' [ "$DUMP_BEFORE" = "$(dump)" ]
check 'real-baseline: the server ran BEGIN READ ONLY five times' [ "$(grep -c 'neondb_owner@neondb LOG:  statement: BEGIN READ ONLY;' <<<"$BASELINE_LOG")" -eq 5 ]
check 'real-baseline: the server ran ROLLBACK five times' [ "$(grep -c 'neondb_owner@neondb LOG:  statement: ROLLBACK;' <<<"$BASELINE_LOG")" -eq 5 ]
check 'real-baseline: the server saw no COMMIT, SET or write' bash -c "! grep -iE 'statement: *(COMMIT|END|SET |RESET|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)' <<<\"\$1\"" _ "$BASELINE_LOG"
check 'real-baseline: every connection was neondb_owner on neondb over TLS' only_owner_sessions
check 'real-baseline: the extra row, all zero, is in the P2 output' grep -qx "$EXTRA_ZERO" "$EV/out/P2_private_schema_inventory.tsv"
check 'real-baseline: P2 ends with its row count, the extra row and its row count' \
  [ "$(tail -n 3 "$EV/out/P2_private_schema_inventory.tsv" | tr '\t\n' '|#')" = "A1-ROWS 4#${EXTRA_ZERO//$TABC/|}#A1-ROWS 1#" ]
check 'real-baseline: the overload check found nothing in public (pgcrypto included)' [ ! -s "$EV/out/P1_identity_helpers_004.stderr" ]
# The recorded rows become the fake psql's fixtures, with the production host in the session row.
mkdir -p "$WORK/fix/base"
for f in "$EV"/out/*.tsv; do
  awk -F'\t' -v OFS='\t' -v h="$PROD_HOST" 'NR == 1 { $4 = h } 1' "$f" > "$WORK/fix/base/$(basename "${f%.tsv}").stdout"
done
FIX_BASE="$WORK/fix/base"
REAL_BASELINE_EV="$EV"
same_rows(){ for f in "$REAL_BASELINE_EV"/out/*.tsv; do cmp -s "$f" "$EV/out/$(basename "$f")" || return 1; done; }

for pbin in /usr/lib/postgresql/*/bin; do
  [ -x "$pbin/psql" ] || continue
  v=$("$pbin/psql" --version | awk '{print $3}')
  run_case "real-psql-$v" "$TEST_RUNNER" 'RUN A1' PATH="$AWKBIN:$pbin:/usr/bin:/bin"
  expect "real baseline with psql $v" 10 "$P2_HOLD"
  check "real baseline with psql $v: the same rows" same_rows
done
run_case real-restricted-path "$TEST_RUNNER" 'RUN A1' PATH="$WORK/bin-full-real"
expect 'real baseline with only the listed tools on PATH' 10 "$P2_HOLD"
# The connection string pins the target: what the service entry says about it changes nothing.
pinned(){ # name service
  run_case "$1" "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH" PP_SERVICE="$2"
  expect "$1" 10 "$P2_HOLD"
  check "$1: every connection was neondb_owner on neondb over TLS" only_owner_sessions
  check "$1: the same rows" same_rows
}
pinned service-sslmode-disable a1test_nossl
pinned service-gssencmode-require a1test_gss
pinned service-other-host a1test_other
pinned service-other-database a1test_db
pinned service-other-role a1test_role
pinned service-other-port a1test_port

# --- 2. before any connection: the unmodified runner ------------------------------------------------------------------
echo '# before any connection: the runner itself'
pre(){ # name code text [run_case args]: a STOP before any connection, with no psql started
  local name=$1 code=$2 text=$3
  shift 3
  run_case "$name" "$RUNNER" 'RUN A1' "$@"
  expect "$name" "$code" "$text"
  check "$name: psql never started" no_psql
}
pre agent-claudecode 2 'because CLAUDECODE is set' CLAUDECODE=1
check 'agent-claudecode: no evidence directory created' [ ! -e "$EV" ]
pre agent-entrypoint 2 'because CLAUDE_CODE_ENTRYPOINT is set' CLAUDE_CODE_ENTRYPOINT=cli
pre agent-remote 2 'because CLAUDE_CODE_REMOTE is set' CLAUDE_CODE_REMOTE=true
pre ci 2 'because CI is set' CI=true
pre github-actions 2 'because GITHUB_ACTIONS is set' GITHUB_ACTIONS=true
pre missing-psql 2 'the required tool psql is not on PATH' PATH="$WORK/bin-nopsql"
pre missing-git 2 'the required tool git is not on PATH' PATH="$WORK/bin-nogit"
pre missing-awk 2 'the required tool awk is not on PATH' PATH="$WORK/bin-noawk"
pre missing-tr 2 'the required tool tr is not on PATH' PATH="$WORK/bin-notr"
pre missing-sha256 2 'no SHA-256 tool' PATH="$WORK/bin-nosha"
pre service-unset 2 'PP_SERVICE is not set' -PP_SERVICE
pre service-bad 2 'PP_SERVICE may contain only' 'PP_SERVICE=a1test host=elsewhere'
pre repo-unset 2 'PP_REPO must be an absolute path' -PP_REPO
pre repo-relative 2 'PP_REPO must be an absolute path' PP_REPO=repo
pre repo-not-git 2 'PP_REPO is not a git checkout' PP_REPO="$WORK/tls"
pre out-unset 2 'PP_OUT must be an absolute path' -PP_OUT
pre out-relative 2 'PP_OUT must be an absolute path' PP_OUT=evidence
pre out-space 2 'PP_OUT must be an absolute path' "PP_OUT=$WORK/ev/with space"
pre hash-unset 2 'PP_RUNNER_SHA256 must be the approved' -PP_RUNNER_SHA256
pre hash-upper 2 'PP_RUNNER_SHA256 must be the approved' PP_RUNNER_SHA256="$(printf '%s' "$RUNNER_SHA" | tr a-f A-F)"
pre hash-short 2 'PP_RUNNER_SHA256 must be the approved' PP_RUNNER_SHA256="${RUNNER_SHA%?}"
pre hash-wrong 2 "this runner's SHA-256 is $RUNNER_SHA, not the approved $TEST_RUNNER_SHA" PP_RUNNER_SHA256="$TEST_RUNNER_SHA"
pre out-in-repo 2 'PP_OUT is inside the repository' PP_OUT="$CLONE/evidence"
check 'out-in-repo: the directory it created is removed' [ ! -e "$CLONE/evidence" ]
ln -s "$CLONE" "$WORK/repo-link"
pre out-in-repo-symlink 2 'PP_OUT is inside the repository' PP_OUT="$WORK/repo-link/evidence"
check 'out-in-repo-symlink: the directory it created is removed' [ ! -e "$CLONE/evidence" ]
pre out-in-repo-other-case 2 'PP_OUT is inside the repository' PP_OUT="$WORK/REPO/evidence"
pre out-in-other-repository 2 "PP_OUT is inside the git repository at $OTHER_REPO" PP_OUT="$OTHER_REPO/evidence"
check 'out-in-other-repository: the directory it created is removed' [ ! -e "$OTHER_REPO/evidence" ]
mkdir -p "$WORK/ev/not-empty"
echo keep > "$WORK/ev/not-empty/existing"
pre out-not-empty 2 'PP_OUT is not empty' PP_OUT="$WORK/ev/not-empty"
check 'out-not-empty: the existing file is untouched' [ "$(cat "$WORK/ev/not-empty/existing")" = keep ]
mkdir -p "$WORK/ev/real-empty"
ln -s "$WORK/ev/real-empty" "$WORK/ev/link-to-empty"
pre out-symlink 2 'PP_OUT exists and is not a plain directory' PP_OUT="$WORK/ev/link-to-empty"
echo file > "$WORK/ev/a-file"
pre out-file 2 'PP_OUT exists and is not a plain directory' PP_OUT="$WORK/ev/a-file"
pre out-documents 2 'PP_OUT is inside a folder that may be synced' PP_OUT="$THOME/Documents/a1-evidence"
check 'out-documents: the directory it created is removed' [ ! -e "$THOME/Documents/a1-evidence" ]
pre out-documents-other-case 2 'PP_OUT is inside a folder that may be synced' PP_OUT="$THOME/DOCUMENTS/a1-evidence"
check 'out-documents-other-case: the directory it created is removed' [ ! -e "$THOME/DOCUMENTS/a1-evidence" ]
pre out-icloud 2 'PP_OUT is inside a folder that may be synced' PP_OUT="$WORK/icloud/a1-evidence"
check 'out-icloud: the directory it created is removed' [ ! -e "$WORK/icloud/a1-evidence" ]
# A leading //, which pwd -P keeps, changes no path comparison.
pre out-documents-double-slash 2 'PP_OUT is inside a folder that may be synced' PP_OUT="/$THOME/Documents/a1-evidence"
check 'out-documents-double-slash: the directory it created is removed' [ ! -e "$THOME/Documents/a1-evidence" ]
pre home-double-slash 2 'PP_OUT is inside a folder that may be synced' HOME="/$THOME" PP_OUT="$THOME/Documents/a1-evidence"
check 'home-double-slash: the directory it created is removed' [ ! -e "$THOME/Documents/a1-evidence" ]
pre repo-double-slash 2 'PP_OUT is inside the repository' PP_REPO="/$CLONE" PP_OUT="$CLONE/evidence"
check 'repo-double-slash: the directory it created is removed' [ ! -e "$CLONE/evidence" ]
mkdir -p "$WORK/ev/ls-fails"
pre ls-fails 2 'cannot list PP_OUT' PATH="$WORK/bin-lsfails" PP_OUT="$WORK/ev/ls-fails"
check 'ls-fails: the existing directory is kept' [ -d "$WORK/ev/ls-fails" ]
tamper(){ # name file: change one byte of a kit file in the tamper clone, run, restore
  local name=$1 file=$2
  printf ' ' >> "$TCLONE/$KIT/$file"
  pre "$name" 2 "$file does not match its pinned SHA-256" PP_REPO="$TCLONE"
  git -C "$TCLONE" checkout -q -- "$KIT/$file"
}
tamper tamper-authorization A1_AUTHORIZATION.md
check 'tamper-authorization: the manifest records the STOP' manifest_has 'outcome STOP exit 2'
tamper tamper-p1 "$P1"
tamper tamper-p2 "$P2"
tamper tamper-p3 "$P3"
cp "$TCLONE/$KIT/$P3" "$WORK/p3-copy.sql"
rm "$TCLONE/$KIT/$P3"
ln -s "$WORK/p3-copy.sql" "$TCLONE/$KIT/$P3"
pre kit-symlink 2 'missing, or not a regular file' PP_REPO="$TCLONE"
git -C "$TCLONE" checkout -q -- "$KIT/$P3"
rm "$TCLONE/$KIT/$P1"
pre kit-missing 2 'missing, or not a regular file' PP_REPO="$TCLONE"
git -C "$TCLONE" checkout -q -- "$KIT/$P1"
check 'the tamper clone is restored' [ -z "$(git -C "$TCLONE" status --porcelain)" ]
pre no-authc 2 "the AUTH-C commit $AUTHC is not in PP_REPO" PP_REPO="$NOAUTHC"
run_case pin-authc "$PIN_RUNNER" 'RUN A1'
expect pin-authc 2 "neon-identity-audit.sql does not match its pinned SHA-256: expected $ZERO_PIN, found $AUDIT_PIN"
check 'pin-authc: psql never started' no_psql
ln -s "$RUNNER" "$WORK/runner-link.sh"
run_case runner-symlink "$WORK/runner-link.sh" 'RUN A1'
expect runner-symlink 2 'missing, or not a regular file'
check 'runner-symlink: psql never started' no_psql
run_case no-tty "$RUNNER" NOTTY
expect no-tty 2 'no terminal: run A1 yourself from a terminal window'
check 'no-tty: psql never started' no_psql
check 'no-tty: the manifest records the STOP' manifest_has 'outcome STOP exit 2'
run_case wrong-answer "$RUNNER" 'run a1'
expect wrong-answer 2 'not confirmed at the terminal'
check 'wrong-answer: psql never started' no_psql
run_case answer-with-space "$RUNNER" 'RUN A1 '
expect answer-with-space 2 'not confirmed at the terminal'
run_case answer-eof "$RUNNER" __EOF__
expect answer-eof 2 'not confirmed at the terminal'
check 'answer-eof: psql never started' no_psql

# --- 3. every output check, through the fake psql: the unmodified runner ----------------------------------------------
echo '# output checks: the runner itself, fake psql'
run_case fake-baseline "$RUNNER" 'RUN A1' PGHOST=evil.example PGHOSTADDR=203.0.113.9 PGPORT=1 PGDATABASE=postgres PGUSER=postgres \
  PGOPTIONS=-csearch_path=evil PGSSLMODE=disable PGREQUIRESSL=0 PGGSSENCMODE=require PGSERVICE=evil PGTARGETSESSIONATTRS=any \
  PGCLIENTENCODING=LATIN1 PGTZ=UTC PGDATESTYLE=ISO CDPATH=/ PGSSLSNI=0 PGSSLCERTMODE=require PGREQUIREAUTH=none PGAPPNAME=a1t \
  PGCONNECT_TIMEOUT=1 PGPASSWORD=a1t-not-a-password PGSYSCONFDIR=/nonexistent PGKRBSRVNAME=a1t
expect fake-baseline 10 "$P2_HOLD"
check 'fake-baseline: every file ran once, in order' files_run "$ALL_FILES"
check 'fake-baseline: the manifest records the runner hash' manifest_has "a1_runner_sha256 $RUNNER_SHA"
check 'fake-baseline: the staged runner copy is byte-identical' cmp -s "$RUNNER" "$EV/src/a1_run.sh"
check 'fake-baseline: sha256sums.txt verifies' sums_verify
OVERLOAD_BLOCK=$(sed -n "/^IFS= read -r -d '' OVERLOAD_SQL <<'SQL' || true\$/,/^SQL\$/p" "$RUNNER" | sed '1d;$d')
EXTRA_BLOCK=$(sed -n "/^IFS= read -r -d '' P2_EXTRA_SQL <<'SQL' || true\$/,/^SQL\$/p" "$RUNNER" | sed '1d;$d')
TABLES_BLOCK=$(sed -n "/^IFS= read -r -d '' TABLES_SQL <<'SQL' || true\$/,/^SQL\$/p" "$RUNNER" | sed '1d;$d')
OB_N=$(printf '%s\n' "$OVERLOAD_BLOCK" | wc -l)
TB_N=$(printf '%s\n' "$TABLES_BLOCK" | wc -l)
blocks_ok(){ # the overload check ends in its refusal; the extra-row query ends in psql's row count
  printf '%s\n' "$OVERLOAD_BLOCK" | grep -q 'AS a1_no_overloads, pg_catalog.count(\*) AS a1_overload_count,$' || return 1
  printf '%s\n' "$OVERLOAD_BLOCK" | grep -qx '\\if :a1_no_overloads' || return 1
  [ "$(printf '%s\n' "$OVERLOAD_BLOCK" | sed -n '$p')" = '\endif' ] || return 1
  printf '%s\n' "$EXTRA_BLOCK" | grep -q "^SELECT 'A1-EXTRA',\$" || return 1
  [ "$(printf '%s\n' "$EXTRA_BLOCK" | sed -n '$p')" = "\\echo 'A1-ROWS' :ROW_COUNT" ] || return 1
  printf '%s\n' "$TABLES_BLOCK" | grep -q '^SELECT pg_catalog.count(\*) OPERATOR(pg_catalog.=) 0 AS a1_tables_ok,$' || return 1
  printf '%s\n' "$TABLES_BLOCK" | grep -qx '\\if :a1_tables_ok' || return 1
  [ "$(printf '%s\n' "$TABLES_BLOCK" | sed -n '$p')" = '\endif' ]
}
check 'the runner holds the overload check, the table check and the extra-row query' blocks_ok
script_ok(){ # every script the runner sent, line by line
  local s n=1 a f at
  for f in $ALL_FILES; do
    s="$CASE/fake/stdin.$n"
    a="$CASE/fake/args.$n"
    [ "$(sed -n 1,2p "$s" | tr '\n' '|')" = '\set ECHO none|\set VERBOSITY terse|' ] || return 1
    [ "$(sed -n 3p "$s")" = "SELECT :'HOST' OPERATOR(pg_catalog.=) '$PROD_HOST' AND pg_catalog.current_database() OPERATOR(pg_catalog.=) 'neondb' AND CURRENT_USER OPERATOR(pg_catalog.=) 'neondb_owner' AS on_production \\gset" ] || return 1
    [ "$(sed -n 4,8p "$s" | tr '\n' '|')" = "\\if :on_production|\\else|\\echo 'A1 STOP: not the production endpoint, database and owner'|\\quit|\\endif|" ] || return 1
    [ "$(sed -n 9p "$s")" = "SELECT pg_catalog.array_to_string(pg_catalog.current_schemas(true), ',') OPERATOR(pg_catalog.=) 'pg_catalog,public' AS a1_search_path \\gset" ] || return 1
    [ "$(sed -n 10,14p "$s" | tr '\n' '|')" = "\\if :a1_search_path|\\else|\\echo 'A1 STOP: the search path is not exactly pg_catalog, public'|\\quit|\\endif|" ] || return 1
    [ "$(sed -n 15p "$s")" = 'BEGIN READ ONLY;' ] || return 1
    [ "$(sed -n 16p "$s")" = "SELECT pg_catalog.current_setting('transaction_read_only') OPERATOR(pg_catalog.=) 'on' AS a1_read_only \\gset" ] || return 1
    [ "$(sed -n 17,21p "$s" | tr '\n' '|')" = "\\if :a1_read_only|\\else|\\echo 'A1 STOP: the transaction is not read-only'|\\quit|\\endif|" ] || return 1
    [ "$(sed -n "22,$((21 + OB_N))p" "$s")" = "$OVERLOAD_BLOCK" ] || return 1
    [ "$(sed -n "$((22 + OB_N))p" "$s")" = '' ] || return 1
    [ "$(sed -n "$((23 + OB_N)),$((22 + OB_N + TB_N))p" "$s")" = "$TABLES_BLOCK" ] || return 1
    at=$((23 + OB_N + TB_N))
    [ "$(sed -n "${at}p" "$s")" = '' ] || return 1
    sed -n "$((at + 1))p" "$s" | grep -q "^SELECT 'A1-SESSION', CURRENT_USER, pg_catalog.current_database(), :'HOST', " || return 1
    [ "$(sed -n "$((at + 2))p" "$s")" = "\\i '$EV/src/$f'" ] || return 1
    [ "$(sed -n "$((at + 3))p" "$s")" = "\\echo 'A1-ROWS' :ROW_COUNT" ] || return 1
    if [ "$f" = "$P2" ]; then
      [ "$(sed -n "$((at + 4)),\$p" "$s" | sed '$d' | sed '$d')" = "$EXTRA_BLOCK" ] || return 1
    else
      [ "$(sed -n "$((at + 4))p" "$s")" = '' ] && [ "$(wc -l < "$s")" -eq "$((at + 5))" ] || return 1
    fi
    [ "$(tail -n 1 "$s")" = 'ROLLBACK;' ] || return 1
    ! sed -n "1,$((at + 3))p" "$s" | grep -qiE '^[[:space:]]*(SET|RESET|COMMIT|END|ABORT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE)\b' || return 1
    [ "$(tr '\n' ' ' < "$a")" = "service=a1test host=$PROD_HOST port=5432 dbname=neondb user=neondb_owner sslmode=verify-full gssencmode=disable -X -w -q -A -t -F $(printf '\t') -v ON_ERROR_STOP=1 " ] || return 1
    n=$((n + 1))
  done
}
check 'fake-baseline: each script is the guard, the search-path check, BEGIN READ ONLY, the overload and table checks, the file and ROLLBACK, with no setting change' script_ok
env_ok(){ # psql saw no PG variable but PGSERVICEFILE, PGPASSFILE and PGSSLROOTCERT, no CDPATH, and the runner's settings
  local e
  for e in "$CASE"/fake/env.*; do
    ! grep -E '^(PG[A-Za-z0-9_]*|CDPATH)=' "$e" | grep -qvE '^(PGSERVICEFILE|PGPASSFILE|PGSSLROOTCERT)=' || return 1
    grep -q '^PGSERVICEFILE=' "$e" && grep -q '^PGPASSFILE=' "$e" || return 1
    grep -qx 'LC_ALL=C' "$e" && grep -qx 'PSQL_HISTORY=/dev/null' "$e" || return 1
  done
}
check 'fake-baseline: psql ran with LC_ALL=C, PSQL_HISTORY=/dev/null, PGSERVICEFILE and PGPASSFILE, and no other PG variable or CDPATH' env_ok
CWD="$HERE"
run_case relative-invocation ./a1_run.sh 'RUN A1' PP_RUNNER_SHA256="$RUNNER_SHA"
expect 'invoked as ./a1_run.sh from its own directory' 10 "$P2_HOLD"
check 'relative-invocation: the manifest records the real path' manifest_has "a1_runner_path $RUNNER"
mkdir -p "$WORK/cdpath/validation"
CWD="$REPO/pool-platform/commissioner-crm"
run_case cdpath-decoy validation/a1_run.sh 'RUN A1' PP_RUNNER_SHA256="$RUNNER_SHA" CDPATH="$WORK/cdpath"
CWD='-'
expect 'a relative invocation with CDPATH pointing at a decoy directory' 10 "$P2_HOLD"
check 'cdpath-decoy: the manifest records the real path' manifest_has "a1_runner_path $RUNNER"
ln -s "$HERE" "$WORK/kit-link"
run_case symlinked-directory "$WORK/kit-link/a1_run.sh" 'RUN A1'
expect 'invoked through a symlinked directory' 10 "$P2_HOLD"
check 'symlinked-directory: the manifest records the real path' manifest_has "a1_runner_path $RUNNER"
mkdir -m 755 "$WORK/ev/existing-empty"
run_case existing-empty "$RUNNER" 'RUN A1' PP_OUT="$WORK/ev/existing-empty"
expect 'an existing empty evidence directory is used' 10 "$P2_HOLD"
check 'existing-empty: it is made private' [ "$(stat -c %a "$WORK/ev/existing-empty")" = 700 ]
for tool in shasum sha256sum openssl; do
  run_case "only-$tool" "$RUNNER" 'RUN A1' PATH="$WORK/bin-$tool"
  expect "only $tool available" 10 "$P2_HOLD"
  check "only-$tool: the manifest names the tool" manifest_has "sha256_tool $tool"
  check "only-$tool: sha256sums.txt verifies" sums_verify
done
run_case fake-restricted-path "$RUNNER" 'RUN A1' PATH="$WORK/bin-full-fake"
expect 'only the listed tools on PATH' 10 "$P2_HOLD"
run_case out-double-slash "$RUNNER" 'RUN A1' PP_OUT="/$WORK/ev/double-slash"
expect 'a leading // in an evidence path that is fine' 10 "$P2_HOLD"
run_case unhashable-evidence "$RUNNER" 'RUN A1' PATH="$WORK/bin-unhashable"
expect 'an evidence file that cannot be hashed turns the HOLD into a STOP' 1 'the run ended unexpectedly with status 1'
check 'unhashable-evidence: the HOLD items were shown first' said "$P2_HOLD"
check 'unhashable-evidence: sha256sums.txt marks the manifest unhashable' grep -qx 'unhashable  manifest.txt' "$EV/sha256sums.txt"
check 'unhashable-evidence: the last outcome in the manifest is the STOP, which says it replaces the HOLD' \
  [ "$(grep '^outcome ' "$EV/manifest.txt" | tail -n 1)" = 'outcome STOP exit 1 (the outcome HOLD exit 10 above did not complete)' ]

fix_new(){ rm -rf "$WORK/fix/$1"; cp -a "$FIX_BASE" "$WORK/fix/$1"; FIX="$WORK/fix/$1"; }
fix_raw(){ # file awk-program: rewrite one fixture's lines (tab-separated) exactly as the program prints them
  local f="$FIX/${1%.sql}.stdout"
  awk -F'\t' -v OFS='\t' "$2" "$f" > "$f.new"
  mv "$f.new" "$f"
}
fix_edit(){ # file awk-program: as fix_raw, then the row counts set to match the lines, as psql would print them
  local f="$FIX/${1%.sql}.stdout"
  fix_raw "$1" "$2"
  if [ "$1" = "$P2" ]; then
    awk -F'\t' '/^A1-ROWS / { next } $1 == "A1-EXTRA" { dep[++d] = $0; next } { line[++k] = $0 }
      END { for (i = 1; i <= k; i++) print line[i]; if (k > 0) print "A1-ROWS " (k - 1)
            for (j = 1; j <= d; j++) print dep[j]; if (k > 0) print "A1-ROWS 1" }' "$f" > "$f.new"
  else
    awk '/^A1-ROWS / { next } { line[++k] = $0 } END { for (i = 1; i <= k; i++) print line[i]; if (k > 0) print "A1-ROWS " (k - 1) }' "$f" > "$f.new"
  fi
  mv "$f.new" "$f"
}
# fake NAME CODE TEXT FILES-RUN FILE AWK [FILE AWK]...: change the fixtures (row counts kept consistent), run, expect.
# rawfake: the same, with the row counts left exactly as the program prints them.
fake_with(){
  local how=$1 name=$2 code=$3 text=$4 files=$5
  shift 5
  fix_new "$name"
  while [ "$#" -ge 2 ]; do "$how" "$1" "$2"; shift 2; done
  run_case "$name" "$RUNNER" 'RUN A1' FAKE_FIX="$FIX"
  expect "$name" "$code" "$text"
  check "$name: files run: $files" files_run "$files"
}
fake(){ fake_with fix_edit "$@"; }
rawfake(){ fake_with fix_raw "$@"; }
UPTO_P1="$P1 " UPTO_P2="$P1 $P2 " UPTO_P3="$P1 $P2 $P3 " UPTO_CV="$P1 $P2 $P3 $CV "
fake missing-h99 4 'check H99 is missing' "$UPTO_P1" "$P1" '$1 != "H99"'
fake missing-x99 4 'check X99 is missing' "$UPTO_P3" "$P3" '$1 != "X99"'
fake missing-c99 4 'check C99 is missing' "$UPTO_CV" "$CV" '$1 != "C99"'
fake missing-i99 4 'check I99 is missing' "$ALL_FILES" "$IA" '$1 != "I99"'
fake missing-h03 4 'check H03 is missing' "$UPTO_P1" "$P1" '$1 != "H03"'
fake findings-h99 4 'VERDICT: H99 is not PASS: FINDINGS: H01' "$UPTO_P1" "$P1" '$1 == "H99" { $5 = "FINDINGS: H01"; $6 = "f" } $1 == "H01" { $6 = "f" } 1'
fake findings-x99 4 'VERDICT: X99 is not PASS: FINDINGS: X04' "$UPTO_P3" "$P3" '$1 == "X99" { $5 = "FINDINGS: X04"; $6 = "f" } $1 == "X04" { $6 = "f" } 1'
fake findings-c99 4 'VERDICT: C99 is not PASS: FINDINGS: C13' "$UPTO_CV" "$CV" '$1 == "C99" { $5 = "FINDINGS: C13"; $6 = "f" } $1 == "C13" { $6 = "f" } 1'
fake stop-i99 4 'VERDICT: I99 is not PASS: STOP: I05' "$ALL_FILES" "$IA" '$1 == "I99" { $5 = "STOP: I05"; $6 = "f" } $1 == "I05" { $6 = "f" } 1'
fake verdict-ok-false 4 'VERDICT: H99 is not PASS: PASS' "$UPTO_P1" "$P1" '$1 == "H99" { $6 = "f" } 1'
fake verdict-ok-null 4 'VERDICT: X99 is not PASS: PASS' "$UPTO_P3" "$P3" '$1 == "X99" { $6 = "" } 1'
fake verdict-lowercase 4 'VERDICT: C99 is not PASS: pass' "$UPTO_CV" "$CV" '$1 == "C99" { $5 = "pass" } 1'
fake verdict-renamed 4 'VERDICT: I99 is not PASS' "$ALL_FILES" "$IA" '$1 == "I99" { $2 = "summary" } 1'
fake required-false-under-pass 4 'REQUIRED: required checks not ok: H03' "$UPTO_P1" "$P1" '$1 == "H03" { $6 = "f" } 1'
fake required-null-under-pass 4 'REQUIRED: required checks not ok: X06' "$UPTO_P3" "$P3" '$1 == "X06" { $6 = "" } 1'
fake required-two-false 4 'REQUIRED: required checks not ok: C05 C26' "$UPTO_CV" "$CV" '$1 == "C05" || $1 == "C26" { $6 = "f" } 1'
fake required-i06-false 4 'REQUIRED: required checks not ok: I06' "$ALL_FILES" "$IA" '$1 == "I06" { $6 = "f" } 1'
fake required-flag-flipped 4 'MALFORMED: check H01 has required=f, not t' "$UPTO_P1" "$P1" '$1 == "H01" { $3 = "f" } 1'
fake informational-made-required 4 'MALFORMED: check X05 has required=t, not f' "$UPTO_P3" "$P3" '$1 == "X05" { $3 = "t"; $6 = "t" } 1'
fake c21-as-on-postgresql-16 4 'MALFORMED: check C21 has required=f, not t' "$UPTO_CV" "$CV" '$1 == "C21" { $3 = "f"; $6 = "" } 1'
fake ok-flag-bad 4 'MALFORMED: check H02 has an ok flag that is not t, f or empty' "$UPTO_P1" "$P1" '$1 == "H02" { $6 = "true" } 1'
fake required-flag-bad 4 'MALFORMED: check H02 has required=true, not t' "$UPTO_P1" "$P1" '$1 == "H02" { $3 = "true" } 1'
fake duplicate-row 4 'MALFORMED: check H02 appears twice' "$UPTO_P1" "$P1" '1; $1 == "H02" { print }'
fake unknown-id 4 'MALFORMED: unexpected check id on line' "$UPTO_P3" "$P3" '1; $1 == "X06" { $1 = "X07"; print }'
fake five-fields 4 'has 5 fields, not 6' "$UPTO_P1" "$P1" '$1 == "H04" { print $1, $2, $3, $4, $5; next } 1'
fake seven-fields 4 'has 7 fields, not 6' "$UPTO_CV" "$CV" '$1 == "C10" { print $0, "extra"; next } 1'
fake blank-line 4 'has 0 fields, not 6' "$UPTO_P1" "$P1" '1; $1 == "H01" { print "" }'
fake empty-output 4 'MALFORMED: the output is empty' "$UPTO_P1" "$P1" '0'
fake no-session-row 4 'MALFORMED: the session row is missing' "$UPTO_P1" "$P1" 'NR > 1'
fake session-ssl-unknown 4 'MALFORMED: the session row is missing' "$UPTO_P1" "$P1" 'NR == 1 { $6 = "unknown" } 1'
fake session-not-read-only 4 'MALFORMED: the session row is missing' "$UPTO_P3" "$P3" 'NR == 1 { $5 = "off" } 1'
fake session-other-host 4 'MALFORMED: the session row is missing' "$UPTO_P1" "$P1" 'NR == 1 { $4 = "ep-other.c-7.us-east-2.aws.neon.tech" } 1'
fake session-other-role 4 'MALFORMED: the session row is missing' "$UPTO_CV" "$CV" 'NR == 1 { $2 = "authenticated" } 1'
fake session-other-db 4 'MALFORMED: the session row is missing' "$ALL_FILES" "$IA" 'NR == 1 { $3 = "postgres" } 1'
fake session-row-second 4 'MALFORMED: the session row is missing' "$UPTO_P1" "$P1" 'NR == 1 { s = $0; next } NR == 2 { print; print s; next } 1'
fake p2-session-no-tls-flag 4 'MALFORMED: the session row is missing' "$UPTO_P2" "$P2" 'NR == 1 { $6 = "unknown" } 1'
fake session-neon-auth-flag-bad 4 'MALFORMED: the session row is missing' "$UPTO_P1" "$P1" 'NR == 1 { $8 = "maybe" } 1'
fake p2-session-seven-fields 4 'MALFORMED: the session row is missing' "$UPTO_P2" "$P2" 'NR == 1 { print $1, $2, $3, $4, $5, $6, $7; next } 1'
fake p2-session-neon-auth-flag-bad 4 'MALFORMED: the session row is missing' "$UPTO_P2" "$P2" 'NR == 1 { $8 = "maybe" } 1'
fake audit-neon-auth-alterable 10 "identity audit: this session's role can alter the Neon Auth tables (it owns them or belongs to their owner), so I05 and I06 assume their columns are Neon Auth's own; the owner confirms who owns them and that they are unaltered" \
  "$ALL_FILES" "$IA" 'NR == 1 { $8 = "true" } 1'
check 'audit-neon-auth-alterable: two HOLD items' holds 2
check 'audit-neon-auth-alterable: recorded in the manifest' manifest_has "session $IA server_ssl=true neon_auth_alterable=true"
fake p1-neon-auth-alterable 10 "$P2_HOLD" "$ALL_FILES" "$P1" 'NR == 1 { $8 = "true" } 1'
check 'p1-neon-auth-alterable: recorded, and only the identity audit holds on it' holds 1
check 'p1-neon-auth-alterable: recorded in the manifest' manifest_has "session $P1 server_ssl=true neon_auth_alterable=true"
fake session-server-ssl-false 10 "$P2_HOLD" "$ALL_FILES" "$P1" 'NR == 1 { $6 = "false" } 1'
check 'session-server-ssl-false: recorded in the manifest, not required' manifest_has "session $P1 server_ssl=false neon_auth_alterable=false"
# The row count: psql's own count for the file, last; a value holding a line break makes the lines outnumber it.
rawfake rows-missing 4 'MALFORMED: the row count is missing' "$UPTO_P1" "$P1" '!/^A1-ROWS /'
rawfake rows-off-by-one 4 'MALFORMED: 8 lines for 9 rows: a value holds a line break' "$UPTO_P1" "$P1" '/^A1-ROWS / { print "A1-ROWS 9"; next } 1'
rawfake rows-unreadable 4 'MALFORMED: an unreadable row count' "$UPTO_P3" "$P3" '/^A1-ROWS / { print "A1-ROWS x"; next } 1'
rawfake line-after-rows 4 'MALFORMED: the output continues after the row count' "$UPTO_CV" "$CV" '1; END { print "C99", "verdict", "t", "x", "PASS", "t" }'
rawfake line-break-in-value 4 'has 5 fields, not 6' "$ALL_FILES" "$IA" '$1 == "I02" { print $1, $2, $3, $4, "credential=1"; print "x", "", "", "", "", ""; next } 1'
rawfake forged-row-count 4 'MALFORMED: the output continues after the row count' "$UPTO_P1" "$P1" '$1 == "H03" { print; print "A1-ROWS 3"; next } 1'
fake h07-not-owner 4 'P1 H07: the session role is not the commercial table owner: neondb_owner owner=false' "$UPTO_P1" "$P1" '$1 == "H07" { $5 = "neondb_owner owner=false" } 1'
fake h07-escape 4 'P1 H07: the session role is not the commercial table owner: ?[2J' "$UPTO_P1" "$P1" '$1 == "H07" { $5 = "\033[2J" } 1'
check 'h07-escape: the escape character never reaches the output' bash -c "! grep -q \$'\\033' '$CASE/stdout' '$CASE/stderr' '$EV/manifest.txt'"
fake c01-postgresql-17 4 'C01: the server is not PostgreSQL 18 (server_version_num 170006)' "$UPTO_CV" "$CV" '$1 == "C01" { sub(/server_version_num [0-9]+/, "server_version_num 170006", $5) } 1'
fake c01-malformed 4 'C01 is malformed' "$UPTO_CV" "$CV" '$1 == "C01" { $5 = "PostgreSQL 18.6" } 1'
fake c20-other-owner 4 'C20: the commercial tables are not owned by neondb_owner alone' "$UPTO_CV" "$CV" '$1 == "C20" { $5 = "pool_platform_owner super=false" } 1'
fake c20-superuser 4 'C20: the commercial tables are not owned by neondb_owner alone' "$UPTO_CV" "$CV" '$1 == "C20" { $5 = "neondb_owner super=true" } 1'
fake i07-five 10 'I07: 5 live sessions, more than the four window sessions' "$ALL_FILES" "$IA" '$1 == "I07" { $5 = "total=5; of verified users with no account=5; impersonated=0" } 1'
fake i07-impersonated 4 'I07: 1 live session(s) are impersonated' "$ALL_FILES" "$IA" '$1 == "I07" { $5 = "total=4; of verified users with no account=4; impersonated=1" } 1'
fake i07-orphan 4 'I07: 1 live session(s) do not belong to a verified user without an account row' "$ALL_FILES" "$IA" '$1 == "I07" { $5 = "total=4; of verified users with no account=3; impersonated=0" } 1'
fake i07-malformed 4 'I07 is malformed' "$ALL_FILES" "$IA" '$1 == "I07" { $5 = "total=4" } 1'
fake i04-malformed 4 'I04 is malformed' "$ALL_FILES" "$IA" '$1 == "I04" { $5 = "one" } 1'
fake i08-malformed 4 'I08 is malformed' "$ALL_FILES" "$IA" '$1 == "I08" { $5 = "memberships=0" } 1'
fake i03-malformed 4 'I03 is malformed' "$ALL_FILES" "$IA" '$1 == "I03" { $5 = "1" } 1'
fake i04-with-standing 10 'I04 and I08: 1 verified user(s) hold a password or OAuth account, and users with an account row hold 2 membership(s) and 0 entr(y/ies)' "$ALL_FILES" \
  "$IA" '$1 == "I04" { $5 = "1" } $1 == "I08" { $5 = "memberships=2; entries owned=0" } 1'
fake i04-without-standing 10 "$P2_HOLD" "$ALL_FILES" "$IA" '$1 == "I04" { $5 = "1" } 1'
check 'i04-without-standing: only the P2 HOLD' holds 1
fake i08-standing-no-i04 10 "$P2_HOLD" "$ALL_FILES" "$IA" '$1 == "I08" { $5 = "memberships=0; entries owned=3" } 1'
check 'i08-standing-no-i04: only the P2 HOLD' holds 1
fake i03-other 10 'I03: 2 non-synthetic unverified user(s) hold a password or OAuth account' "$ALL_FILES" \
  "$IA" '$1 == "I03" { $5 = "3 (synthetic pp-cv1-*@example.com: 1; other: 2)" } 1'
fake p2-usage 4 'STOP: a Data API role can use or create objects in the schema' "$UPTO_P2" "$P2" '$1 == "schema" { sub(/usage: anonymous=false authenticated=false/, "usage: anonymous=false authenticated=true", $4) } 1'
fake p2-create 4 'STOP: a Data API role can use or create objects in the schema' "$UPTO_P2" "$P2" '$1 == "schema" { sub(/create: anonymous=false authenticated=false$/, "create: anonymous=true authenticated=false", $4) } 1'
fake p2-usage-behind-spoofing-comment 4 'STOP: a Data API role can use or create objects in the schema' "$UPTO_P2" "$P2" \
  '$1 == "schema" { sub(/; usage: anonymous=false authenticated=false; create: anonymous=false authenticated=false$/, "; usage: anonymous=false authenticated=false; create: anonymous=false authenticated=false; usage: anonymous=false authenticated=true; create: anonymous=false authenticated=false", $4) } 1'
fake p2-named-by 4 'STOP: reviewed public code names the schema (function pool_platform_peek)' "$UPTO_P2" "$P2" '1; END { print "dependency", "named by reviewed public object", "", "function pool_platform_peek", "" }'
fake p2-trigger-outside 4 'STOP: a trigger outside the schema runs its code (on pool_platform_entries calls pool_platform_private.audit())' "$UPTO_P2" "$P2" \
  '1; END { print "dependency", "trigger t_audit", "", "on pool_platform_entries calls pool_platform_private.audit()", "" }'
fake p2-trigger-inside 10 "$(p2_hold 1 1 0 0 0 1 0)" "$ALL_FILES" "$P2" \
  '1; END { print "dependency", "trigger t_note", "", "on pool_platform_private.private_note calls pool_platform_private.private_helper()", "" }'
fake p2-fk-view 10 "$(p2_hold 1 1 0 2 1 0 0)" "$ALL_FILES" "$P2" \
  '1; END { print "dependency", "foreign key a", "", "from x to y", ""; print "dependency", "foreign key b", "", "from y to z", ""; print "dependency", "view v", "", "reads public.pool_platform_pools", "" }'
fake p2-absent 10 "$P2_ABSENT" "$ALL_FILES" "$P2" \
  '$1 == "schema" || $1 == "relation" || $1 == "function" { next } $1 == "provenance hint" { $4 = "schema absent (schema_oid=none, newest_commercial_fn_oid=1)" } 1'
fake p2-absent-named-by 4 'STOP: reviewed public code names the schema' "$UPTO_P2" "$P2" \
  '$1 == "schema" || $1 == "relation" || $1 == "function" { next } $1 == "provenance hint" { $4 = "schema absent (schema_oid=none, newest_commercial_fn_oid=1)" } 1; END { print "dependency", "named by reviewed public object", "", "policy p on pool_platform_pools", "" }'
# The runner's extra row (11 fields): outside dependents, readable views and public code among them, their names;
# the schema's other members; readable public views; login event triggers.
fake p2-extra-readable-view 4 'STOP: 1 view(s) outside the schema that a Data API role can read depend on it' "$UPTO_P2" "$P2" \
  '$1 == "A1-EXTRA" { $2 = 2; $3 = 1; $5 = "rule _RETURN on view peek; default value for column id of table t" } 1'
fake p2-extra-public-code 4 'STOP: 1 public function(s) or polic(y/ies) depend on it' "$UPTO_P2" "$P2" \
  '$1 == "A1-EXTRA" { $2 = 1; $4 = 1; $5 = "function a1t_count()" } 1'
fake p2-extra-both 4 'STOP: 2 view(s) outside the schema that a Data API role can read depend on it; 1 public function(s) or polic(y/ies) depend on it' "$UPTO_P2" "$P2" \
  '$1 == "A1-EXTRA" { $2 = 3; $3 = 2; $4 = 1; $5 = "a; b; c" } 1'
fake p2-extra-held 10 "$(p2_hold 1 1 0 0 0 0 3)" "$ALL_FILES" "$P2" '$1 == "A1-EXTRA" { $2 = 3; $5 = "a; b; c" } 1'
fake p2-extra-members 10 "$(p2_hold 1 1 2 0 0 0 0)" "$ALL_FILES" "$P2" '$1 == "A1-EXTRA" { $6 = 2; $7 = "type x; type y" } 1'
fake p2-extra-public-views 10 'public: 1 relation(s) other than the nine commercial tables that a Data API role can read (named in the P2 evidence); the AUTH-C verifier checks only the nine, so the owner confirms what each exposes' \
  "$ALL_FILES" "$P2" '$1 == "A1-EXTRA" { $8 = 1; $9 = "a1t_entries" } 1'
check 'p2-extra-public-views: two HOLD items' holds 2
check 'p2-extra-public-views: the P2 HOLD as well' said "$P2_HOLD"
fake p2-extra-logins 10 "server: 1 login event trigger(s) run code at every session start, this run's included (named in the P2 evidence); the owner explains each" \
  "$ALL_FILES" "$P2" '$1 == "A1-EXTRA" { $10 = 1; $11 = "a1t_login" } 1'
check 'p2-extra-logins: two HOLD items' holds 2
fake p2-absent-public-views-logins 10 "$P2_ABSENT" "$ALL_FILES" "$P2" \
  '$1 == "schema" || $1 == "relation" || $1 == "function" { next } $1 == "provenance hint" { $4 = "schema absent (schema_oid=none, newest_commercial_fn_oid=1)" } $1 == "A1-EXTRA" { $8 = 1; $9 = "v"; $10 = 2; $11 = "a; b" } 1'
check 'p2-absent-public-views-logins: three HOLD items' holds 3
check 'p2-absent-public-views-logins: the public relations' said 'public: 1 relation(s) other than the nine commercial tables that a Data API role can read'
check 'p2-absent-public-views-logins: the login triggers' said 'server: 2 login event trigger(s) run code at every session start'
fake p2-absent-with-dependents 4 'MALFORMED: the extra row lists objects of an absent schema' "$UPTO_P2" "$P2" '$1 == "schema" || $1 == "relation" || $1 == "function" { next } $1 == "provenance hint" { $4 = "schema absent (schema_oid=none, newest_commercial_fn_oid=1)" } $1 == "A1-EXTRA" { $2 = 1; $5 = "x" } 1'
fake p2-absent-with-members 4 'MALFORMED: the extra row lists objects of an absent schema' "$UPTO_P2" "$P2" '$1 == "schema" || $1 == "relation" || $1 == "function" { next } $1 == "provenance hint" { $4 = "schema absent (schema_oid=none, newest_commercial_fn_oid=1)" } $1 == "A1-EXTRA" { $6 = 1; $7 = "x" } 1'
fake p2-extra-missing 4 'MALFORMED: the extra row is missing or malformed' "$UPTO_P2" "$P2" '$1 != "A1-EXTRA"'
fake p2-extra-twice 4 'MALFORMED: more than one extra row' "$UPTO_P2" "$P2" '1; $1 == "A1-EXTRA" { print }'
for field in 2 3 4 6 8 10; do
  fake "p2-extra-field-$field-not-a-count" 4 'MALFORMED: the extra row is missing or malformed' "$UPTO_P2" "$P2" "\$1 == \"A1-EXTRA\" { \$$field = \"1x\" } 1"
done
fake p2-extra-extra-field 4 'MALFORMED: the extra row is missing or malformed' "$UPTO_P2" "$P2" '$1 == "A1-EXTRA" { $0 = $0 "\textra" } 1'
fake p2-extra-short 4 'MALFORMED: the extra row is missing or malformed' "$UPTO_P2" "$P2" '$1 == "A1-EXTRA" { print $1, $2, $3, $4, $5, $6, $7, $8, $9, $10; next } 1'
rawfake p2-extra-renamed 4 'MALFORMED: the extra row is missing or malformed' "$UPTO_P2" "$P2" '$1 == "A1-EXTRA" { $1 = "A1-EXTRAS" } 1'
fake p2-unknown-kind 4 'MALFORMED: an unknown row kind' "$UPTO_P2" "$P2" '1; END { print "grant", "x", "", "y", "" }'
fake p2-unknown-dependency 4 'MALFORMED: an unknown dependency row' "$UPTO_P2" "$P2" '1; END { print "dependency", "sequence s", "", "y", "" }'
fake p2-two-provenance 4 'MALFORMED: expected one provenance row, found 2' "$UPTO_P2" "$P2" '1; $1 == "provenance hint" { print }'
fake p2-no-provenance 4 'MALFORMED: expected one provenance row, found 0' "$UPTO_P2" "$P2" '$1 != "provenance hint"'
fake p2-two-schemas 4 'MALFORMED: more than one schema row' "$UPTO_P2" "$P2" '1; $1 == "schema" { print }'
fake p2-other-schema 4 'MALFORMED: a schema row for another schema' "$UPTO_P2" "$P2" '$1 == "schema" { $2 = "pool_platform_privat" } 1'
fake p2-objects-without-schema 4 'MALFORMED: objects listed without a schema row' "$UPTO_P2" "$P2" '$1 != "schema"'
fake p2-schema-and-absence 4 'MALFORMED: a schema row and an absence note' "$UPTO_P2" "$P2" '$1 == "provenance hint" { $4 = "schema absent" } 1'
fake p2-no-oid 4 'does not end in an oid' "$UPTO_P2" "$P2" '$1 == "relation" { $5 = "x" } 1'
fake p2-short-line 4 'has 3 fields, not 5' "$UPTO_P2" "$P2" '1; END { print "relation", "x", "y" }'
fake p2-tab-in-value 4 'has 6 fields, not 5' "$UPTO_P2" "$P2" '$1 == "relation" { $4 = $4 "\tforged" } 1'
fake p2-empty 4 'MALFORMED: the output is empty' "$UPTO_P2" "$P2" '0'
fake p2-blank-line 4 'has 0 fields, not 5' "$UPTO_P2" "$P2" '$1 == "relation" { print; print ""; next } 1'
rawfake p2-line-break-in-value 4 'MALFORMED: 5 lines for 4 rows: a value holds a line break' "$UPTO_P2" "$P2" '$1 == "relation" { print "relation", "x", "neondb_owner", "kind=r", ""; print "relation", "decoy", "neondb_owner", "kind=r", "1"; next } 1'
rawfake p2-after-end 4 'MALFORMED: the output continues after the extra row' "$UPTO_P2" "$P2" '1; END { print "relation", "late", "neondb_owner", "kind=r", "1" }'
rawfake p2-no-final-count 4 'MALFORMED: the output ends before the extra row and its row count' "$UPTO_P2" "$P2" '{ line[NR] = $0 } END { for (i = 1; i < NR; i++) print line[i] }'
# The process side: psql's exit code, its diagnostics, the guard's message, an interruption.
fakeproc(){ # name code text files-run setup-function file-base
  local name=$1 code=$2 text=$3 files=$4
  shift 4
  fix_new "$name"
  "$@"
  run_case "$name" "$RUNNER" 'RUN A1' FAKE_FIX="$FIX"
  expect "$name" "$code" "$text"
  check "$name: files run: $files" files_run "$files"
}
psql_fails(){ echo 2 > "$FIX/$1.rc"; echo 'psql: error: connection to server failed: Connection refused' > "$FIX/$1.stderr"; : > "$FIX/$1.stdout"; }
sql_error(){ echo 3 > "$FIX/$1.rc"; echo 'psql:/x.sql:1: ERROR:  permission denied for table session' > "$FIX/$1.stderr"; head -n 1 "$FIX_BASE/$1.stdout" > "$FIX/$1.stdout"; }
noise(){ echo 'WARNING:  database "neondb" has a collation version mismatch' > "$FIX/$1.stderr"; }
escape_noise(){ printf 'WARNING:  \033[2Jhidden\n' > "$FIX/$1.stderr"; }
guard_says(){ printf 'A1 STOP: not the production endpoint, database and owner\n' > "$FIX/$1.stdout"; }
path_says(){ printf 'A1 STOP: the search path is not exactly pg_catalog, public\n' > "$FIX/$1.stdout"; }
ro_says(){ printf 'A1 STOP: the transaction is not read-only\n' > "$FIX/$1.stdout"; }
signal(){ echo "$2" > "$FIX/$1.kill"; }
fakeproc psql-connection-error 3 'P1_identity_helpers_004.sql: psql exited 2' "$UPTO_P1" psql_fails P1_identity_helpers_004
check 'psql-connection-error: shows psql diagnostics' said 'psql: psql: error: connection to server failed'
fakeproc psql-sql-error 3 'neon-identity-audit.sql: psql exited 3' "$ALL_FILES" sql_error neon-identity-audit
fakeproc psql-diagnostics 4 'P3_crm_preconditions.sql: psql wrote unexpected diagnostics' "$UPTO_P3" noise P3_crm_preconditions
fakeproc psql-diagnostics-escape 4 'P1_identity_helpers_004.sql: psql wrote unexpected diagnostics' "$UPTO_P1" escape_noise P1_identity_helpers_004
check 'psql-diagnostics-escape: the escape character never reaches the terminal' bash -c "! grep -q \$'\\033' '$CASE/stdout' '$CASE/stderr'"
fakeproc guard-refusal 3 'neon-catalog-verify.sql: not the production endpoint, database and owner' "$UPTO_CV" guard_says neon-catalog-verify
fakeproc search-path-refusal 3 'P1_identity_helpers_004.sql: the search path is not exactly pg_catalog, public' "$UPTO_P1" path_says P1_identity_helpers_004
fakeproc not-read-only 3 'P2_private_schema_inventory.sql: the transaction is not read-only' "$UPTO_P2" ro_says P2_private_schema_inventory
overload_says(){ printf "A1 STOP: public holds 1 function(s) or operator(s) that can take the place of pg_catalog ones in the five files: 'lower(name)'\n" > "$FIX/$1.stdout"; }
tables_says(){ printf "A1 STOP: the tables that P3 and the identity audit read are not built as those files assume: 'neon_auth.session: row security applies to this session'\n" > "$FIX/$1.stdout"; }
fakeproc tables-refusal 3 "neon-identity-audit.sql: the tables that P3 and the identity audit read are not built as those files assume: 'neon_auth.session: row security applies to this session'" "$ALL_FILES" tables_says neon-identity-audit
fakeproc overload-refusal 3 "P3_crm_preconditions.sql: public holds 1 function(s) or operator(s) that can take the place of pg_catalog ones in the five files: 'lower(name)'" "$UPTO_P3" overload_says P3_crm_preconditions
fakeproc interrupted-term 143 'the run ended unexpectedly with status 143' "$UPTO_P3" signal P3_crm_preconditions TERM
check 'interrupted-term: the manifest records the STOP' manifest_has 'outcome STOP exit 143'
check 'interrupted-term: sha256sums.txt verifies' sums_verify
fakeproc interrupted-int 130 'the run ended unexpectedly with status 130' "$UPTO_P1" signal P1_identity_helpers_004 INT-GROUP
fakeproc interrupted-hup 129 'the run ended unexpectedly with status 129' "$UPTO_CV" signal neon-catalog-verify HUP-GROUP

# --- 4. real connections: TLS, authentication, the guard, through the test copy ---------------------------------------
echo '# real server: connections and the guard'
conn(){ # name code text service [run_case args]
  local name=$1 code=$2 text=$3 svc=$4
  shift 4
  run_case "$name" "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH" PP_SERVICE="$svc" "$@"
  expect "$name" "$code" "$text"
  check "$name: no file ran past the first connection" outs 'P1_identity_helpers_004.tsv '
  check "$name: the password appears nowhere" not_said "$PW"
}
conn wrong-ca 3 'psql exited 2: a connection, TLS, authentication or SQL error' a1test_badca
check 'wrong-ca: the TLS failure is shown' said 'certificate verify failed'
conn closed-port 3 'psql exited 2: a connection, TLS, authentication or SQL error' a1test_closed
conn no-password 3 'psql exited 2: a connection, TLS, authentication or SQL error' a1test PGPASSFILE="$WORK/pgpass-empty"
conn wrong-password 3 'psql exited 2: a connection, TLS, authentication or SQL error' a1test PGPASSFILE="$WORK/pgpass-wrong"
check 'wrong-password: the wrong password appears nowhere' not_said "wrong-$PW"
conn unknown-service 3 'psql exited 2: a connection, TLS, authentication or SQL error' a1test_missing
run_case real-runner-local-server "$RUNNER" 'RUN A1' PATH="$REAL_PATH"
expect 'the unmodified runner pins the production name, which the local certificate does not carry' 3 'psql exited 2: a connection, TLS, authentication or SQL error'
check 'real-runner-local-server: refused by TLS' said 'does not match host name'
check 'real-runner-local-server: no file ran' outs 'P1_identity_helpers_004.tsv '
check 'real-runner-local-server: nothing reached the server past the handshake' bash -c "! grep -q 'connection authorized' <<<\"\$1\"" _ "$LOG_RUN"
# The guard and the search-path check, exactly as the test copy sends them, run on their own with psql: they refuse
# every other database, role and host, and pass the target.
GUARD_SQL=$(sed -n '/^\\set ECHO none$/,/^BEGIN READ ONLY;$/p' "$TEST_RUNNER" | sed '$d' \
  | sed -e "s/'\$EXPECT_HOST'/'$TEST_HOST'/" -e "s/'\$EXPECT_DB'/'neondb'/" -e "s/'\$EXPECT_ROLE'/'neondb_owner'/")
guard(){ # host dbname user: the guard's output, followed by GUARD-PASSED when it let the script continue
  { printf '%s\n' "$GUARD_SQL"; printf '%s\n' "\\echo 'GUARD-PASSED'"; } \
    | env -i PATH=/usr/bin:/bin PGPASSFILE="$WORK/pgpass" "$PGBIN/psql" \
      "host=$1 hostaddr=127.0.0.1 port=$PORT dbname=$2 user=$3 sslmode=verify-full sslrootcert=$TLS/ca.crt" -X -w -q -A -t -v ON_ERROR_STOP=1 2>&1
}
STOP_GUARD='A1 STOP: not the production endpoint, database and owner'
STOP_PATH='A1 STOP: the search path is not exactly pg_catalog, public'
check 'guard: the extracted guard text is the qualified guard' bash -c "grep -qF \"SELECT :'HOST' OPERATOR(pg_catalog.=) '$TEST_HOST' AND pg_catalog.current_database()\" <<<\"\$1\"" _ "$GUARD_SQL"
check 'guard: passes the target' [ "$(guard "$TEST_HOST" neondb neondb_owner)" = 'GUARD-PASSED' ]
check 'guard: refuses another database' [ "$(guard "$TEST_HOST" otherdb neondb_owner)" = "$STOP_GUARD" ]
check 'guard: refuses another role' [ "$(guard "$TEST_HOST" neondb other_login)" = "$STOP_GUARD" ]
check 'guard: refuses another host name' [ "$(guard other-host.invalid neondb neondb_owner)" = "$STOP_GUARD" ]

# --- 5. real findings: each changes the local baseline, runs, and restores it -----------------------------------------
echo '# real server: findings'
real(){ # name code text outs-expected setup-sql restore-sql [admin|owner]
  local name=real-$1 code=$2 text=$3 want=$4 setup=$5 restore=$6 who=${7:-owner}
  if [ "$who" = admin ]; then admin -d neondb -c "$setup" > /dev/null; else owner -c "$setup" > /dev/null; fi
  run_case "$name" "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH"
  if [ "$who" = admin ]; then admin -d neondb -c "$restore" > /dev/null; else owner -c "$restore" > /dev/null; fi
  expect "$name" "$code" "$text"
  check "$name: outputs: $want" outs "$want"
}
O1='P1_identity_helpers_004.tsv ' O2='P1_identity_helpers_004.tsv P2_private_schema_inventory.tsv '
O3="${O2}P3_crm_preconditions.tsv " O4="${O3}neon-catalog-verify.tsv "
real p1-helper-not-definer 4 'P1_identity_helpers_004.sql: VERDICT: H99 is not PASS: FINDINGS: H02' "$O1" \
  'ALTER FUNCTION public.pool_platform_current_user_id() SECURITY INVOKER' 'ALTER FUNCTION public.pool_platform_current_user_id() SECURITY DEFINER'
real p1-helper-body 4 'P1_identity_helpers_004.sql: VERDICT: H99 is not PASS: FINDINGS: H01' "$O1" \
  "BEGIN; CREATE TABLE a1t_saved AS SELECT pg_get_functiondef('public.pool_platform_current_user_email()'::regprocedure) AS ddl; CREATE OR REPLACE FUNCTION public.pool_platform_current_user_email() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, neon_auth, pg_temp AS \$\$ SELECT NULL::text \$\$; COMMIT;" \
  "DO \$\$ BEGIN EXECUTE (SELECT ddl FROM a1t_saved); END \$\$; DROP TABLE a1t_saved;"
real p3-crm-table-exists 4 'P3_crm_preconditions.sql: VERDICT: X99 is not PASS: FINDINGS: X01' "$O3" \
  'CREATE TABLE public.pool_platform_staff_grants(id int)' 'DROP TABLE public.pool_platform_staff_grants'
real catalog-grant 4 'neon-catalog-verify.sql: VERDICT: C99 is not PASS: FINDINGS: C13, C14, C22' "$O4" \
  'GRANT INSERT ON public.pool_platform_pools TO authenticated' 'REVOKE INSERT ON public.pool_platform_pools FROM authenticated'
real catalog-line-break-in-name 4 'neon-catalog-verify.sql: MALFORMED:' "$O4" \
  "DO \$\$ BEGIN EXECUTE format('CREATE FUNCTION public.%I() RETURNS int LANGUAGE sql AS ''SELECT 1''', 'pool_platform_zz' || chr(10) || 'C99' || chr(9) || 'verdict'); END \$\$" \
  "DO \$\$ BEGIN EXECUTE format('DROP FUNCTION public.%I()', 'pool_platform_zz' || chr(10) || 'C99' || chr(9) || 'verdict'); END \$\$"
real audit-unverified-session 4 'neon-identity-audit.sql: VERDICT: I99 is not PASS: STOP: I05, I06' "$ALL_OUTS" \
  "INSERT INTO neon_auth.session(\"expiresAt\",token,\"updatedAt\",\"userId\") SELECT now() + interval '1 day','a1t-x',now(),id FROM neon_auth.\"user\" WHERE name='X'" \
  "DELETE FROM neon_auth.session WHERE token='a1t-x'" admin
real audit-fifth-session 10 'I07: 5 live sessions, more than the four window sessions (D, E, A)' "$ALL_OUTS" \
  "INSERT INTO neon_auth.session(\"expiresAt\",token,\"updatedAt\",\"userId\") SELECT now() + interval '1 day','a1t-d2',now(),id FROM neon_auth.\"user\" WHERE name='D'" \
  "DELETE FROM neon_auth.session WHERE token='a1t-d2'" admin
real audit-impersonated 4 'I07: 1 live session(s) are impersonated' "$ALL_OUTS" \
  "UPDATE neon_auth.session SET \"impersonatedBy\"='a1t-admin' WHERE \"userId\"=(SELECT id FROM neon_auth.\"user\" WHERE name='A')" \
  "UPDATE neon_auth.session SET \"impersonatedBy\"=NULL WHERE \"impersonatedBy\"='a1t-admin'" admin
real audit-contested-with-standing 10 'I04 and I08: 1 verified user(s) hold a password or OAuth account, and users with an account row hold 1 membership(s) and 0 entr(y/ies)' "$ALL_OUTS" \
  "BEGIN; INSERT INTO neon_auth.\"user\"(name,email,\"emailVerified\") VALUES ('C','contested@example.test',true); INSERT INTO neon_auth.account(\"accountId\",\"providerId\",\"userId\",\"updatedAt\") SELECT id::text,'google',id,now() FROM neon_auth.\"user\" WHERE name='C'; INSERT INTO public.pool_platform_tenants(slug,display_name) VALUES ('a1-test-tenant','A1 test'); INSERT INTO public.pool_platform_memberships(tenant_id,auth_user_id,role) SELECT t.id,u.id::text,'owner' FROM public.pool_platform_tenants t, neon_auth.\"user\" u WHERE t.slug='a1-test-tenant' AND u.name='C'; COMMIT;" \
  "BEGIN; DELETE FROM public.pool_platform_tenants WHERE slug='a1-test-tenant'; DELETE FROM neon_auth.\"user\" WHERE name='C'; COMMIT;" admin
real audit-contested-without-standing 10 "$P2_HOLD" "$ALL_OUTS" \
  "BEGIN; INSERT INTO neon_auth.\"user\"(name,email,\"emailVerified\") VALUES ('C','contested@example.test',true); INSERT INTO neon_auth.account(\"accountId\",\"providerId\",\"userId\",\"updatedAt\") SELECT id::text,'google',id,now() FROM neon_auth.\"user\" WHERE name='C'; COMMIT;" \
  "DELETE FROM neon_auth.\"user\" WHERE name='C'" admin
check 'real-audit-contested-without-standing: only the P2 HOLD' holds 1
real audit-pre-registration 10 'I03: 1 non-synthetic unverified user(s) hold a password or OAuth account' "$ALL_OUTS" \
  "BEGIN; INSERT INTO neon_auth.\"user\"(name,email,\"emailVerified\") VALUES ('S','squatter@example.test',false); INSERT INTO neon_auth.account(\"accountId\",\"providerId\",\"userId\",password,\"updatedAt\") SELECT id::text,'credential',id,'x',now() FROM neon_auth.\"user\" WHERE name='S'; COMMIT;" \
  "DELETE FROM neon_auth.\"user\" WHERE name='S'" admin
ACL_RESET="UPDATE pg_catalog.pg_namespace SET nspacl = NULL WHERE nspname = 'pool_platform_private'"
STOP_P2_REACH='P2_private_schema_inventory.sql: STOP: a Data API role can use or create objects in the schema'
real p2-usage-granted 4 "$STOP_P2_REACH" "$O2" \
  'GRANT USAGE ON SCHEMA pool_platform_private TO authenticated' "REVOKE USAGE ON SCHEMA pool_platform_private FROM authenticated; $ACL_RESET" admin
real p2-usage-to-public 4 "$STOP_P2_REACH" "$O2" \
  'GRANT USAGE ON SCHEMA pool_platform_private TO PUBLIC' "REVOKE USAGE ON SCHEMA pool_platform_private FROM PUBLIC; $ACL_RESET" admin
real p2-create-granted 4 "$STOP_P2_REACH" "$O2" \
  'GRANT CREATE ON SCHEMA pool_platform_private TO anonymous' "REVOKE CREATE ON SCHEMA pool_platform_private FROM anonymous; $ACL_RESET" admin
real p2-usage-behind-spoofing-comment 4 "$STOP_P2_REACH" "$O2" \
  "COMMENT ON SCHEMA pool_platform_private IS 'x; usage: anonymous=false authenticated=false; create: anonymous=false authenticated=false'; GRANT USAGE ON SCHEMA pool_platform_private TO authenticated" \
  "COMMENT ON SCHEMA pool_platform_private IS NULL; REVOKE USAGE ON SCHEMA pool_platform_private FROM authenticated; $ACL_RESET" admin
# B1: a comment holding a line break and a forged schema suffix hides USAGE on a fake relation line; the row count
# shows the extra line.
real p2-usage-behind-line-break 4 'P2_private_schema_inventory.sql: MALFORMED: 5 lines for 4 rows: a value holds a line break' "$O2" \
  "COMMENT ON SCHEMA pool_platform_private IS E'x; usage: anonymous=false authenticated=false; create: anonymous=false authenticated=false\\t16776\\nrelation\\tdecoy\\tneondb_owner\\tkind=r'; GRANT USAGE ON SCHEMA pool_platform_private TO authenticated" \
  "COMMENT ON SCHEMA pool_platform_private IS NULL; REVOKE USAGE ON SCHEMA pool_platform_private FROM authenticated; $ACL_RESET" admin
real p2-spoofing-comment-alone 10 "$P2_HOLD" "$ALL_OUTS" \
  "COMMENT ON SCHEMA pool_platform_private IS 'usage: anonymous=true authenticated=true; create: anonymous=true authenticated=true'" \
  'COMMENT ON SCHEMA pool_platform_private IS NULL' admin
real p2-named-by-public-function 4 'STOP: reviewed public code names the schema (function a1t_peek)' "$O2" \
  'CREATE FUNCTION public.a1t_peek() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM pool_platform_private.private_note $$' 'DROP FUNCTION public.a1t_peek()'
real p2-trigger-on-public-table 4 'STOP: a trigger outside the schema runs its code (on a1t_public calls pool_platform_private.a1t_trg)' "$O2" \
  'CREATE FUNCTION pool_platform_private.a1t_trg() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TABLE public.a1t_public(id int); CREATE TRIGGER a1t_t BEFORE INSERT ON public.a1t_public FOR EACH ROW EXECUTE FUNCTION pool_platform_private.a1t_trg()' \
  'DROP TABLE public.a1t_public; DROP FUNCTION pool_platform_private.a1t_trg()'
# B2: a trigger name holding tabs forges the detail field; the field count shows it.
real p2-trigger-name-with-tabs 4 'P2_private_schema_inventory.sql: MALFORMED: line' "$O2" \
  "CREATE FUNCTION pool_platform_private.a1t_trg() RETURNS trigger LANGUAGE plpgsql AS \$\$BEGIN RETURN NEW; END\$\$; CREATE TABLE public.a1t_public(id int); DO \$\$ BEGIN EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.a1t_public FOR EACH ROW EXECUTE FUNCTION pool_platform_private.a1t_trg()', 't' || chr(9) || 'x' || chr(9) || 'on pool_platform_private.private_note'); END \$\$" \
  'DROP TABLE public.a1t_public; DROP FUNCTION pool_platform_private.a1t_trg()'
check 'real-p2-trigger-name-with-tabs: refused for its field count' said 'fields, not 5'
real p2-trigger-inside 10 "$(p2_hold 1 2 0 0 0 1 0)" "$ALL_OUTS" \
  'CREATE FUNCTION pool_platform_private.a1t_trg() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TRIGGER a1t_t BEFORE INSERT ON pool_platform_private.private_note FOR EACH ROW EXECUTE FUNCTION pool_platform_private.a1t_trg()' \
  'DROP TRIGGER a1t_t ON pool_platform_private.private_note; DROP FUNCTION pool_platform_private.a1t_trg()'
real p2-foreign-key-in 10 "$(p2_hold 1 1 0 1 0 0 1)" "$ALL_OUTS" \
  'CREATE TABLE public.a1t_ref(id int REFERENCES pool_platform_private.private_note(id))' 'DROP TABLE public.a1t_ref'
real p2-absent 10 "$P2_ABSENT" "$ALL_OUTS" \
  'ALTER SCHEMA pool_platform_private RENAME TO a1t_renamed' 'ALTER SCHEMA a1t_renamed RENAME TO pool_platform_private'
# What P2's own rows cannot show: objects outside the schema that depend on it.
real p2-readable-public-view 4 'P2_private_schema_inventory.sql: STOP: 1 view(s) outside the schema that a Data API role can read depend on it' "$O2" \
  'CREATE VIEW public.a1t_peek AS SELECT id, note FROM pool_platform_private.private_note; GRANT SELECT ON public.a1t_peek TO authenticated' 'DROP VIEW public.a1t_peek'
check 'real-p2-readable-public-view: the view is named in the evidence' grep -q 'rule _RETURN on view a1t_peek' "$EV/out/P2_private_schema_inventory.tsv"
real p2-unreadable-public-view 10 "$(p2_hold 1 1 0 0 0 0 1)" "$ALL_OUTS" \
  'CREATE VIEW public.a1t_peek AS SELECT id, note FROM pool_platform_private.private_note' 'DROP VIEW public.a1t_peek'
real p2-default-calls-private-code 10 "$(p2_hold 1 1 0 0 0 0 1)" "$ALL_OUTS" \
  'CREATE TABLE public.a1t_def(id int DEFAULT pool_platform_private.private_helper())' 'DROP TABLE public.a1t_def'
check 'real-p2-default-calls-private-code: the default is named in the evidence' grep -q 'default value for column id of table a1t_def' "$EV/out/P2_private_schema_inventory.tsv"
P2OUT(){ printf '%s' "$EV/out/P2_private_schema_inventory.tsv"; }
# Round 2, M1: a view a Data API role can read, through a column grant, a chain of views, a function outside the
# schema, or as a materialized view.
STOP_P2_READ='P2_private_schema_inventory.sql: STOP: 1 view(s) outside the schema that a Data API role can read depend on it'
real p2-column-grant-view 4 "$STOP_P2_READ" "$O2" \
  'CREATE VIEW public.a1t_peek AS SELECT id, note FROM pool_platform_private.private_note; GRANT SELECT (note) ON public.a1t_peek TO anonymous' 'DROP VIEW public.a1t_peek'
real p2-two-view-chain 4 "$STOP_P2_READ" "$O2" \
  'CREATE VIEW public.a1t_inner AS SELECT id, note FROM pool_platform_private.private_note; CREATE VIEW public.a1t_outer AS SELECT * FROM public.a1t_inner; GRANT SELECT ON public.a1t_outer TO authenticated' \
  'DROP VIEW public.a1t_outer; DROP VIEW public.a1t_inner'
check 'real-p2-two-view-chain: the outer view is named in the evidence' grep -q 'rule _RETURN on view a1t_outer' "$(P2OUT)"
check 'real-p2-two-view-chain: so is the inner one' grep -q 'rule _RETURN on view a1t_inner' "$(P2OUT)"
real p2-view-through-function 4 "$STOP_P2_READ" "$O2" \
  'CREATE SCHEMA a1t_fn; CREATE FUNCTION a1t_fn.notes() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER BEGIN ATOMIC SELECT note FROM pool_platform_private.private_note; END; CREATE VIEW public.a1t_via AS SELECT a1t_fn.notes() AS note; GRANT SELECT ON public.a1t_via TO anonymous' \
  'DROP SCHEMA a1t_fn CASCADE'
check 'real-p2-view-through-function: the view is named in the evidence' grep -q 'rule _RETURN on view a1t_via' "$(P2OUT)"
# A rule that writes into the schema is listed, but what a view over its table reads is that table, not the schema.
real p2-write-rule-on-public-table 10 "$(p2_hold 1 1 0 0 0 0 1)" "$ALL_OUTS" \
  'CREATE TABLE public.a1t_src(id int, note text); CREATE RULE a1t_copy AS ON INSERT TO public.a1t_src DO ALSO INSERT INTO pool_platform_private.private_note VALUES (NEW.id, NEW.note); CREATE VIEW public.a1t_src_view AS SELECT id FROM public.a1t_src; GRANT SELECT ON public.a1t_src_view TO anonymous' \
  'DROP TABLE public.a1t_src CASCADE'
check 'real-p2-write-rule-on-public-table: the rule is named in the evidence' grep -q 'rule a1t_copy on table a1t_src' "$(P2OUT)"
check 'real-p2-write-rule-on-public-table: the readable view over the table is a public view, not a dependent' holds 2
real p2-readable-matview 4 "$STOP_P2_READ" "$O2" \
  'CREATE MATERIALIZED VIEW public.a1t_mv AS SELECT id, note FROM pool_platform_private.private_note; GRANT SELECT ON public.a1t_mv TO anonymous' 'DROP MATERIALIZED VIEW public.a1t_mv'
# Objects inside the schema that depend on its relations or functions are members, not outside dependents.
real p2-statistics-inside 10 "$(p2_hold 1 1 1 0 0 0 0)" "$ALL_OUTS" \
  'CREATE STATISTICS pool_platform_private.a1t_st ON id, note FROM pool_platform_private.private_note' 'DROP STATISTICS pool_platform_private.a1t_st'
real p2-operator-inside 10 "$(p2_hold 1 2 1 0 0 0 0)" "$ALL_OUTS" \
  'CREATE FUNCTION pool_platform_private.a1t_eq(int, int) RETURNS boolean LANGUAGE sql AS $$ SELECT $1 OPERATOR(pg_catalog.=) $2 $$; CREATE OPERATOR pool_platform_private.=== (LEFTARG = int, RIGHTARG = int, FUNCTION = pool_platform_private.a1t_eq)' \
  'DROP OPERATOR pool_platform_private.=== (int, int); DROP FUNCTION pool_platform_private.a1t_eq(int, int)'
# Round 2, m3: public code that depends on the schema, even where P2 sees no source text.
real p2-public-function-sql-body 4 'P2_private_schema_inventory.sql: STOP: 1 public function(s) or polic(y/ies) depend on it' "$O2" \
  'CREATE FUNCTION public.a1t_count() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM pool_platform_private.private_note; END' 'DROP FUNCTION public.a1t_count()'
check 'real-p2-public-function-sql-body: P2 itself does not see it (the body has no source text)' bash -c "! grep -q 'named by reviewed public object' '$(P2OUT)'"
real p2-policy-uses-private-code 4 'STOP: reviewed public code names the schema (policy a1t_p on a1t_pol); 1 public function(s) or polic(y/ies) depend on it' "$O2" \
  'CREATE TABLE public.a1t_pol(id int); ALTER TABLE public.a1t_pol ENABLE ROW LEVEL SECURITY; CREATE POLICY a1t_p ON public.a1t_pol USING (pool_platform_private.private_helper() = 1)' \
  'DROP TABLE public.a1t_pol'
# Round 2, NITs: the schema's other members, the views in public a Data API role can read, login event triggers.
real p2-private-type-used-outside 10 "$(p2_hold 1 1 1 0 0 0 1)" "$ALL_OUTS" \
  "CREATE TYPE pool_platform_private.a1t_kind AS ENUM ('a', 'b'); CREATE TABLE public.a1t_typed(k pool_platform_private.a1t_kind)" \
  'DROP TABLE public.a1t_typed; DROP TYPE pool_platform_private.a1t_kind'
check 'real-p2-private-type-used-outside: the type is named in the evidence' grep -q 'type pool_platform_private.a1t_kind' "$(P2OUT)"
check 'real-p2-private-type-used-outside: so is the column that uses it' grep -q 'column k of table a1t_typed' "$(P2OUT)"
real p2-readable-public-view-elsewhere 10 'public: 1 relation(s) other than the nine commercial tables that a Data API role can read (named in the P2 evidence); the AUTH-C verifier checks only the nine, so the owner confirms what each exposes' "$ALL_OUTS" \
  'CREATE VIEW public.a1t_entries AS SELECT * FROM public.pool_platform_entries; GRANT SELECT ON public.a1t_entries TO anonymous' 'DROP VIEW public.a1t_entries'
check 'real-p2-readable-public-view-elsewhere: two HOLD items' holds 2
check 'real-p2-readable-public-view-elsewhere: the view is named in the evidence' grep -q 'a1t_entries' "$(P2OUT)"
real p2-login-event-trigger 10 "server: 1 login event trigger(s) run code at every session start, this run's included (named in the P2 evidence); the owner explains each" "$ALL_OUTS" \
  'CREATE SCHEMA a1t_ev; CREATE FUNCTION a1t_ev.on_login() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN PERFORM 1; END$$; CREATE EVENT TRIGGER a1t_login ON login EXECUTE FUNCTION a1t_ev.on_login()' \
  'DROP EVENT TRIGGER a1t_login; DROP SCHEMA a1t_ev CASCADE' admin
check 'real-p2-login-event-trigger: two HOLD items' holds 2
check 'real-p2-login-event-trigger: the trigger is named in the evidence' grep -q 'a1t_login' "$(P2OUT)"
# Every name the runner's own queries print reaches the evidence on one line, non-printable characters replaced.
HOSTILE="'a1t' || chr(10) || 'A1-ROWS 9' || chr(9) || 'x'"
on_one_line(){ grep -qF 'a1t?A1-ROWS 9?x' "$(P2OUT)"; }
real p2-hostile-dependent-name 10 "$(p2_hold 1 1 0 0 0 0 1)" "$ALL_OUTS" \
  "DO \$\$ BEGIN EXECUTE format('CREATE VIEW public.%I AS SELECT id FROM pool_platform_private.private_note', $HOSTILE); END \$\$" \
  "DO \$\$ BEGIN EXECUTE format('DROP VIEW public.%I', $HOSTILE); END \$\$"
check 'real-p2-hostile-dependent-name: the name is on one line, its line break and tab replaced' on_one_line
real p2-hostile-member-name 10 "$(p2_hold 1 1 1 0 0 0 0)" "$ALL_OUTS" \
  "DO \$\$ BEGIN EXECUTE format('CREATE TYPE pool_platform_private.%I AS ENUM (''a'')', $HOSTILE); END \$\$" \
  "DO \$\$ BEGIN EXECUTE format('DROP TYPE pool_platform_private.%I', $HOSTILE); END \$\$"
check 'real-p2-hostile-member-name: the name is on one line, its line break and tab replaced' on_one_line
real p2-hostile-public-view-name 10 'public: 1 relation(s) other than the nine commercial tables that a Data API role can read' "$ALL_OUTS" \
  "DO \$\$ BEGIN EXECUTE format('CREATE VIEW public.%I AS SELECT 1 AS one', $HOSTILE); EXECUTE format('GRANT SELECT ON public.%I TO anonymous', $HOSTILE); END \$\$" \
  "DO \$\$ BEGIN EXECUTE format('DROP VIEW public.%I', $HOSTILE); END \$\$"
check 'real-p2-hostile-public-view-name: the name is on one line, its line break and tab replaced' on_one_line
real p2-hostile-login-trigger-name 10 'server: 1 login event trigger(s) run code at every session start' "$ALL_OUTS" \
  "CREATE SCHEMA a1t_ev; CREATE FUNCTION a1t_ev.on_login() RETURNS event_trigger LANGUAGE plpgsql AS \$\$BEGIN PERFORM 1; END\$\$; DO \$\$ BEGIN EXECUTE format('CREATE EVENT TRIGGER %I ON login EXECUTE FUNCTION a1t_ev.on_login()', $HOSTILE); END \$\$" \
  "DO \$\$ BEGIN EXECUTE format('DROP EVENT TRIGGER %I', $HOSTILE); END \$\$; DROP SCHEMA a1t_ev CASCADE" admin
check 'real-p2-hostile-login-trigger-name: the name is on one line, its line break and tab replaced' on_one_line

# Round 2, B1: a function or operator in public that a pinned file would call instead of the pg_catalog one stops
# the run before any file; a twin with exactly the same signature is always hidden by pg_catalog and is not refused.
STOP_OVERLOAD='P1_identity_helpers_004.sql: public holds 1 function(s) or operator(s) that can take the place of pg_catalog ones in the five files:'
only_the_refusal(){ [ "$(cat "$EV/out/P1_identity_helpers_004.tsv")" = "A1 STOP: ${STOP_OVERLOAD#*: } $1" ]; }
real overload-has-schema-privilege 3 "$STOP_OVERLOAD 'has_schema_privilege(text,oid,text)'" "$O1" \
  "GRANT CREATE ON SCHEMA public TO anonymous; CREATE FUNCTION public.has_schema_privilege(text, oid, text) RETURNS boolean LANGUAGE sql AS 'SELECT true'; REVOKE EXECUTE ON FUNCTION public.has_schema_privilege(text, oid, text) FROM PUBLIC" \
  'DROP FUNCTION public.has_schema_privilege(text, oid, text); REVOKE CREATE ON SCHEMA public FROM anonymous'
check 'real-overload-has-schema-privilege: no file ran' only_the_refusal "'has_schema_privilege(text,oid,text)'"
real overload-convert-to 3 "$STOP_OVERLOAD 'convert_to(text,text)'" "$O1" \
  "CREATE FUNCTION public.convert_to(text, text) RETURNS bytea LANGUAGE sql AS 'SELECT NULL::bytea'" 'DROP FUNCTION public.convert_to(text, text)'
check 'real-overload-convert-to: no file ran' only_the_refusal "'convert_to(text,text)'"
real overload-operator 3 "$STOP_OVERLOAD '=(name,character varying)'" "$O1" \
  "CREATE FUNCTION public.a1t_eq(name, varchar) RETURNS boolean LANGUAGE sql AS 'SELECT true'; CREATE OPERATOR public.= (LEFTARG = name, RIGHTARG = varchar, FUNCTION = public.a1t_eq)" \
  'DROP OPERATOR public.= (name, varchar); DROP FUNCTION public.a1t_eq(name, varchar)'
real overload-default-argument 3 "$STOP_OVERLOAD 'public.substr(text,integer,integer)'" "$O1" \
  "CREATE FUNCTION public.substr(text, integer, integer DEFAULT 3) RETURNS text LANGUAGE sql AS 'SELECT ''x'''" 'DROP FUNCTION public.substr(text, integer, integer)'
# A line break in a listed name would cut the refusal short; replaced, the whole name is shown.
NL_DOMAIN=$(printf 'public."a1t\nx"')
real overload-hostile-name 3 "$STOP_OVERLOAD 'lower(\"a1t?x\")'" "$O1" \
  "CREATE DOMAIN $NL_DOMAIN AS text; CREATE FUNCTION public.lower($NL_DOMAIN) RETURNS text LANGUAGE sql AS 'SELECT ''x'''" \
  "DROP FUNCTION public.lower($NL_DOMAIN); DROP DOMAIN $NL_DOMAIN"
real overload-identical-twin 10 "$P2_HOLD" "$ALL_OUTS" \
  "CREATE FUNCTION public.lower(text) RETURNS text LANGUAGE sql AS 'SELECT ''x'''; REVOKE EXECUTE ON FUNCTION public.lower(text) FROM PUBLIC" 'DROP FUNCTION public.lower(text)'
check 'real-overload-identical-twin: hidden by pg_catalog, so only the P2 HOLD' holds 1
# A search path setting holding a tab, in a schema that does not exist (so the effective path stays pg_catalog,
# public): the session row reports it with the tab replaced.
admin -d postgres > /dev/null <<'SQL'
DO $$ BEGIN EXECUTE 'ALTER ROLE neondb_owner IN DATABASE neondb SET search_path = "$user", public, ' || pg_catalog.quote_ident('a1t' || chr(9) || 'x'); END $$;
SQL
run_case real-search-path-setting-with-tab "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH"
admin -d postgres -c 'ALTER ROLE neondb_owner IN DATABASE neondb RESET search_path' > /dev/null
expect real-search-path-setting-with-tab 10 "$P2_HOLD"
check 'real-search-path-setting-with-tab: the session row shows the setting with its tab replaced' grep -qF 'public, "a1t?x"' "$EV/out/P1_identity_helpers_004.tsv"

# Round 3 gaps: a login trigger that gives the session a temporary schema (searched first for relations) stops the
# run at the search-path check; an operator in public that is an exact twin of a pg_catalog one is hidden by it.
real search-path-temporary-schema 3 'P1_identity_helpers_004.sql: the search path is not exactly pg_catalog, public' "$O1" \
  'CREATE SCHEMA a1t_ev; CREATE FUNCTION a1t_ev.make_temp() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN CREATE TEMP TABLE IF NOT EXISTS a1t_tmp(x int); END$$; CREATE EVENT TRIGGER a1t_temp ON login EXECUTE FUNCTION a1t_ev.make_temp()' \
  'DROP EVENT TRIGGER a1t_temp; DROP SCHEMA a1t_ev CASCADE' admin
real overload-identical-twin-operator 10 "$P2_HOLD" "$ALL_OUTS" \
  "CREATE FUNCTION public.a1t_texteq(text, text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT \$1 OPERATOR(pg_catalog.=) \$2'; REVOKE EXECUTE ON FUNCTION public.a1t_texteq(text, text) FROM PUBLIC; CREATE OPERATOR public.= (LEFTARG = text, RIGHTARG = text, FUNCTION = public.a1t_texteq)" \
  'DROP OPERATOR public.= (text, text); DROP FUNCTION public.a1t_texteq(text, text)'
check 'real-overload-identical-twin-operator: hidden by pg_catalog, so only the P2 HOLD' holds 1
# Round 3, F1: the tables P3 and the identity audit read must be built as those files assume. Each route the review
# found, and the ones next to it, stops the run before any file.
STOP_TABLES='P1_identity_helpers_004.sql: the tables that P3 and the identity audit read are not built as those files assume:'
UNVERIFIED_SESSION="INSERT INTO neon_auth.session(\"expiresAt\",token,\"updatedAt\",\"userId\") SELECT now() + interval '1 day','a1t-x',now(),id FROM neon_auth.\"user\" WHERE name='X'"
real tables-enum-with-implicit-cast 3 "$STOP_TABLES 'neon_auth.\"user\".\"emailVerified\" has a type that is not built in'" "$O1" \
  "BEGIN; $UNVERIFIED_SESSION; CREATE TYPE public.a1t_flag AS ENUM ('t', 'f'); CREATE FUNCTION public.a1t_flag_bool(public.a1t_flag) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'; CREATE CAST (public.a1t_flag AS boolean) WITH FUNCTION public.a1t_flag_bool(public.a1t_flag) AS IMPLICIT; ALTER TABLE neon_auth.\"user\" ALTER COLUMN \"emailVerified\" TYPE public.a1t_flag USING (CASE WHEN \"emailVerified\" THEN 't' ELSE 'f' END)::public.a1t_flag; COMMIT;" \
  "BEGIN; ALTER TABLE neon_auth.\"user\" ALTER COLUMN \"emailVerified\" TYPE boolean USING (\"emailVerified\"::text = 't'); DROP CAST (public.a1t_flag AS boolean); DROP FUNCTION public.a1t_flag_bool(public.a1t_flag); DROP TYPE public.a1t_flag; DELETE FROM neon_auth.session WHERE token='a1t-x'; COMMIT;" admin
real tables-domain-on-commercial-column 3 "$STOP_TABLES 'public.pool_platform_memberships.role has a type that is not built in'" "$O1" \
  'CREATE DOMAIN public.a1t_role AS text; ALTER TABLE public.pool_platform_memberships ALTER COLUMN role TYPE public.a1t_role' \
  'ALTER TABLE public.pool_platform_memberships ALTER COLUMN role TYPE text; DROP DOMAIN public.a1t_role'
real tables-forced-row-security 3 "$STOP_TABLES 'public.pool_platform_memberships: row security applies to this session'" "$O1" \
  'ALTER TABLE public.pool_platform_memberships FORCE ROW LEVEL SECURITY' 'ALTER TABLE public.pool_platform_memberships NO FORCE ROW LEVEL SECURITY'
real tables-row-security-on-neon-auth 3 "$STOP_TABLES 'neon_auth.session: row security applies to this session'" "$O1" \
  'ALTER TABLE neon_auth.session ENABLE ROW LEVEL SECURITY' 'ALTER TABLE neon_auth.session DISABLE ROW LEVEL SECURITY' admin
real tables-child-table 3 "$STOP_TABLES 'public.pool_platform_entries has child tables'" "$O1" \
  'CREATE TABLE public.a1t_child () INHERITS (public.pool_platform_entries)' 'DROP TABLE public.a1t_child'
real tables-view-in-place-of-a-table 3 "$STOP_TABLES 'neon_auth.session is not a plain table'" "$O1" \
  'ALTER TABLE neon_auth.session RENAME TO a1t_session_real; CREATE VIEW neon_auth.session AS SELECT * FROM neon_auth.a1t_session_real WHERE false; GRANT SELECT ON neon_auth.session TO neondb_owner' \
  'DROP VIEW neon_auth.session; ALTER TABLE neon_auth.a1t_session_real RENAME TO session' admin
real tables-generated-column 3 "$STOP_TABLES 'neon_auth.session.\"impersonatedBy\" is generated'" "$O1" \
  'ALTER TABLE neon_auth.session DROP COLUMN "impersonatedBy"; ALTER TABLE neon_auth.session ADD COLUMN "impersonatedBy" text GENERATED ALWAYS AS (NULL::text) VIRTUAL' \
  'ALTER TABLE neon_auth.session DROP COLUMN "impersonatedBy"; ALTER TABLE neon_auth.session ADD COLUMN "impersonatedBy" text' admin
real tables-missing-column 3 "$STOP_TABLES 'neon_auth.session.\"expiresAt\" is missing'" "$O1" \
  'ALTER TABLE neon_auth.session RENAME COLUMN "expiresAt" TO a1t_expires' 'ALTER TABLE neon_auth.session RENAME COLUMN a1t_expires TO "expiresAt"' admin
# Any collation of another schema is refused (one that is not deterministic could change equality); this cluster is
# SQL_ASCII, which ICU refuses, so the planted collation is a copy of C.
real tables-collation-of-another-schema 3 "$STOP_TABLES 'neon_auth.\"user\".email has a collation that is not built in'" "$O1" \
  'CREATE COLLATION public.a1t_c FROM "C"; ALTER TABLE neon_auth."user" ALTER COLUMN email TYPE text COLLATE public.a1t_c' \
  'ALTER TABLE neon_auth."user" ALTER COLUMN email TYPE text COLLATE "default"; DROP COLLATION public.a1t_c' admin
# Round 4, G1: "expiresAt" without a time zone reads through the session's, which A1's own role can set; an
# unverified session ten hours from expiry would then look expired. The type is refused.
real tables-expires-without-time-zone 3 "$STOP_TABLES 'neon_auth.session.\"expiresAt\" is not timestamp with time zone'" "$O1" \
  "BEGIN; INSERT INTO neon_auth.session(\"expiresAt\",token,\"updatedAt\",\"userId\") SELECT now() + interval '10 hours','a1t-x',now(),id FROM neon_auth.\"user\" WHERE name='X'; ALTER TABLE neon_auth.session ALTER COLUMN \"expiresAt\" TYPE timestamp; ALTER ROLE neondb_owner IN DATABASE neondb SET timezone = 'Etc/GMT-14'; COMMIT;" \
  "BEGIN; ALTER ROLE neondb_owner IN DATABASE neondb RESET timezone; ALTER TABLE neon_auth.session ALTER COLUMN \"expiresAt\" TYPE timestamptz; DELETE FROM neon_auth.session WHERE token='a1t-x'; COMMIT;" admin
# Round 4: a SET-only membership in the owner of another Neon Auth table still lets this role alter it.
real neon-auth-alterable-through-set-membership 10 "identity audit: this session's role can alter the Neon Auth tables" "$ALL_OUTS" \
  'CREATE ROLE a1t_auth_owner NOLOGIN; ALTER TABLE neon_auth.account OWNER TO a1t_auth_owner; GRANT a1t_auth_owner TO neondb_owner WITH INHERIT FALSE, SET TRUE' \
  'REVOKE a1t_auth_owner FROM neondb_owner; ALTER TABLE neon_auth.account OWNER TO postgres; GRANT SELECT ON neon_auth.account TO neondb_owner; DROP ROLE a1t_auth_owner' admin
check 'real-neon-auth-alterable-through-set-membership: two HOLD items' holds 2
# Round 4: row security on a Neon Auth table does not apply to a role with BYPASSRLS, so it is no STOP.
real neon-auth-row-security-bypassed 10 "$P2_HOLD" "$ALL_OUTS" \
  'ALTER ROLE neondb_owner BYPASSRLS; ALTER TABLE neon_auth.session ENABLE ROW LEVEL SECURITY' \
  'ALTER TABLE neon_auth.session DISABLE ROW LEVEL SECURITY; ALTER ROLE neondb_owner NOBYPASSRLS' admin
check 'real-neon-auth-row-security-bypassed: only the P2 HOLD' holds 1
# Round 4: without the neon_auth schema, every Neon Auth table is reported missing, and nothing raises an error.
real tables-no-neon-auth-schema 3 "$STOP_TABLES 'neon_auth.\"user\" is missing; neon_auth.account is missing; neon_auth.session is missing'" "$O1" \
  'ALTER SCHEMA neon_auth RENAME TO a1t_neon_auth' 'ALTER SCHEMA a1t_neon_auth RENAME TO neon_auth' admin
check 'real-tables-no-neon-auth-schema: psql wrote no error' [ ! -s "$EV/out/P1_identity_helpers_004.stderr" ]
# Who can alter the Neon Auth tables is not visible in their rows: when this session's role can, the audit holds.
real neon-auth-alterable 10 "identity audit: this session's role can alter the Neon Auth tables (it owns them or belongs to their owner), so I05 and I06 assume their columns are Neon Auth's own" "$ALL_OUTS" \
  'ALTER TABLE neon_auth."user" OWNER TO neondb_owner' 'ALTER TABLE neon_auth."user" OWNER TO postgres; GRANT SELECT ON neon_auth."user" TO neondb_owner' admin
check 'real-neon-auth-alterable: two HOLD items' holds 2
check 'real-neon-auth-alterable: recorded for each session in the manifest' bash -c "[ \"\$(grep -c 'neon_auth_alterable=true\$' '$EV/manifest.txt')\" -eq 5 ]"
# Round 3, N2: a table in public, other than the nine, that a Data API role can read.
real readable-public-table 10 'public: 1 relation(s) other than the nine commercial tables that a Data API role can read (named in the P2 evidence)' "$ALL_OUTS" \
  'CREATE TABLE public.a1t_open(id int); GRANT SELECT ON public.a1t_open TO anonymous' 'DROP TABLE public.a1t_open'
check 'real-readable-public-table: two HOLD items' holds 2
check 'real-readable-public-table: the table is named in the evidence' grep -q 'a1t_open' "$EV/out/P2_private_schema_inventory.tsv"
# Round 3, F2: every PG variable but the three files reaches psql cleared, those that would break the connection too.
run_case real-pg-variables-cleared "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH" PGSSLCERTMODE=require PGREQUIREAUTH=none PGSSLSNI=0 \
  PGAPPNAME=a1t PGSYSCONFDIR=/nonexistent PGCONNECT_TIMEOUT=1 PGPASSWORD=a1t-not-the-password
expect 'PG variables that would change or break the connection are cleared' 10 "$P2_HOLD"
check 'real-pg-variables-cleared: every connection was neondb_owner on neondb over TLS' only_owner_sessions

# B3: a hostile search path. A schema placed before pg_catalog shadows current_database(), which then writes; version
# 1's unqualified guard runs it (shown first, as a control), version 2's qualified guard does not, and the search-path
# check stops the run before any file.
owner > /dev/null <<'SQL'
CREATE SCHEMA a1t_evil;
CREATE TABLE a1t_evil.canary(n int);
GRANT INSERT ON a1t_evil.canary TO PUBLIC;
GRANT USAGE ON SCHEMA a1t_evil TO PUBLIC;
CREATE FUNCTION a1t_evil.current_database() RETURNS name LANGUAGE sql AS $$ INSERT INTO a1t_evil.canary VALUES (1) RETURNING 'neondb'::name $$;
CREATE FUNCTION a1t_evil.has_schema_privilege(name, oid, text) RETURNS boolean LANGUAGE sql AS 'SELECT false';
SQL
canary(){ admin -d neondb -A -t -c 'SELECT count(*) FROM a1t_evil.canary'; }
admin -d postgres -c 'ALTER ROLE neondb_owner IN DATABASE neondb SET search_path = a1t_evil, pg_catalog, "$user", public' > /dev/null
V1_GUARD=$(git -C "$REPO" show "$V1_COMMIT:$KIT/a1_run.sh" | sed -n '/^\\set ECHO none$/,/^\\endif$/p' \
  | sed -e "s/'\$EXPECT_HOST'/'$TEST_HOST'/" -e "s/'\$EXPECT_DB'/'neondb'/" -e "s/'\$EXPECT_ROLE'/'neondb_owner'/")
printf '%s\n' "$V1_GUARD" | env -i PATH=/usr/bin:/bin PGPASSFILE="$WORK/pgpass" "$PGBIN/psql" \
  "host=$TEST_HOST hostaddr=127.0.0.1 port=$PORT dbname=neondb user=neondb_owner sslmode=verify-full sslrootcert=$TLS/ca.crt" -X -w -q -A -t > /dev/null 2>&1 || true
check 'control: version 1 guard runs the shadowing function, which writes' [ "$(canary)" -eq 1 ]
admin -d neondb -c 'TRUNCATE a1t_evil.canary' > /dev/null
check 'guard: refuses a search path that puts a schema before pg_catalog, and runs nothing from it' [ "$(guard "$TEST_HOST" neondb neondb_owner)" = "$STOP_PATH" ]
check 'guard: the shadowing function never ran' [ "$(canary)" -eq 0 ]
run_case real-search-path-before-catalog "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH"
expect real-search-path-before-catalog 3 'P1_identity_helpers_004.sql: the search path is not exactly pg_catalog, public'
check 'real-search-path-before-catalog: no file ran' outs 'P1_identity_helpers_004.tsv '
check 'real-search-path-before-catalog: the shadowing function never ran' [ "$(canary)" -eq 0 ]
admin -d postgres -c 'ALTER ROLE neondb_owner IN DATABASE neondb SET search_path = pg_catalog, a1t_evil, public' > /dev/null
run_case real-search-path-extra-schema "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH"
expect real-search-path-extra-schema 3 'P1_identity_helpers_004.sql: the search path is not exactly pg_catalog, public'
admin -d postgres -c 'ALTER ROLE neondb_owner IN DATABASE neondb RESET search_path' > /dev/null
run_case real-search-path-service-options "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH" PP_SERVICE=a1test_options
expect real-search-path-service-options 3 'P1_identity_helpers_004.sql: the search path is not exactly pg_catalog, public'
run_case real-search-path-pgoptions-cleared "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH" PGOPTIONS='-c search_path=a1t_evil,pg_catalog,public'
expect 'PGOPTIONS asking for a hostile search path is cleared' 10 "$P2_HOLD"
check 'real-search-path-pgoptions-cleared: the shadowing function never ran' [ "$(canary)" -eq 0 ]
owner -c 'CREATE SCHEMA neondb_owner' > /dev/null
run_case real-search-path-user-schema "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH"
expect 'a schema named after the role enters "$user" in the search path' 3 'P1_identity_helpers_004.sql: the search path is not exactly pg_catalog, public'
owner -c 'DROP SCHEMA neondb_owner; DROP SCHEMA a1t_evil CASCADE' > /dev/null 2>&1

run_case real-baseline-again "$TEST_RUNNER" 'RUN A1' PATH="$REAL_PATH"
expect 'the baseline is back after every change' 10 "$P2_HOLD"
check 'real-baseline-again: the same rows as the first baseline' same_rows

# --- 6. nothing outside the evidence directories changed ---------------------------------------------------------------
echo '# side effects'
check 'the repository is unchanged' [ "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)" = "$REPO_STATUS_BEFORE" ]
check 'the checkout the runner read is unchanged' [ "$(git -C "$CLONE" status --porcelain=v1 --untracked-files=all)" = "$CLONE_STATUS_BEFORE" ]
check 'the home directory is unchanged (no history or other file written)' [ "$(cd "$THOME" && find . | sort)" = "$HOME_LIST_BEFORE" ]

printf '\n%s passed, %s failed (runner %s, bash %s, awk %s)\n' "$PASSED" "$FAILED" "$RUNNER_SHA" \
  "$("$TBASH" -c 'echo $BASH_VERSION')" "${A1_TEST_AWK:-$(readlink -f "$(command -v awk)")}"
if [ "$FAILED" -ne 0 ]; then printf 'failed:%s\n' "$FAILS"; exit 1; fi
