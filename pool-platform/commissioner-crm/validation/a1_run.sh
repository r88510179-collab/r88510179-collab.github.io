#!/usr/bin/env bash
# A1 runner, version 2: the read-only verification of the Commercial V1 production baseline.
#
# Authority: validation/A1_AUTHORIZATION.md (SHA-256 8de895da4d7f75eb5654497a41c6e7c0f888f64d65c76d2a711725d872331c12),
# signed by the owner and not changed, and validation/A1_RUNNER_ACK.txt, which the owner signs as well and which binds
# this runner, by its SHA-256, to that authorization. It runs only after the owner's separate execution approval, from
# the operator's own terminal, with four environment variables:
#
#   PP_SERVICE        the name of the operator's psql service entry for production (its password and TLS root)
#   PP_REPO           the absolute path of the repository checkout
#   PP_OUT            a new or empty private evidence directory, outside any repository and any synced folder
#   PP_RUNNER_SHA256  the SHA-256 of this file, as A1_RUNNER_ACK.txt approves it
#
# What it enforces, stopping at the first failure:
#   1. the shell is not an AI agent or CI job, and every tool it needs is present;
#   2. the inputs are well formed, PP_RUNNER_SHA256 equals this file's own SHA-256, and the evidence directory is new
#      or empty, private, and outside any git repository and the usual synced folders;
#   3. the authorization text and the five SQL files match their pinned SHA-256 exactly;
#   4. the operator types RUN A1 at the terminal;
#   5. each file connects to the production host, port, database and role, pinned here, with sslmode=verify-full; is
#      refused unless the guard of the authorization confirms that session, the search path is exactly pg_catalog,
#      public, and public holds no function or operator that could take the place of a pg_catalog one; runs inside
#      BEGIN READ ONLY; ... ROLLBACK;; and has every line of its output checked: the line count against psql's own row
#      count, the verdict row, every required row, and the rules of the authorization's section 5 that the rows carry.
#      P2's run also reads, read-only, what P2 cannot show: every object outside pool_platform_private that depends on
#      it, the objects inside it that P2 does not list, the views in public a Data API role can read, and the login
#      event triggers.
#
# The last line printed is the result, and the exit code matches it:
#   10  HOLD  every required check passed and no STOP condition occurred; the listed items need the owner's written
#             interpretation. This is the best result: P2 is an inventory the owner reads, never an automatic PASS,
#             so A1 is recorded as PASS only by the owner, on this evidence.
#   2   STOP  before any connection: boundary, tooling, inputs, this runner's own hash or a pinned hash
#   3   STOP  at a connection: connection, TLS or authentication failure, a guard, search-path or overload refusal, or
#             a psql or SQL error
#   4   STOP  a verdict, a required check or a rule of section 5 failed, or an output was malformed
# Any other nonzero code (an interruption, or a command the runner relies on failing) is a STOP as well. A STOP ends
# the run at once. A HOLD lets the remaining read-only files run, so the owner reviews one complete record.
#
# Evidence goes to PP_OUT only: manifest.txt (this runner's SHA-256, every source, result and the outcome),
# sha256sums.txt, src/ (the exact files run, this runner included) and out/ (every row, kept whole). Nothing is
# written anywhere else, no password, key, token or connection string is printed, and text taken from the database
# is printed only with its non-printable characters replaced.
{ # One block: bash reads all of it before running any of it, so the file it hashes is the code it runs.
set -euo pipefail
umask 077
export LC_ALL=C
export PSQL_HISTORY=/dev/null
unset CDPATH
# The connection string pins the target; these could otherwise change the connection or the session.
unset PGSERVICE PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGOPTIONS PGSSLMODE PGREQUIRESSL PGGSSENCMODE \
      PGSSLNEGOTIATION PGTARGETSESSIONATTRS PGLOADBALANCEHOSTS PGCLIENTENCODING PGTZ PGDATESTYLE PGGEQO

readonly EXPECT_HOST='ep-still-recipe-b5g7680z.c-7.us-east-2.aws.neon.tech'
readonly EXPECT_PORT=5432
readonly EXPECT_DB='neondb'
readonly EXPECT_ROLE='neondb_owner'
readonly EXPECT_BRANCH='br-hidden-darkness-b55g0j83'
readonly EXPECT_PG_MAJOR=18
readonly AUTHC='2c6e2a805fa816638808cb2d96d430ee177453e6'
readonly AUTHORIZATION_SHA256='8de895da4d7f75eb5654497a41c6e7c0f888f64d65c76d2a711725d872331c12'
readonly KIT_REL='pool-platform/commissioner-crm/validation'
TAB=$(printf '\t')
NL='
'
readonly TAB NL

# The five files, in the authorization's order: pinned SHA-256, verdict row, every check id the file emits, and the
# rows whose ok must be true (the required rows; C21 is required because the server is PostgreSQL 18).
F_NAME=(P1_identity_helpers_004.sql P2_private_schema_inventory.sql P3_crm_preconditions.sql neon-catalog-verify.sql neon-identity-audit.sql)
F_SHA=(9ef14dea4ea0f0ff9270b06eb05339f7dfe114accf9c6264d7dd810a979666ae
       234b81f89d328107ff86b0564c32e57f25f220c8ad8da053dc2cbf82731e39d1
       f652ecad1d7adcc1f474d1b0af9753e7a8aec1e14567d03cb350c1312cd2333d
       40b20416909c0ca2c26e2e682cb4ad2c5ef0b87fc257ca79d259dce55a0e9b43
       d512b94f8281fd201bcecb3efae3eb39fda2ab372b921d8f4a224bec012dca61)
F_VERDICT=(H99 - X99 C99 I99)
F_IDS=('H01 H02 H03 H04 H05 H06 H07 H99'
       '-'
       'X01 X02 X03 X04 X05 X06 X99'
       'C01 C02 C03 C04 C05 C06 C07 C08 C09 C10 C11 C12 C13 C14 C15 C16 C17 C18 C19 C20 C21 C22 C23 C24 C25 C26 C99'
       'I01 I02 I03 I04 I05 I06 I07 I08 I99')
F_REQ=('H01 H02 H03 H04 H05 H06'
       '-'
       'X01 X02 X03 X04 X06'
       'C02 C03 C05 C06 C07 C08 C09 C10 C11 C12 C13 C14 C15 C16 C17 C18 C19 C20 C21 C22 C24 C25 C26'
       'I05 I06')

# Before each file, inside its read-only transaction: no function or operator in public may share a name with a
# pg_catalog one unless it also has exactly the same argument types (and variadic and default arguments), since only
# such a twin is always hidden by pg_catalog, which the search path puts first. Any other could take the place of a
# built-in the five files call without a schema name, and change what they compute.
IFS= read -r -d '' OVERLOAD_SQL <<'SQL' || true
SELECT pg_catalog.count(*) OPERATOR(pg_catalog.=) 0 AS a1_no_overloads, pg_catalog.count(*) AS a1_overload_count,
       COALESCE(pg_catalog.left(pg_catalog.string_agg(s.what, ', ' ORDER BY s.what), 300), '') AS a1_overloads
FROM (
  SELECT pg_catalog.regexp_replace(p.oid::pg_catalog.regprocedure::pg_catalog.text, '[^[:print:]]', '?', 'g') AS what
  FROM pg_catalog.pg_proc p
  WHERE p.pronamespace OPERATOR(pg_catalog.=) 'public'::pg_catalog.regnamespace::pg_catalog.oid
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc c WHERE c.pronamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace::pg_catalog.oid AND c.proname OPERATOR(pg_catalog.=) p.proname)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc c WHERE c.pronamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace::pg_catalog.oid AND c.proname OPERATOR(pg_catalog.=) p.proname
                      AND c.proargtypes OPERATOR(pg_catalog.=) p.proargtypes AND c.provariadic OPERATOR(pg_catalog.=) p.provariadic AND c.pronargdefaults OPERATOR(pg_catalog.=) p.pronargdefaults)
  UNION ALL
  SELECT pg_catalog.regexp_replace(o.oid::pg_catalog.regoperator::pg_catalog.text, '[^[:print:]]', '?', 'g')
  FROM pg_catalog.pg_operator o
  WHERE o.oprnamespace OPERATOR(pg_catalog.=) 'public'::pg_catalog.regnamespace::pg_catalog.oid
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_operator c WHERE c.oprnamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace::pg_catalog.oid AND c.oprname OPERATOR(pg_catalog.=) o.oprname)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_operator c WHERE c.oprnamespace OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.regnamespace::pg_catalog.oid AND c.oprname OPERATOR(pg_catalog.=) o.oprname
                      AND c.oprleft OPERATOR(pg_catalog.=) o.oprleft AND c.oprright OPERATOR(pg_catalog.=) o.oprright)
) s \gset
\if :a1_no_overloads
\else
\echo 'A1 STOP: public holds' :a1_overload_count 'function(s) or operator(s) that can take the place of pg_catalog ones in the five files:' :'a1_overloads'
\quit
\endif
SQL

