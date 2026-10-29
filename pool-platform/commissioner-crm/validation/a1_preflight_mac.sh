#!/bin/bash
# A1 preflight for the owner's Mac. It checks, without connecting to anything, that the A1 files, the two detached
# signatures and the psql configuration are ready, and then prints the exact A1 command to use after the separate
# "Run A1 now" approval. It reads the psql service and password files only to check them, and prints no value from
# either (only key names, counts and whether each value is what A1 needs); it never prints a password, a key or a
# connection string, never opens the private signing key, and changes nothing. Run it yourself, in Terminal:
#
#   bash "$HOME/Documents/commissioner-crm-a1/pool-platform/commissioner-crm/validation/a1_preflight_mac.sh"
#
# The last line is PREFLIGHT RESULT: READY, or NOT READY with the number of items to fix (each marked STOP or TODO).
set -u
umask 077
export LC_ALL=C

REPO="$HOME/Documents/commissioner-crm-a1"
KIT="$REPO/pool-platform/commissioner-crm/validation"
EVIDENCE="$HOME/commissioner-crm-a1-evidence"
PUBKEY="$HOME/.ssh/crm_a1_signing_ed25519.pub"
SIGNING_KEY="$HOME/.ssh/crm_a1_signing_ed25519" # only named in the signing command printed below; never opened
PRINCIPAL='crm-a1-owner'
BRANCH='ccr-321cd6b3-fu8f1j'
HOST='ep-still-recipe-b5g7680z.c-7.us-east-2.aws.neon.tech'
POOLER_HOST='ep-still-recipe-b5g7680z-pooler.c-7.us-east-2.aws.neon.tech'
AUTHC='2c6e2a805fa816638808cb2d96d430ee177453e6'
RUNNER_SHA256='314ef9e4f0d0eeb264ce51cbc30f4f10a52be07179a76512da53820c2f3400b5'
ACK_SHA256='cccc8c1383d9ea650460424c075a28f9f0e0d6d20c52d1f151fe2841cb21b1df'
OLD_RUNNER_SHA256='d63654bc4ccd91ae88bbf1641527b0827b0e13272916554fb837453db9c78557'

TAB=$(printf '\t')
problems=0
ok(){ printf '[ok]   %s\n' "$*"; }
note(){ printf '[note] %s\n' "$*"; }
stop(){ problems=$((problems + 1)); printf '[STOP] %s\n' "$*"; }
todo(){ problems=$((problems + 1)); printf '[TODO] %s\n' "$*"; }
sha(){ shasum -a 256 2>/dev/null | awk '{print $1}'; } # stdin -> hex
mode_private(){ ls -ld "$1" 2>/dev/null | cut -c5-10; } # the group and other permission bits: ------ when private

# 1. This Mac, this terminal, the tools.
[ "$(uname -s 2>/dev/null)" = Darwin ] || { printf 'This preflight is for macOS only.\n'; exit 2; }
for marker in CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_REMOTE CI GITHUB_ACTIONS; do
  eval "marker_value=\${$marker:-}"
  [ -z "$marker_value" ] || { printf 'Run this yourself in Terminal, not from an AI agent or a CI job (%s is set).\n' "$marker"; exit 2; }
done
[ -t 0 ] || { printf 'Run this yourself in a Terminal window.\n'; exit 2; }
ok "macOS $(sw_vers -productVersion 2>/dev/null || printf 'version unknown'), bash $BASH_VERSION, in a terminal"
for tool in shasum ssh-keygen awk sed grep ls mktemp head cut tr sort env rm dirname; do
  command -v "$tool" >/dev/null 2>&1 || stop "the tool $tool is missing"
done
git --version >/dev/null 2>&1 || stop 'git does not work: install the Xcode Command Line Tools with: xcode-select --install'