# After P2, in the same read-only transaction, one row of the runner's own over pg_catalog: (2-5) every object outside
# pool_platform_private that depends on one of its relations, functions or types, directly or through views (their
# SELECT rule, which is what they read) and functions, with how many of them are views a Data API role can read (any
# column) and how many are public functions or policies, and their names; (6-7) the objects inside it that P2 does not list (types and the like); (8-9) the
# views in public that a Data API role can read, whatever they read; (10-11) the login event triggers that run at
# every session start. A dependent whose namespace the query does not resolve (a cast or an event trigger, for
# example) counts as outside. Names have every non-printable character replaced; every name and operator is
# qualified, so nothing here depends on the search path.
IFS= read -r -d '' P2_EXTRA_SQL <<'SQL' || true
WITH RECURSIVE
k AS (
  SELECT 'pg_catalog.pg_class'::pg_catalog.regclass::pg_catalog.oid AS cls, 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid AS prc,
         'pg_catalog.pg_type'::pg_catalog.regclass::pg_catalog.oid AS typ, 'pg_catalog.pg_rewrite'::pg_catalog.regclass::pg_catalog.oid AS rwr,
         'pg_catalog.pg_constraint'::pg_catalog.regclass::pg_catalog.oid AS con, 'pg_catalog.pg_attrdef'::pg_catalog.regclass::pg_catalog.oid AS def,
         'pg_catalog.pg_trigger'::pg_catalog.regclass::pg_catalog.oid AS trg, 'pg_catalog.pg_policy'::pg_catalog.regclass::pg_catalog.oid AS pol,
         'pg_catalog.pg_namespace'::pg_catalog.regclass::pg_catalog.oid AS nsp, 'public'::pg_catalog.regnamespace::pg_catalog.oid AS pub,
         'pg_catalog.pg_statistic_ext'::pg_catalog.regclass::pg_catalog.oid AS stx, 'pg_catalog.pg_operator'::pg_catalog.regclass::pg_catalog.oid AS opr,
         'pg_toast'::pg_catalog.regnamespace::pg_catalog.oid AS toast
),
ns AS (SELECT n.oid FROM pg_catalog.pg_namespace n WHERE n.nspname OPERATOR(pg_catalog.=) 'pool_platform_private'),
target AS (
  SELECT k.cls AS classid, c.oid AS objid FROM k, pg_catalog.pg_class c, ns WHERE c.relnamespace OPERATOR(pg_catalog.=) ns.oid
  UNION ALL SELECT k.prc, p.oid FROM k, pg_catalog.pg_proc p, ns WHERE p.pronamespace OPERATOR(pg_catalog.=) ns.oid
  UNION ALL SELECT k.typ, t.oid FROM k, pg_catalog.pg_type t, ns WHERE t.typnamespace OPERATOR(pg_catalog.=) ns.oid
),
hit(classid, objid, objsubid) AS (
  SELECT d.classid, d.objid, d.objsubid FROM pg_catalog.pg_depend d, target t
  WHERE d.refclassid OPERATOR(pg_catalog.=) t.classid AND d.refobjid OPERATOR(pg_catalog.=) t.objid AND d.deptype OPERATOR(pg_catalog.<>) 'i'
  UNION
  SELECT d.classid, d.objid, d.objsubid FROM hit h, k, pg_catalog.pg_depend d
  WHERE d.deptype OPERATOR(pg_catalog.<>) 'i'
    AND ((h.classid OPERATOR(pg_catalog.=) k.rwr AND d.refclassid OPERATOR(pg_catalog.=) k.cls
          AND d.refobjid OPERATOR(pg_catalog.=) (SELECT r.ev_class FROM pg_catalog.pg_rewrite r WHERE r.oid OPERATOR(pg_catalog.=) h.objid AND r.ev_type OPERATOR(pg_catalog.=) '1'))
      OR (h.classid OPERATOR(pg_catalog.=) k.prc AND d.refclassid OPERATOR(pg_catalog.=) k.prc AND d.refobjid OPERATOR(pg_catalog.=) h.objid))
),
dep AS (
  SELECT h.classid, h.objid, h.objsubid,
         CASE
           WHEN h.classid OPERATOR(pg_catalog.=) k.cls THEN (SELECT c.relnamespace FROM pg_catalog.pg_class c WHERE c.oid OPERATOR(pg_catalog.=) h.objid)
           WHEN h.classid OPERATOR(pg_catalog.=) k.prc THEN (SELECT p.pronamespace FROM pg_catalog.pg_proc p WHERE p.oid OPERATOR(pg_catalog.=) h.objid)
           WHEN h.classid OPERATOR(pg_catalog.=) k.typ THEN (SELECT t.typnamespace FROM pg_catalog.pg_type t WHERE t.oid OPERATOR(pg_catalog.=) h.objid)
           WHEN h.classid OPERATOR(pg_catalog.=) k.con THEN (SELECT o.connamespace FROM pg_catalog.pg_constraint o WHERE o.oid OPERATOR(pg_catalog.=) h.objid)
           WHEN h.classid OPERATOR(pg_catalog.=) k.rwr THEN (SELECT c.relnamespace FROM pg_catalog.pg_rewrite r, pg_catalog.pg_class c WHERE r.oid OPERATOR(pg_catalog.=) h.objid AND c.oid OPERATOR(pg_catalog.=) r.ev_class)
           WHEN h.classid OPERATOR(pg_catalog.=) k.def THEN (SELECT c.relnamespace FROM pg_catalog.pg_attrdef a, pg_catalog.pg_class c WHERE a.oid OPERATOR(pg_catalog.=) h.objid AND c.oid OPERATOR(pg_catalog.=) a.adrelid)
           WHEN h.classid OPERATOR(pg_catalog.=) k.trg THEN (SELECT c.relnamespace FROM pg_catalog.pg_trigger g, pg_catalog.pg_class c WHERE g.oid OPERATOR(pg_catalog.=) h.objid AND c.oid OPERATOR(pg_catalog.=) g.tgrelid)
           WHEN h.classid OPERATOR(pg_catalog.=) k.pol THEN (SELECT c.relnamespace FROM pg_catalog.pg_policy y, pg_catalog.pg_class c WHERE y.oid OPERATOR(pg_catalog.=) h.objid AND c.oid OPERATOR(pg_catalog.=) y.polrelid)
           WHEN h.classid OPERATOR(pg_catalog.=) k.stx THEN (SELECT x.stxnamespace FROM pg_catalog.pg_statistic_ext x WHERE x.oid OPERATOR(pg_catalog.=) h.objid)
           WHEN h.classid OPERATOR(pg_catalog.=) k.opr THEN (SELECT o.oprnamespace FROM pg_catalog.pg_operator o WHERE o.oid OPERATOR(pg_catalog.=) h.objid)
         END AS nsp_oid,
         COALESCE(h.classid OPERATOR(pg_catalog.=) k.rwr
           AND (SELECT (c.relkind OPERATOR(pg_catalog.=) 'v' OR c.relkind OPERATOR(pg_catalog.=) 'm')
                       AND (pg_catalog.has_schema_privilege('anonymous', c.relnamespace, 'USAGE') AND pg_catalog.has_any_column_privilege('anonymous', c.oid, 'SELECT')
                            OR pg_catalog.has_schema_privilege('authenticated', c.relnamespace, 'USAGE') AND pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT'))
                FROM pg_catalog.pg_rewrite r, pg_catalog.pg_class c WHERE r.oid OPERATOR(pg_catalog.=) h.objid AND c.oid OPERATOR(pg_catalog.=) r.ev_class), false) AS readable_view,
         COALESCE(h.classid OPERATOR(pg_catalog.=) k.pol
           OR h.classid OPERATOR(pg_catalog.=) k.prc AND (SELECT p.pronamespace FROM pg_catalog.pg_proc p WHERE p.oid OPERATOR(pg_catalog.=) h.objid) OPERATOR(pg_catalog.=) k.pub, false) AS public_code
  FROM hit h, k
),
outside AS (
  SELECT DISTINCT pg_catalog.regexp_replace(pg_catalog.pg_describe_object(dep.classid, dep.objid, dep.objsubid), '[^[:print:]]', '?', 'g') AS what,
         dep.readable_view, dep.public_code
  FROM dep, k
  WHERE COALESCE(dep.nsp_oid, 0::pg_catalog.oid) OPERATOR(pg_catalog.<>) ALL (SELECT ns.oid FROM ns UNION ALL SELECT k.toast)
),
members AS (
  SELECT pg_catalog.regexp_replace(pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid), '[^[:print:]]', '?', 'g') AS what
  FROM pg_catalog.pg_depend d, k, ns
  WHERE d.refclassid OPERATOR(pg_catalog.=) k.nsp AND d.refobjid OPERATOR(pg_catalog.=) ns.oid AND d.deptype OPERATOR(pg_catalog.=) 'n'
    AND d.classid OPERATOR(pg_catalog.<>) k.prc
    AND NOT (d.classid OPERATOR(pg_catalog.=) k.cls
             AND COALESCE((SELECT c.relkind OPERATOR(pg_catalog.=) ANY (ARRAY['r', 'p', 'v', 'm', 'S', 'f']::pg_catalog."char"[])
                           FROM pg_catalog.pg_class c WHERE c.oid OPERATOR(pg_catalog.=) d.objid), false))
),
public_views AS (
  SELECT pg_catalog.regexp_replace(c.oid::pg_catalog.regclass::pg_catalog.text, '[^[:print:]]', '?', 'g') AS what
  FROM pg_catalog.pg_class c, k
  WHERE c.relnamespace OPERATOR(pg_catalog.=) k.pub AND (c.relkind OPERATOR(pg_catalog.=) 'v' OR c.relkind OPERATOR(pg_catalog.=) 'm')
    AND (pg_catalog.has_schema_privilege('anonymous', c.relnamespace, 'USAGE') AND pg_catalog.has_any_column_privilege('anonymous', c.oid, 'SELECT')
         OR pg_catalog.has_schema_privilege('authenticated', c.relnamespace, 'USAGE') AND pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT'))
),
logins AS (
  SELECT pg_catalog.regexp_replace(e.evtname::pg_catalog.text, '[^[:print:]]', '?', 'g') AS what
  FROM pg_catalog.pg_event_trigger e
  WHERE e.evtevent OPERATOR(pg_catalog.=) 'login' AND e.evtenabled OPERATOR(pg_catalog.<>) 'D'
)
SELECT 'A1-EXTRA',
       (SELECT pg_catalog.count(*) FROM outside),
       (SELECT pg_catalog.count(*) FROM outside WHERE outside.readable_view),
       (SELECT pg_catalog.count(*) FROM outside WHERE outside.public_code),
       COALESCE((SELECT pg_catalog.string_agg(outside.what, '; ' ORDER BY outside.what) FROM outside), ''),
       (SELECT pg_catalog.count(*) FROM members),
       COALESCE((SELECT pg_catalog.string_agg(members.what, '; ' ORDER BY members.what) FROM members), ''),
       (SELECT pg_catalog.count(*) FROM public_views),
       COALESCE((SELECT pg_catalog.string_agg(public_views.what, '; ' ORDER BY public_views.what) FROM public_views), ''),
       (SELECT pg_catalog.count(*) FROM logins),
       COALESCE((SELECT pg_catalog.string_agg(logins.what, '; ' ORDER BY logins.what) FROM logins), '');
\echo 'A1-ROWS' :ROW_COUNT
SQL

MANIFEST=''
HOLDS=''
SHA_TOOL=''
OUTCOME=''
DONE=0

now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
note(){ if [ -n "$MANIFEST" ]; then printf '%s\n' "$*" >> "$MANIFEST"; fi; }
clean(){ printf '%s' "$*" | tr -c '[:print:]' '?'; } # text -> printable ASCII only, for the terminal and the manifest

sha256_of(){ # file -> 64 lowercase hex characters, or failure; read from stdin so no file name reaches the output
  local h=''
  case $SHA_TOOL in
    shasum)    h=$(shasum -a 256 < "$1" 2>/dev/null | awk '{print $1}') || h='' ;;
    sha256sum) h=$(sha256sum < "$1" 2>/dev/null | awk '{print $1}') || h='' ;;
    openssl)   h=$(openssl dgst -sha256 < "$1" 2>/dev/null | sed -n 's/^.*= *\([0-9a-f]*\)$/\1/p') || h='' ;;
  esac
  case $h in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "${#h}" -eq 64 ] || return 1
  printf '%s\n' "$h"
}

finalize(){ # outcome exit-code; fails if any evidence file cannot be hashed
  [ -n "$MANIFEST" ] || return 0
  note "finished $(now)"
  if [ -n "$OUTCOME" ]; then note "outcome $1 exit $2 (the outcome $OUTCOME above did not complete)"
  else note "outcome $1 exit $2"
  fi
  OUTCOME="$1 exit $2"
  local f h ok=0
  : > "$PP_OUT/sha256sums.txt"
  for f in "$PP_OUT"/manifest.txt "$PP_OUT"/src/* "$PP_OUT"/out/*; do
    [ -f "$f" ] || continue
    h=$(sha256_of "$f") || { h='unhashable'; ok=1; }
    printf '%s  %s\n' "$h" "${f#"$PP_OUT"/}" >> "$PP_OUT/sha256sums.txt"
  done
  return "$ok"
}

stop(){ # exit-code message
  local code=$1 msg
  shift
  msg=$(clean "$*" 2>/dev/null) || msg="$*"
  DONE=1
  printf 'A1 STOP: %s\n' "$msg" >&2
  note "stop exit $code: $msg"
  finalize STOP "$code" || true
  printf 'A1 RESULT: STOP (exit %s)\n' "$code"
  exit "$code"
}

on_exit(){ # whatever ends the run without a result line is a STOP
  local code=$?
  [ "$DONE" -eq 0 ] || return 0
  DONE=1
  set +e
  [ "$code" -ne 0 ] || code=1
  printf 'A1 STOP: the run ended unexpectedly with status %s\n' "$code" >&2
  note "stop exit $code: the run ended unexpectedly"
  finalize STOP "$code"
  printf 'A1 RESULT: STOP (exit %s)\n' "$code"
  exit "$code"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

hold(){ local msg; msg=$(clean "$*"); HOLDS="${HOLDS}${HOLDS:+$NL}$msg"; note "hold $msg"; }

show_psql_errors(){ # stderr file: at most three lines, which libpq never fills with passwords
  [ -s "$1" ] || return 0
  head -n 3 "$1" | tr -c '[:print:]\n' '?' | sed 's/^/  psql: /' >&2
}

# 1. Boundary and tooling.
for marker in CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_REMOTE CI GITHUB_ACTIONS; do
  eval "marker_value=\${$marker:-}"
  [ -z "$marker_value" ] || stop 2 "this shell is an AI agent or CI job because $marker is set: run A1 yourself from your own terminal"
done
for tool in psql git awk sed grep tr date cp mkdir chmod head wc ls dirname basename rmdir; do
  command -v "$tool" >/dev/null 2>&1 || stop 2 "the required tool $tool is not on PATH"
done
if command -v shasum >/dev/null 2>&1; then SHA_TOOL='shasum'
elif command -v sha256sum >/dev/null 2>&1; then SHA_TOOL='sha256sum'
elif command -v openssl >/dev/null 2>&1; then SHA_TOOL='openssl'
else stop 2 "no SHA-256 tool: shasum, sha256sum or openssl is required"
fi

# 2. Inputs, this runner's own hash, and the evidence directory.
safe_path(){ case $1 in /*) ;; *) return 1 ;; esac; case $1 in *[!A-Za-z0-9._/@+-]*) return 1 ;; esac; return 0; }
lower(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; } # macOS file systems ignore case, so paths compare without it
[ -n "${PP_SERVICE:-}" ] || stop 2 "PP_SERVICE is not set"
case $PP_SERVICE in *[!A-Za-z0-9._-]*) stop 2 "PP_SERVICE may contain only letters, digits, dot, underscore and hyphen" ;; esac
{ [ -n "${PP_REPO:-}" ] && safe_path "$PP_REPO"; } || stop 2 "PP_REPO must be an absolute path made of letters, digits and . _ / @ + -"
{ [ -d "$PP_REPO/.git" ] || [ -f "$PP_REPO/.git" ]; } || stop 2 "PP_REPO is not a git checkout"
{ [ -n "${PP_OUT:-}" ] && safe_path "$PP_OUT"; } || stop 2 "PP_OUT must be an absolute path made of letters, digits and . _ / @ + -"
case ${PP_RUNNER_SHA256:-} in ''|*[!0-9a-f]*) stop 2 "PP_RUNNER_SHA256 must be the approved 64-character lowercase SHA-256 of this runner" ;; esac
[ "${#PP_RUNNER_SHA256}" -eq 64 ] || stop 2 "PP_RUNNER_SHA256 must be the approved 64-character lowercase SHA-256 of this runner"

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P) || stop 2 "cannot locate this runner"
SELF="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"
RUNNER_SHA=$(sha256_of "$SELF") || stop 2 "cannot hash this runner at $SELF"
[ "$RUNNER_SHA" = "$PP_RUNNER_SHA256" ] || stop 2 "this runner's SHA-256 is $RUNNER_SHA, not the approved $PP_RUNNER_SHA256"

single_slash(){ local p=$1; while :; do case $p in //*) p=${p#/} ;; *) break ;; esac; done; printf '%s' "$p"; }
REPO_REAL=$(cd "$PP_REPO" && pwd -P) || stop 2 "cannot enter PP_REPO"
REPO_REAL=$(single_slash "$REPO_REAL")
if [ -e "$PP_OUT" ] || [ -L "$PP_OUT" ]; then
  { [ -d "$PP_OUT" ] && [ ! -L "$PP_OUT" ]; } || stop 2 "PP_OUT exists and is not a plain directory"
  listing=$(ls -A "$PP_OUT") || stop 2 "cannot list PP_OUT"
  [ -z "$listing" ] || stop 2 "PP_OUT is not empty: use a new directory for every run"
  OUT_CREATED=0
else
  mkdir -p "$PP_OUT" || stop 2 "cannot create PP_OUT"
  OUT_CREATED=1
fi
OUT_REAL=$(cd "$PP_OUT" && pwd -P) || stop 2 "cannot enter PP_OUT"
OUT_REAL=$(single_slash "$OUT_REAL")
out_refused(){ # reason: remove the directory this run created, then stop
  if [ "$OUT_CREATED" -eq 1 ]; then rmdir "$PP_OUT" 2>/dev/null || true; fi
  stop 2 "$1"
}
OUT_LC=$(lower "$OUT_REAL/")
case "$OUT_LC" in "$(lower "$REPO_REAL/")"*) out_refused "PP_OUT is inside the repository: keep evidence outside it" ;; esac
up=$OUT_REAL
while :; do
  if [ -e "$up/.git" ]; then out_refused "PP_OUT is inside the git repository at $up: keep evidence outside any repository"; fi
  [ "$up" != / ] || break
  up=$(dirname "$up")
done
if [ -n "${HOME:-}" ] && HOME_REAL=$(cd "$HOME" 2>/dev/null && pwd -P); then
  HOME_LC=$(lower "$(single_slash "$HOME_REAL")")
  case "$OUT_LC" in
    "$HOME_LC/documents/"*|"$HOME_LC/desktop/"*|"$HOME_LC/library/mobile documents/"*|"$HOME_LC/library/cloudstorage/"*|\
    "$HOME_LC/dropbox"*|"$HOME_LC/google drive"*|"$HOME_LC/onedrive"*|"$HOME_LC/icloud drive"*)
      out_refused "PP_OUT is inside a folder that may be synced to the cloud: keep evidence in a private local directory" ;;
  esac
fi
chmod 700 "$PP_OUT" || stop 2 "cannot make PP_OUT private"
mkdir "$PP_OUT/src" "$PP_OUT/out" || stop 2 "cannot create the evidence subdirectories"
MANIFEST="$PP_OUT/manifest.txt"
{
  printf 'a1_runner_version 2\n'
  printf 'a1_runner_sha256 %s\n' "$RUNNER_SHA"
  printf 'a1_runner_path %s\n' "$SELF"
  printf 'sha256_tool %s\n' "$SHA_TOOL"
  printf 'authorization_sha256 %s\n' "$AUTHORIZATION_SHA256"
  printf 'repo %s\n' "$REPO_REAL"
  printf 'repo_head %s\n' "$(git -C "$PP_REPO" rev-parse HEAD 2>/dev/null || printf unknown)"
  printf 'target host=%s port=%s database=%s role=%s branch=%s postgresql=%s sslmode=verify-full\n' \
    "$EXPECT_HOST" "$EXPECT_PORT" "$EXPECT_DB" "$EXPECT_ROLE" "$EXPECT_BRANCH" "$EXPECT_PG_MAJOR"
  printf 'service %s\n' "$PP_SERVICE"
  printf 'psql_version %s\n' "$(psql --version 2>/dev/null | head -n 1 | tr -c '[:print:]\n' '?')"
  printf 'bash_version %s\n' "$BASH_VERSION"
  printf 'started %s\n' "$(now)"
} > "$MANIFEST" || stop 2 "cannot write the manifest"

# 3. Stage every file this run uses and check each against its pinned SHA-256.
KIT="$PP_REPO/$KIT_REL"
check_pinned(){ # staged-name pinned-sha
  local h
  h=$(sha256_of "$PP_OUT/src/$1") || stop 2 "cannot hash $1"
  [ "$h" = "$2" ] || stop 2 "$1 does not match its pinned SHA-256: expected $2, found $h"
  note "source $1 $h"
}
stage_copy(){ # source-path staged-name pinned-sha
  { [ -f "$1" ] && [ ! -L "$1" ]; } || stop 2 "missing, or not a regular file: $1"
  cp "$1" "$PP_OUT/src/$2" || stop 2 "cannot copy $1"
  check_pinned "$2" "$3"
}
stage_copy "$SELF" a1_run.sh "$RUNNER_SHA"
stage_copy "$KIT/A1_AUTHORIZATION.md" A1_AUTHORIZATION.md "$AUTHORIZATION_SHA256"
git -C "$PP_REPO" cat-file -e "$AUTHC^{commit}" 2>/dev/null || stop 2 "the AUTH-C commit $AUTHC is not in PP_REPO: fetch it with git -C $PP_REPO fetch origin $AUTHC"
i=0
while [ "$i" -lt 5 ]; do
  name=${F_NAME[$i]}
  case $name in
    neon-*)
      git -C "$PP_REPO" show "$AUTHC:pool-platform/validation/$name" > "$PP_OUT/src/$name" 2>/dev/null || stop 2 "cannot read $name from $AUTHC"
      check_pinned "$name" "${F_SHA[$i]}" ;;
    *)
      stage_copy "$KIT/$name" "$name" "${F_SHA[$i]}" ;;
  esac
  i=$((i + 1))
done
note "sources verified $(now)"
printf 'Sources verified: the authorization, this runner and the five SQL files match their pinned SHA-256.\n'

# 4. The operator confirms at the terminal. A shell without a terminal, such as an AI agent's or a CI job's, stops here.
if ! ( : < /dev/tty ) 2>/dev/null; then stop 2 "no terminal: run A1 yourself from a terminal window"; fi
{
  printf '\nA1 will now connect read-only:\n'
  printf '  host %s port %s\n  database %s\n  role %s\n  branch %s\n' "$EXPECT_HOST" "$EXPECT_PORT" "$EXPECT_DB" "$EXPECT_ROLE" "$EXPECT_BRANCH"
  printf '  runner %s\n  authorization %s\n' "$RUNNER_SHA" "$AUTHORIZATION_SHA256"
  printf 'Type RUN A1 and press Return to continue. Anything else stops: '
} > /dev/tty
answer=''
IFS= read -r answer < /dev/tty || answer=''
[ "$answer" = 'RUN A1' ] || stop 2 "not confirmed at the terminal"
note "confirmed $(now)"

# 5. Run each file behind the guard, read-only, and check every line. The guard runs first, then the search-path
# check, both outside the transaction and so written with every function and operator qualified: nothing a schema
# could shadow runs before BEGIN READ ONLY. Inside it, the runner's own statements are qualified as well.
run_one(){ # file-name [extra psql lines, run after the file inside the same transaction]
  local name=$1 extra=${2:-} base=${1%.sql} rc=0
  local out="$PP_OUT/out/$base.tsv" err="$PP_OUT/out/$base.stderr"
  psql "service=$PP_SERVICE host=$EXPECT_HOST port=$EXPECT_PORT dbname=$EXPECT_DB user=$EXPECT_ROLE sslmode=verify-full gssencmode=disable" \
    -X -w -q -A -t -F "$TAB" -v ON_ERROR_STOP=1 > "$out" 2> "$err" <<SQL || rc=$?
\set ECHO none
\set VERBOSITY terse
SELECT :'HOST' OPERATOR(pg_catalog.=) '$EXPECT_HOST' AND pg_catalog.current_database() OPERATOR(pg_catalog.=) '$EXPECT_DB' AND CURRENT_USER OPERATOR(pg_catalog.=) '$EXPECT_ROLE' AS on_production \gset
\if :on_production
\else
\echo 'A1 STOP: not the production endpoint, database and owner'
\quit
\endif
SELECT pg_catalog.array_to_string(pg_catalog.current_schemas(true), ',') OPERATOR(pg_catalog.=) 'pg_catalog,public' AS a1_search_path \gset
\if :a1_search_path
\else
\echo 'A1 STOP: the search path is not exactly pg_catalog, public'
\quit
\endif
BEGIN READ ONLY;
SELECT pg_catalog.current_setting('transaction_read_only') OPERATOR(pg_catalog.=) 'on' AS a1_read_only \gset
\if :a1_read_only
\else
\echo 'A1 STOP: the transaction is not read-only'
\quit
\endif
$OVERLOAD_SQL
SELECT 'A1-SESSION', CURRENT_USER, pg_catalog.current_database(), :'HOST', pg_catalog.current_setting('transaction_read_only'), COALESCE((SELECT s.ssl::pg_catalog.text FROM pg_catalog.pg_stat_ssl s WHERE s.pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()), 'unknown'), pg_catalog.regexp_replace(pg_catalog.current_setting('search_path'), '[^[:print:]]', '?', 'g');
\i '$PP_OUT/src/$name'
\echo 'A1-ROWS' :ROW_COUNT
$extra
ROLLBACK;
SQL
  if [ "$rc" -ne 0 ]; then
    show_psql_errors "$err"
    stop 3 "$name: psql exited $rc: a connection, TLS, authentication or SQL error"
  fi
  if grep -q '^A1 STOP: ' "$out"; then
    stop 3 "$name: $(grep '^A1 STOP: ' "$out" | head -n 1 | sed 's/^A1 STOP: //')"
  fi
  if [ -s "$err" ]; then
    show_psql_errors "$err"
    stop 4 "$name: psql wrote unexpected diagnostics"
  fi
}

# The session row comes first: the production role, database and host in a read-only transaction, and the server's
# view of TLS (recorded, not required: on Neon, TLS from this machine ends at Neon's proxy, and verify-full is what
# protects that hop). The last line is psql's own row count for the file, so a value holding a line break shows up as
# extra lines. Every line between them: exactly six fields, a known check id seen once, the required flag the file
# defines for it, an ok flag of t, f or empty; then the verdict row PASS and every required row ok. Prints one
# status: OK, or MALFORMED, VERDICT or REQUIRED with the reason.
CHECKS_AWK='
BEGIN {
  FS = "\t"; status = ""; failed = ""; rows = -1
  n = split(ids, want, " "); for (i = 1; i <= n; i++) expected[want[i]] = 1
  m = split(req, must, " "); for (i = 1; i <= m; i++) required[must[i]] = 1
}
status != "" { next }
rows >= 0 { status = "MALFORMED: the output continues after the row count"; next }
NR == 1 {
  if (!(NF == 7 && $1 == "A1-SESSION" && $2 == role && $3 == db && $4 == host && $5 == "on" && ($6 == "true" || $6 == "false")))
    status = "MALFORMED: the session row is missing or does not show the production host, database and owner in a read-only transaction"
  next
}
/^A1-ROWS / {
  if ($0 !~ /^A1-ROWS [0-9]+$/) { status = "MALFORMED: an unreadable row count"; next }
  rows = substr($0, 9) + 0
  if (rows != NR - 2) status = "MALFORMED: " (NR - 2) " lines for " rows " rows: a value holds a line break"
  next
}
{
  if (NF != 6) { status = "MALFORMED: line " NR " has " NF " fields, not 6"; next }
  if (!($1 in expected)) { status = "MALFORMED: unexpected check id on line " NR; next }
  if (seen[$1]++) { status = "MALFORMED: check " $1 " appears twice"; next }
  if ($1 == verdict) flag = "t"; else if ($1 in required) flag = "t"; else flag = "f"
  if ($3 != flag) { status = "MALFORMED: check " $1 " has required=" $3 ", not " flag; next }
  if ($6 != "t" && $6 != "f" && $6 != "") { status = "MALFORMED: check " $1 " has an ok flag that is not t, f or empty"; next }
  if ($1 == verdict) { vname = $2; vact = $5; vok = $6; next }
  if (flag == "t" && $6 != "t") failed = failed " " $1
}
END {
  if (status == "" && NR == 0) status = "MALFORMED: the output is empty"
  if (status == "" && rows < 0) status = "MALFORMED: the row count is missing"
  if (status == "") for (i = 1; i <= n; i++) if (!(want[i] in seen)) { status = "MALFORMED: check " want[i] " is missing"; break }
  if (status == "" && !(vname == "verdict" && vact == "PASS" && vok == "t")) status = "VERDICT: " verdict " is not PASS: " vact
  if (status == "" && failed != "") status = "REQUIRED: required checks not ok:" failed
  if (status == "") status = "OK"
  print status
}'

field(){ awk -F"$TAB" -v id="$2" '$1 == id { print $5 }' "$1"; } # output-file check-id -> actual
server_ssl(){ awk -F"$TAB" 'NR == 1 { print $6 }' "$1"; }       # output-file -> the session row's TLS flag

evaluate_checks(){ # file name, verdict id, expected ids, required ids
  local name=$1 verdict=$2 ids=$3 req=$4 out="$PP_OUT/out/${1%.sql}.tsv" status
  status=$(awk -v verdict="$verdict" -v ids="$ids" -v req="$req" -v host="$EXPECT_HOST" -v db="$EXPECT_DB" -v role="$EXPECT_ROLE" "$CHECKS_AWK" "$out") || stop 4 "$name: its output could not be read"
  [ "$status" = 'OK' ] || stop 4 "$name: $status"
  case $verdict in
    H99) rule_session_owner "$out" ;;
    C99) rule_catalog "$out" ;;
    I99) rule_identity_audit "$out" ;;
  esac
  note "session $name server_ssl=$(server_ssl "$out")"
  note "result $name $verdict PASS, every required check ok"
  printf '%s: %s PASS, every required check ok\n' "$name" "$verdict"
}

rule_session_owner(){ # P1 H07: the session role is the commercial table owner
  local v
  v=$(field "$1" H07)
  [ "$v" = "$EXPECT_ROLE owner=true" ] || stop 4 "P1 H07: the session role is not the commercial table owner: $v"
}

rule_catalog(){ # section 1: the server is PostgreSQL 18 (C01) and the commercial tables' owner is the role (C20)
  local c01 c20 num
  c01=$(field "$1" C01)
  c20=$(field "$1" C20)
  num=$(printf '%s\n' "$c01" | sed -n 's/^.*(server_version_num \([0-9][0-9]*\))$/\1/p')
  [ -n "$num" ] || stop 4 "C01 is malformed"
  [ "$((num / 10000))" -eq "$EXPECT_PG_MAJOR" ] || stop 4 "C01: the server is not PostgreSQL $EXPECT_PG_MAJOR (server_version_num $num)"
  [ "$c20" = "$EXPECT_ROLE super=false" ] || stop 4 "C20: the commercial tables are not owned by $EXPECT_ROLE alone, without superuser: $c20"
}

rule_identity_audit(){ # section 5 for the identity audit, beyond its required rows
  local out=$1 i03 i04 i07 i08 total verified impersonated other standing
  i03=$(field "$out" I03)
  i04=$(field "$out" I04)
  i07=$(field "$out" I07)
  i08=$(field "$out" I08)
  set -- $(printf '%s\n' "$i07" | sed -n 's/^total=\([0-9][0-9]*\); of verified users with no account=\([0-9][0-9]*\); impersonated=\([0-9][0-9]*\)$/\1 \2 \3/p')
  [ "$#" -eq 3 ] || stop 4 "I07 is malformed"
  total=$1 verified=$2 impersonated=$3
  [ "$impersonated" -eq 0 ] || stop 4 "I07: $impersonated live session(s) are impersonated"
  [ "$total" -eq "$verified" ] || stop 4 "I07: $((total - verified)) live session(s) do not belong to a verified user without an account row"
  [ "$total" -le 4 ] || hold "I07: $total live sessions, more than the four window sessions (D, E, A); the owner accounts for each one beyond them"
  case $i04 in ''|*[!0-9]*) stop 4 "I04 is malformed" ;; esac
  set -- $(printf '%s\n' "$i08" | sed -n 's/^memberships=\([0-9][0-9]*\); entries owned=\([0-9][0-9]*\)$/\1 \2/p')
  [ "$#" -eq 2 ] || stop 4 "I08 is malformed"
  standing=$(($1 + $2))
  if [ "$i04" -gt 0 ] && [ "$standing" -gt 0 ]; then
    hold "I04 and I08: $i04 verified user(s) hold a password or OAuth account, and users with an account row hold $1 membership(s) and $2 entr(y/ies); the owner confirms that every such identity with V1 standing has been recovered (otherwise A1 STOPs)"
  fi
  set -- $(printf '%s\n' "$i03" | sed -n 's/^\([0-9][0-9]*\) (synthetic pp-cv1-\*@example\.com: \([0-9][0-9]*\); other: \([0-9][0-9]*\))$/\1 \2 \3/p')
  [ "$#" -eq 3 ] || stop 4 "I03 is malformed"
  other=$3
  [ "$other" -eq 0 ] || hold "I03: $other non-synthetic unverified user(s) hold a password or OAuth account; the owner classifies each"
}

# P2 is an inventory, never an automatic PASS. Its rows have exactly five fields (kind, name, owner, detail, oid), so
# a tab or a line break inside a value fails closed. Then psql's row count, the runner's extra row, and its row count.
# STOP: a Data API role can use or create objects in the schema, reviewed public code names it or depends on it (a
# public function or a policy), a trigger outside it runs its code, or a view outside it that a Data API role can read
# depends on it; or the output is malformed. HOLD: everything else, the schema's absence included (the Data API listed
# it on 2026-10-28), for the owner's reading; and, from the extra row, readable views in public and login triggers.
INVENTORY_AWK='
BEGIN { FS = "\t"; status = ""; why = ""; schema = 0; rel = 0; fn = 0; fk = 0; view = 0; trig = 0; prov = 0; hint = ""
        rows = -1; outside = -1; readable = 0; code = 0; members = 0; pubviews = 0; logins = 0; done = 0 }
status != "" { next }
done { status = "MALFORMED: the output continues after the extra row"; next }
NR == 1 {
  if (!(NF == 7 && $1 == "A1-SESSION" && $2 == role && $3 == db && $4 == host && $5 == "on" && ($6 == "true" || $6 == "false")))
    status = "MALFORMED: the session row is missing or does not show the production host, database and owner in a read-only transaction"
  next
}
/^A1-ROWS / {
  if ($0 !~ /^A1-ROWS [0-9]+$/) { status = "MALFORMED: an unreadable row count"; next }
  c = substr($0, 9) + 0
  if (rows < 0) {
    rows = c
    if (rows != NR - 2) status = "MALFORMED: " (NR - 2) " lines for " rows " rows: a value holds a line break"
    next
  }
  if (outside < 0 || c != 1) { status = "MALFORMED: the extra row is missing or malformed"; next }
  done = 1
  next
}
rows >= 0 {
  if (outside >= 0) { status = "MALFORMED: more than one extra row"; next }
  if (!(NF == 11 && $1 == "A1-EXTRA" && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ && $6 ~ /^[0-9]+$/ && $8 ~ /^[0-9]+$/ && $10 ~ /^[0-9]+$/)) {
    status = "MALFORMED: the extra row is missing or malformed"; next
  }
  outside = $2 + 0; readable = $3 + 0; code = $4 + 0; members = $6 + 0; pubviews = $8 + 0; logins = $10 + 0
  next
}
{
  if (NF != 5) { status = "MALFORMED: line " NR " has " NF " fields, not 5"; next }
  if ($5 !~ /^[0-9]*$/) { status = "MALFORMED: line " NR " does not end in an oid"; next }
  kind = $1; name = $2; detail = $4
  if (kind == "schema") {
    schema++
    if (name != "pool_platform_private") status = "MALFORMED: a schema row for another schema"
    else if (detail !~ /; usage: anonymous=false authenticated=false; create: anonymous=false authenticated=false$/) why = why "; a Data API role can use or create objects in the schema"
  } else if (kind == "relation") rel++
  else if (kind == "function") fn++
  else if (kind == "dependency") {
    if (name == "named by reviewed public object") why = why "; reviewed public code names the schema (" detail ")"
    else if (name ~ /^trigger /) { trig++; if (detail !~ /^on pool_platform_private\./) why = why "; a trigger outside the schema runs its code (" detail ")" }
    else if (name ~ /^foreign key /) fk++
    else if (name ~ /^view /) view++
    else status = "MALFORMED: an unknown dependency row on line " NR
  } else if (kind == "provenance hint") { prov++; hint = detail }
  else status = "MALFORMED: an unknown row kind on line " NR
}
END {
  if (status == "" && NR == 0) status = "MALFORMED: the output is empty"
  if (status == "" && !done) status = "MALFORMED: the output ends before the extra row and its row count"
  if (status == "" && prov != 1) status = "MALFORMED: expected one provenance row, found " prov
  if (status == "" && schema > 1) status = "MALFORMED: more than one schema row"
  if (status == "" && schema == 0 && rel + fn + fk + view + trig > 0) status = "MALFORMED: objects listed without a schema row"
  if (status == "" && schema == 0 && hint !~ /^schema absent/) status = "MALFORMED: no schema row and no absence note"
  if (status == "" && schema == 1 && hint ~ /^schema absent/) status = "MALFORMED: a schema row and an absence note"
  if (status == "" && schema == 0 && outside + members > 0) status = "MALFORMED: the extra row lists objects of an absent schema"
  if (status == "" && readable > 0) why = why "; " readable " view(s) outside the schema that a Data API role can read depend on it"
  if (status == "" && code > 0) why = why "; " code " public function(s) or polic(y/ies) depend on it"
  if (status == "" && why != "") status = "STOP: " substr(why, 3)
  if (status == "" && schema == 0) status = "HOLD absent " rows " " pubviews " " logins
  if (status == "") status = "HOLD present " rows " " rel " " fn " " members " " fk " " view " " trig " " outside " " pubviews " " logins
  print status
}'

evaluate_inventory(){ # file name
  local name=$1 out="$PP_OUT/out/${1%.sql}.tsv" status rows pubviews logins
  status=$(awk -v host="$EXPECT_HOST" -v db="$EXPECT_DB" -v role="$EXPECT_ROLE" "$INVENTORY_AWK" "$out") || stop 4 "$name: its output could not be read"
  case $status in
    'HOLD absent '*)
      set -- ${status#HOLD absent }
      rows=$1 pubviews=$2 logins=$3
      hold "P2: pool_platform_private is absent, although the Data API listed it on 2026-10-28; the owner confirms why" ;;
    'HOLD present '*)
      set -- ${status#HOLD present }
      rows=$1 pubviews=$9 logins=${10}
      hold "P2: pool_platform_private holds $2 relation(s), $3 function(s) and $4 other object(s); $5 foreign key(s) and $6 view dependency(ies) involve it, $7 trigger(s) on its own relations call its code, and $8 object(s) outside it depend on it, directly or through views and functions; the owner explains every one from the window record" ;;
    *)
      stop 4 "$name: $status" ;;
  esac
  [ "$pubviews" -eq 0 ] || hold "public: $pubviews view(s) that a Data API role can read (named in the P2 evidence); the AUTH-C verifier checks tables only, so the owner confirms what each exposes"
  [ "$logins" -eq 0 ] || hold "server: $logins login event trigger(s) run code at every session start, this run's included (named in the P2 evidence); the owner explains each"
  note "session $name server_ssl=$(server_ssl "$out")"
  note "result $name HOLD, $rows inventory rows and the runner's catalog row kept whole in out/${name%.sql}.tsv"
  printf '%s: HOLD, %s inventory rows and the runner'"'"'s catalog row kept whole for the owner\n' "$name" "$rows"
}

i=0
while [ "$i" -lt 5 ]; do
  name=${F_NAME[$i]}
  if [ "${F_VERDICT[$i]}" = '-' ]; then
    run_one "$name" "$P2_EXTRA_SQL"
    evaluate_inventory "$name"
  else
    run_one "$name"
    evaluate_checks "$name" "${F_VERDICT[$i]}" "${F_IDS[$i]}" "${F_REQ[$i]}"
  fi
  i=$((i + 1))
done

# P2 always leaves a HOLD, so a run that gets here ends in HOLD.
[ -n "$HOLDS" ] || stop 4 "internal: no HOLD item recorded although P2 always needs the owner's reading"
printf '\nOwner interpretation is required before A1 can be recorded as PASS:\n'
printf '%s\n' "$HOLDS" | sed 's/^/  - /'
finalize HOLD 10
DONE=1
printf 'Evidence: %s/manifest.txt and %s/sha256sums.txt\n' "$PP_OUT" "$PP_OUT"
printf 'A1 RESULT: HOLD (exit 10)\n'
exit 10
}