# 2. The checkout and every pinned file.
if [ ! -d "$REPO/.git" ] && [ ! -f "$REPO/.git" ]; then
  stop "there is no git checkout at $REPO"
  printf '\nPREFLIGHT RESULT: NOT READY (%s to fix)\n' "$problems"
  exit 1
fi
ok "checkout $REPO at $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null) on $(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null)"
pinned(){ # file-in-kit sha: prints ok, or a STOP; returns 0 when it matches
  local f="$KIT/$1" h
  if [ ! -f "$f" ] || [ -L "$f" ]; then stop "$1 is missing from $KIT"; return 1; fi
  h=$(sha < "$f")
  if [ "$h" = "$2" ]; then ok "$1 $h"; return 0; fi
  if [ "$1" = a1_run.sh ] && [ "$h" = "$OLD_RUNNER_SHA256" ]; then
    stop "this checkout still has runner version 1; update it with: git -C \"$REPO\" pull --ff-only origin $BRANCH"
  else
    stop "$1 does not match its pinned SHA-256 (expected $2, found $h): do not sign or run anything; report this"
  fi
  return 1
}
pinned A1_AUTHORIZATION.md 8de895da4d7f75eb5654497a41c6e7c0f888f64d65c76d2a711725d872331c12 && AUTH_OK=1 || AUTH_OK=0
pinned a1_run.sh "$RUNNER_SHA256" || true
pinned A1_RUNNER_ACK.txt "$ACK_SHA256" && ACK_OK=1 || ACK_OK=0
pinned P1_identity_helpers_004.sql 9ef14dea4ea0f0ff9270b06eb05339f7dfe114accf9c6264d7dd810a979666ae || true
pinned P2_private_schema_inventory.sql 234b81f89d328107ff86b0564c32e57f25f220c8ad8da053dc2cbf82731e39d1 || true
pinned P3_crm_preconditions.sql f652ecad1d7adcc1f474d1b0af9753e7a8aec1e14567d03cb350c1312cd2333d || true
if git -C "$REPO" cat-file -e "$AUTHC^{commit}" 2>/dev/null; then
  for pair in neon-catalog-verify.sql:40b20416909c0ca2c26e2e682cb4ad2c5ef0b87fc257ca79d259dce55a0e9b43 \
              neon-identity-audit.sql:d512b94f8281fd201bcecb3efae3eb39fda2ab372b921d8f4a224bec012dca61; do
    name=${pair%%:*}
    h=$(git -C "$REPO" show "$AUTHC:pool-platform/validation/$name" 2>/dev/null | sha)
    if [ "$h" = "${pair#*:}" ]; then ok "$name at AUTH-C ${AUTHC%"${AUTHC#????????}"} $h"
    else stop "$name at AUTH-C does not match its pinned SHA-256 (found $h): report this"
    fi
  done
else
  stop "the AUTH-C commit is not in this checkout; fetch it with: git -C \"$REPO\" fetch origin $AUTHC"
fi

# 3. The signing key and the two detached signatures, checked against your public key only.
if [ ! -f "$PUBKEY" ]; then
  stop "your public signing key is not at $PUBKEY"
else
  fingerprint=$(ssh-keygen -l -f "$PUBKEY" 2>/dev/null | awk '{print $2, $NF}')
  ok "signing key $PUBKEY: $fingerprint (compare with the fingerprint you recorded)"
  allowed=$(mktemp "${TMPDIR:-/tmp}/a1-allowed-signers.XXXXXX")
  printf '%s namespaces="file" %s\n' "$PRINCIPAL" "$(awk '{print $1, $2; exit}' "$PUBKEY")" > "$allowed"
  verified(){ # file-in-kit: verifies file.sig; prints the result
    local out
    if out=$(ssh-keygen -Y verify -f "$allowed" -I "$PRINCIPAL" -n file -s "$KIT/$1.sig" < "$KIT/$1" 2>&1); then
      ok "$1.sig: $(printf '%s\n' "$out" | head -n 1)"
    else
      stop "$1.sig does not verify against $PUBKEY as $PRINCIPAL: $(printf '%s\n' "$out" | head -n 1)"
    fi
  }
  if [ "$AUTH_OK" -eq 1 ]; then
    if [ -f "$KIT/A1_AUTHORIZATION.md.sig" ]; then verified A1_AUTHORIZATION.md
    else stop "your detached signature A1_AUTHORIZATION.md.sig is not in $KIT: put it there (it is not secret)"
    fi
  fi
  if [ "$ACK_OK" -eq 1 ]; then
    if [ -f "$KIT/A1_RUNNER_ACK.txt.sig" ]; then verified A1_RUNNER_ACK.txt
    else
      todo "read $KIT/A1_RUNNER_ACK.txt, then sign it with the key that signed the authorization:"
      printf '         ssh-keygen -Y sign -f "%s" -n file "%s"\n' "$SIGNING_KEY" "$KIT/A1_RUNNER_ACK.txt"
      printf '       and run this preflight again.\n'
    fi
  fi
  rm -f "$allowed"
fi

# 4. psql, found on PATH or where Homebrew and Postgres.app put it.
PSQL=$(command -v psql 2>/dev/null || true)
PSQL_DIR_PREFIX=''
if [ -z "$PSQL" ]; then
  for candidate in /opt/homebrew/opt/libpq/bin/psql /usr/local/opt/libpq/bin/psql \
                   /opt/homebrew/opt/postgresql@18/bin/psql /opt/homebrew/opt/postgresql@17/bin/psql \
                   /opt/homebrew/opt/postgresql@16/bin/psql /usr/local/opt/postgresql@18/bin/psql \
                   /usr/local/opt/postgresql@17/bin/psql /usr/local/opt/postgresql@16/bin/psql \
                   /Applications/Postgres.app/Contents/Versions/latest/bin/psql; do
    if [ -x "$candidate" ]; then PSQL=$candidate; PSQL_DIR_PREFIX="PATH=\"${candidate%/psql}:\$PATH\" "; break; fi
  done
fi
PSQL_MAJOR=0
if [ -z "$PSQL" ]; then
  stop 'psql is not installed: install it with: brew install libpq'
else
  psql_version=$("$PSQL" --version 2>/dev/null | head -n 1)
  PSQL_MAJOR=$(printf '%s\n' "$psql_version" | sed -n 's/^psql (PostgreSQL) \([0-9][0-9]*\).*/\1/p')
  [ -n "$PSQL_MAJOR" ] || PSQL_MAJOR=0
  if [ "$PSQL_MAJOR" -ge 14 ]; then ok "psql $PSQL: $psql_version"
  else stop "psql $PSQL reports \"$psql_version\": A1 needs psql 14 or later (Neon routes by TLS SNI)"
  fi
  [ -z "$PSQL_DIR_PREFIX" ] || note "psql is not on PATH; the A1 command below puts ${PSQL%/psql} first"
fi

# 5. The service entry for the production host. Nothing read from the service file or the password file is printed:
# only key names from the two lists below, counts, and whether each value is what A1 needs, since a value can be
# anything, a password pasted into the wrong line included. PGSERVICEFILE, PGPASSFILE and PGSSLROOTCERT are not
# printed either.
# The keys the entry may set. libpq 14 and later know each one; the runner's connection string overrides host, port,
# dbname, user, sslmode and gssencmode, and the others only tune the connection.
KEYS_OK=' host port dbname user sslmode gssencmode sslrootcert password passfile channel_binding connect_timeout application_name fallback_application_name keepalives keepalives_idle keepalives_interval keepalives_count tcp_user_timeout '
# The other libpq keys, refused: A1 needs none of them, and several change or break its connection.
KEYS_REFUSED=' service hostaddr options replication sslsni sslkeylogfile requiressl sslnegotiation sslcompression sslcert sslkey sslpassword sslcertmode sslcrl sslcrldir requirepeer ssl_min_protocol_version ssl_max_protocol_version min_protocol_version max_protocol_version require_auth krbsrvname gsslib gssdelegation target_session_attrs load_balance_hosts client_encoding scram_client_key scram_server_key oauth_issuer oauth_client_id oauth_client_secret oauth_scope '
refusal(){ # refused key -> why
  case $1 in
    service) printf 'libpq does not allow it inside an entry' ;;
    hostaddr) printf 'it sends the connection to an address instead of the host name' ;;
    options) printf 'it can change the session, its search path for example, which the runner refuses' ;;
    replication) printf 'it opens a replication connection, which cannot run the checks' ;;
    sslsni) printf 'Neon routes the connection by its TLS server name, which libpq sends by default' ;;
    sslkeylogfile) printf "it writes the session's TLS keys to a file" ;;
    requiressl) printf 'libpq 18 rejects it, and the runner sets sslmode=verify-full' ;;
    *) printf 'A1 does not use it' ;;
  esac
}
if [ -n "${PGSERVICEFILE:-}" ]; then SERVICE_FILE=$PGSERVICEFILE; SERVICE_DESC='the service file that PGSERVICEFILE names'
else SERVICE_FILE="$HOME/.pg_service.conf"; SERVICE_DESC=$SERVICE_FILE
fi
SERVICE=''
ENTRY=''
tagged(){ printf '%s\n' "$ENTRY" | awk -F'\t' -v t="$1" '$1 == t { f = 1 } END { exit !f }'; }
tagval(){ printf '%s\n' "$ENTRY" | awk -F'\t' -v t="$1" '$1 == t { print substr($0, length(t) + 2); exit }'; }
service_checks(){
  local hits pooled dups bad twice key extra='' rootcert rootdesc passfile passdesc matches
  case $SERVICE_FILE in
    /*) ;;
    *) stop 'PGSERVICEFILE is not an absolute path (not shown): psql would look for it in the directory A1 runs from'; return ;;
  esac
  if [ ! -f "$SERVICE_FILE" ] || [ ! -r "$SERVICE_FILE" ]; then stop "$SERVICE_DESC does not exist or cannot be read"; return; fi
  # As libpq reads the file: a section's name runs from [ to the first ]; only the first section of a name counts,
  # and within it the first value of a key; one line that is not key=value with a known key makes libpq reject the
  # whole entry. The values stay here: the lines this prints carry tags, counts and key names, and the two paths
  # this script must check.
  ENTRY=$(awk -v host="$HOST" -v pooler="$POOLER_HOST" -v known="$KEYS_OK$KEYS_REFUSED" '
    BEGIN { nk = split(known, kl, " "); for (i = 1; i <= nk; i++) isknown[kl[i]] = 1 }
    { line = $0; sub(/^[ \t\r\f\v]+/, "", line); sub(/[ \t\r\f\v]+$/, "", line) }
    line == "" || substr(line, 1, 1) == "#" { next }
    substr(line, 1, 1) == "[" {
      insec = 0
      e = index(line, "]")
      if (e <= 2) next
      sec = substr(line, 2, e - 2)
      if (sec in seen) { dup[sec] = 1; dups++; next }
      seen[sec] = 1; order[++n] = sec; insec = 1
      next
    }
    !insec { next }
    {
      eq = index(line, "=")
      key = eq ? substr(line, 1, eq - 1) : ""
      if (!(key in isknown)) { bad[sec]++; next }
      if ((sec, key) in val) { if (!((sec, key) in rep)) { rep[sec, key] = 1; twice[sec] = twice[sec] " " key }; next }
      val[sec, key] = substr(line, eq + 1); keys[sec] = keys[sec] " " key
    }
    END {
      for (i = 1; i <= n; i++) {
        s = order[i]
        if (val[s, "host"] == pooler) pooled++
        if (val[s, "host"] == host) { hits++; pick = s }
      }
      printf "COUNTS\t%d\t%d\t%d\n", hits, pooled, dups
      if (hits != 1) exit
      if (pick !~ /^[A-Za-z0-9._-]+$/) { print "BADNAME"; exit }
      s = pick
      print "SECTION\t" s
      printf "BAD\t%d\n", bad[s]
      if (s in dup) print "DUPNAME"
      if (twice[s] != "") print "TWICE\t" substr(twice[s], 2)
      k = split(keys[s], list, " ")
      for (j = 1; j <= k; j++) {
        key = list[j]; v = val[s, key]
        print "KEY\t" key
        if (key == "port" && v != "5432" || key == "dbname" && v != "neondb" || key == "user" && v != "neondb_owner" || key == "sslmode" && v != "verify-full") print "DIFFERS\t" key
        else if (key == "sslrootcert") print "ROOTCERT\t" v
        else if (key == "passfile") print "PASSFILE\t" v
        else if (key == "password") print "PASSWORD\t" (v == "" ? "empty" : (v ~ /^[ \t\f\v]/ ? "leading-space" : "set"))
      }
    }' "$SERVICE_FILE" 2>/dev/null) || ENTRY=''
  set -- $(tagval COUNTS)
  hits=${1:-0} pooled=${2:-0} dups=${3:-0}
  if [ "$hits" -eq 0 ]; then
    if [ "$pooled" -gt 0 ]; then stop "the entry for this endpoint in $SERVICE_DESC uses the pooler host; A1 needs one with the direct host $HOST"
    else stop "no entry in $SERVICE_DESC has host=$HOST"
    fi
    [ "$dups" -eq 0 ] || note "$dups section name(s) appear there more than once; libpq reads only the first section of each name"
    return
  fi
  if [ "$hits" -gt 1 ]; then stop "$hits entries in $SERVICE_DESC have host=$HOST: keep only the one for A1"; return; fi
  if tagged BADNAME; then
    stop "the entry with host=$HOST has a name (not shown) that is not only letters, digits, dot, underscore and hyphen, which the runner requires: rename it"
    return
  fi
  SERVICE=$(tagval SECTION)
  ok "service entry [$SERVICE] in $SERVICE_DESC has host=$HOST"
  ! tagged DUPNAME || note "a later section is also named [$SERVICE]; libpq reads only this first one"
  bad=$(tagval BAD)
  [ "${bad:-0}" -eq 0 ] || stop "the entry [$SERVICE] has $bad line(s), not shown, that are not key=value with a key this preflight knows; libpq rejects the whole entry for a misspelt key, so correct or remove them"
  twice=$(tagval TWICE)
  [ -z "$twice" ] || stop "the entry [$SERVICE] sets $twice more than once: keep one line for each"
  for key in $(printf '%s\n' "$ENTRY" | awk -F'\t' '$1 == "KEY" { print $2 }'); do
    case $KEYS_REFUSED in
      *" $key "*) stop "the entry [$SERVICE] sets $key: remove that line ($(refusal "$key"))" ;;
      *) case $key in host|port|dbname|user|sslmode|sslrootcert|password|passfile) ;; *) extra="$extra$key " ;; esac ;;
    esac
  done
  # The runner pins the port, database, role and TLS mode in its connection string; the entry's values only matter here.
  for pin in port:5432 dbname:neondb user:neondb_owner sslmode:verify-full; do
    key=${pin%%:*}
    if printf '%s\n' "$ENTRY" | grep -qx "DIFFERS$TAB$key"; then
      note "the entry's $key is not ${pin#*:} (value not shown); the runner connects with $key=${pin#*:} regardless"
    else ok "$key=${pin#*:}"
    fi
  done
  [ -z "$extra" ] || note "the entry also sets ${extra}(values not shown)"
  # libpq takes the root certificate from the entry, else from PGSSLROOTCERT, else from ~/.postgresql/root.crt.
  if tagged ROOTCERT; then rootcert=$(tagval ROOTCERT); rootdesc="the entry's sslrootcert"
  elif [ -n "${PGSSLROOTCERT:-}" ]; then rootcert=$PGSSLROOTCERT; rootdesc='PGSSLROOTCERT'
  else rootcert=''; rootdesc=''
  fi
  if [ -z "$rootdesc" ]; then
    if [ -f "$HOME/.postgresql/root.crt" ]; then ok "no sslrootcert in the entry; $HOME/.postgresql/root.crt will be used"
    else stop "the entry [$SERVICE] has no sslrootcert, and $HOME/.postgresql/root.crt does not exist: add the line sslrootcert=/etc/ssl/cert.pem"
    fi
  else
    case $rootcert in
      system)
        if [ "$PSQL_MAJOR" -ge 16 ]; then ok "$rootdesc is system (the macOS trust store)"
        else stop "$rootdesc is system, which needs psql 16 or later: use sslrootcert=/etc/ssl/cert.pem"
        fi ;;
      '') stop "$rootdesc is empty: name the root certificate file, for example sslrootcert=/etc/ssl/cert.pem" ;;
      /*)
        if [ -f "$rootcert" ] && [ -r "$rootcert" ]; then ok "the root certificate file that $rootdesc names exists (path not shown)"
        else stop "the root certificate file that $rootdesc names does not exist or cannot be read (path not shown)"
        fi ;;
      *) stop "$rootdesc is not an absolute path (not shown): write the full path; libpq expands neither ~ nor a path relative to your home" ;;
    esac
  fi

  # 6. The password source, never printed: the entry itself, or the password file with exactly this entry's line.
  case $(tagval PASSWORD) in
    set)
      note "the entry [$SERVICE] holds a password (not shown)"
      if [ "$(mode_private "$SERVICE_FILE")" != '------' ]; then
        if [ -n "${PGSERVICEFILE:-}" ]; then stop 'the entry holds a password, so make the service file private: run chmod 600 on the file that PGSERVICEFILE names'
        else stop "the entry holds a password, so make $SERVICE_FILE private: chmod 600 \"$SERVICE_FILE\""
        fi
      fi
      return ;;
    leading-space)
      stop "the password in the entry [$SERVICE] (not shown) starts with a space or tab, which libpq keeps as part of it: remove that space"
      return ;;
    empty) note "the entry [$SERVICE] has an empty password line, so libpq takes the password from the password file" ;;
  esac
  if tagged PASSFILE; then passfile=$(tagval PASSFILE); passdesc="the password file that the entry's passfile names"
  elif [ -n "${PGPASSFILE:-}" ]; then passfile=$PGPASSFILE; passdesc='the password file that PGPASSFILE names'
  else passfile="$HOME/.pgpass"; passdesc=$passfile
  fi
  case $passfile in
    '') stop "the entry [$SERVICE] has an empty passfile line: remove it, or name the password file"; return ;;
    /*) ;;
    *) stop "$passdesc is not an absolute path (not shown): psql would look for it in the directory A1 runs from"; return ;;
  esac
  if [ ! -f "$passfile" ] || [ ! -r "$passfile" ]; then
    if [ "$passdesc" = "$passfile" ]; then stop "there is no password file at $passfile: create it with one line that starts with $HOST:5432:neondb:neondb_owner: and continues with the password, then run chmod 600 \"$passfile\""
    else stop "$passdesc does not exist or cannot be read"
    fi
    return
  fi
  if [ "$(mode_private "$passfile")" != '------' ]; then
    if [ "$passdesc" = "$passfile" ]; then stop "$passfile is readable by others, so libpq ignores it: chmod 600 \"$passfile\""
    else stop "$passdesc is readable by others, so libpq ignores it: run chmod 600 on it"
    fi
    return
  fi
  matches=$(awk -F: -v h="$HOST" -v p=5432 '
    /^[ \t]*#/ { next }
    NF >= 5 && ($1 == h || $1 == "*") && ($2 == p || $2 == "*") && ($3 == "neondb" || $3 == "*") && ($4 == "neondb_owner" || $4 == "*") { c++ }
    END { print c + 0 }' "$passfile" 2>/dev/null) || matches=0
  case $matches in ''|*[!0-9]*) matches=0 ;; esac
  if [ "$matches" -ge 1 ]; then
    ok "$passdesc is private and has $matches line(s) for this host, port, database and role (passwords not shown)"
    [ "$matches" -eq 1 ] || note 'libpq uses the first of those lines'
  else
    stop "$passdesc has no line for this connection: add one that starts with $HOST:5432:neondb:neondb_owner: and continues with the password"
  fi
}
service_checks
[ -z "${PGPASSWORD:-}" ] || stop 'PGPASSWORD is set in this shell (value not shown): run unset PGPASSWORD; A1 takes the password from the password file'
# The runner clears exactly these; any other PG variable reaches psql as it is.
CLEARED=' PGSERVICE PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGOPTIONS PGSSLMODE PGREQUIRESSL PGGSSENCMODE PGSSLNEGOTIATION PGTARGETSESSIONATTRS PGLOADBALANCEHOSTS PGCLIENTENCODING PGTZ PGDATESTYLE PGGEQO '
cleared='' kept=''
for var in $(env | sed -n 's/^\(PG[A-Z0-9_]*\)=.*/\1/p' | sort); do
  case $CLEARED in
    *" $var "*) cleared="$cleared$var " ;;
    *) case $var in PGPASSWORD|PGSERVICEFILE|PGPASSFILE|PGSSLROOTCERT) ;; *) kept="$kept$var " ;; esac ;;
  esac
done
[ -z "$cleared" ] || note "this shell sets $cleared(values not shown); the runner clears them"
[ -z "$kept" ] || note "this shell also sets $kept(values not shown); psql uses them as they are"

# 7. The evidence directory: private, local, outside every git repository and the synced folders.
up=$EVIDENCE
while :; do
  if [ -e "$up/.git" ]; then stop "$EVIDENCE would be inside the git repository at $up, which the runner refuses"; break; fi
  [ "$up" != / ] || break
  up=$(dirname "$up")
done
if [ -L "$EVIDENCE" ]; then
  stop "$EVIDENCE is a symbolic link: use a plain directory"
elif [ -d "$EVIDENCE" ]; then
  if [ "$(mode_private "$EVIDENCE")" = '------' ]; then ok "evidence directory $EVIDENCE is private; each run writes a new subdirectory"
  else stop "$EVIDENCE is readable by others: chmod 700 \"$EVIDENCE\""
  fi
elif [ -e "$EVIDENCE" ]; then
  stop "$EVIDENCE exists and is not a directory"
else
  ok "evidence directory $EVIDENCE does not exist yet; the run creates it, private"
fi

printf '\n'
if [ "$problems" -ne 0 ]; then
  printf 'PREFLIGHT RESULT: NOT READY (%s to fix)\n' "$problems"
  exit 1
fi
printf 'Send this output to the session. After your separate "Run A1 now" approval, run exactly:\n\n'
printf '  %sPP_SERVICE=%s PP_REPO="$HOME/Documents/commissioner-crm-a1" \\\n' "$PSQL_DIR_PREFIX" "$SERVICE"
printf '  PP_OUT="$HOME/commissioner-crm-a1-evidence/run-$(date -u +%%Y%%m%%dT%%H%%M%%SZ)" \\\n'
printf '  PP_RUNNER_SHA256=%s \\\n' "$RUNNER_SHA256"
printf '  bash "$HOME/Documents/commissioner-crm-a1/pool-platform/commissioner-crm/validation/a1_run.sh"\n\n'
printf 'PREFLIGHT RESULT: READY\n'
