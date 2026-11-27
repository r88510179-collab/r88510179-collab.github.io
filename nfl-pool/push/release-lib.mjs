// Pool Alerts release automation: the parts with no network, database or clock of their own, unit-tested in
// release.test.mjs. The operations themselves are in release.mjs.
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';

export const sha256Hex = data => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// Credentials. One control key (32+ random bytes, base64url) is kept by the owner as a GitHub environment secret and as
// a server-only Vercel variable of the Maintenance Center. Every token is DERIVED from it, per app, environment and
// purpose, so the release workflow, the Maintenance Center and the monitor compute the same tokens and nothing has to
// be copied around; the sender stores only their SHA-256. A different purpose or environment never yields the same
// token, and the control key cannot be recovered from a token.
// ---------------------------------------------------------------------------------------------------------------
export const APPS = Object.freeze(['personal', 'commercial']);
export const ENVIRONMENTS = Object.freeze(['production', 'staging']);
export const PURPOSES = Object.freeze(['owner', 'status']);
const CONTROL_KEY = /^[A-Za-z0-9_-]{43,512}$/;

export function checkControlKey(value) {
  if (typeof value !== 'string' || !CONTROL_KEY.test(value) || Buffer.from(value, 'base64url').length < 32) {
    throw new Error('POOL_ALERTS_CONTROL_KEY must be at least 32 random bytes in base64url (e.g. node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))")');
  }
  return value;
}
export function deriveToken(controlKey, {app, environment, purpose}) {
  checkControlKey(controlKey);
  if (!APPS.includes(app) || !ENVIRONMENTS.includes(environment) || !PURPOSES.includes(purpose)) throw new Error('Unknown token');
  return createHmac('sha256', Buffer.from(controlKey, 'base64url')).update(`pool-alerts/v1/${app}/${environment}/${purpose}`).digest('base64url');
}
export const randomPassword = () => randomBytes(30).toString('base64url');

// ---------------------------------------------------------------------------------------------------------------
// SQL scripts over Neon's HTTP endpoint, which runs one statement per query (prepared statements): a migration file is
// split into its statements and sent as ONE batch, which Neon runs in one transaction. The top-level BEGIN and COMMIT
// are dropped (the batch is the transaction); everything else is kept byte for byte. Quotes, identifiers, comments and
// dollar-quoted bodies are honoured; a psql meta-command is refused (it would silently not run). Over TCP (the release
// workflow) the file is sent whole and unsplit; release.spec.mjs proves both give the same catalog.
// ---------------------------------------------------------------------------------------------------------------
export function splitSqlScript(text) {
  const statements = [];
  let start = 0, i = 0;
  const n = text.length;
  const push = end => {
    const statement = text.slice(start, end).trim();
    if (statement && !isOnlyComments(statement)) statements.push(statement);
    start = end + 1;
  };
  while (i < n) {
    const c = text[i], next = text[i + 1];
    if (c === '-' && next === '-') { const eol = text.indexOf('\n', i); i = eol < 0 ? n : eol + 1; continue; }
    if (c === '/' && next === '*') {
      let depth = 1; i += 2;
      while (i < n && depth) { if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; } else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; } else i++; }
      if (depth) throw new Error('Unterminated block comment');
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      for (;;) {
        if (i >= n) throw new Error(`Unterminated ${c === "'" ? 'string' : 'identifier'}`);
        if (text[i] === c) { if (text[i + 1] === c) { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c === '$' && !/[A-Za-z0-9_]/.test(text[i - 1] || '')) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 80));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        if (close < 0) throw new Error(`Unterminated dollar-quoted body ${tag[0]}`);
        i = close + tag[0].length;
        continue;
      }
    }
    if (c === '\\' && (i === 0 || text[i - 1] === '\n')) throw new Error('psql meta-commands cannot run over HTTP');
    if (c === ';') { push(i); i++; continue; }
    i++;
  }
  push(n);
  return statements.filter(statement => !/^(BEGIN|COMMIT)$/i.test(stripComments(statement).trim()));
}
function stripComments(statement) { return statement.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); }
function isOnlyComments(statement) { return !stripComments(statement).trim(); }

// ---------------------------------------------------------------------------------------------------------------
// Evidence. Every report the release writes goes through scrub(): any configured secret (and anything derived from
// the control key), credentials inside a URL, and fields whose name says they hold a secret are replaced, so a report
// can be uploaded as a workflow artifact and pasted into a pull request.
// ---------------------------------------------------------------------------------------------------------------
const SECRET_FIELD = /(password|secret|private|token(?!_?sha)|connection.?(string|uri)|^uri$|authorization|control.?key)/i;
export function scrub(value, secrets = []) {
  const known = secrets.filter(s => typeof s === 'string' && s.length >= 8);
  const clean = text => {
    let out = text.replace(/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/gi, '$1[redacted]@');
    for (const secret of known) if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    return out;
  };
  return JSON.parse(JSON.stringify(value, (key, v) => {
    if (key && SECRET_FIELD.test(key) && v !== null && typeof v !== 'boolean' && typeof v !== 'object') return '[redacted]';
    return typeof v === 'string' ? clean(v) : v;
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// The release manifest (release-manifest.json): the exact migration files of this release, their SHA-256, and the
// catalog fingerprint (push/fingerprint.sql) the database must show after each one. CI keeps it honest: the SQL gate
// computes the fingerprints on a fresh production-shaped database and fails on any difference, and release.test.mjs
// fails when a migration file no longer matches its digest.
// ---------------------------------------------------------------------------------------------------------------
export function loadManifest(url = new URL('./release-manifest.json', import.meta.url), root = new URL('../../', import.meta.url)) {
  const manifest = JSON.parse(readFileSync(url, 'utf8'));
  const problems = [];
  for (const m of manifest.migrations) {
    for (const [file, digest] of [[m.file, m.sha256], [m.rollback, m.rollbackSha256]]) {
      const actual = sha256Hex(readFileSync(new URL(file, root)));
      if (actual !== digest) problems.push(`${file}: sha256 ${actual}, manifest ${digest}`);
    }
  }
  return {manifest, problems};
}

// Which migrations a database still needs, from what it reports (schema present, device checks present) and its
// fingerprint: refuses a database that is part-way or different from every reviewed state.
export function migrationPlan(manifest, {fingerprint}) {
  if (fingerprint === manifest.fingerprintBefore) return {state: 'none', pending: manifest.migrations.map(m => m.id)};
  const index = manifest.migrations.findIndex(m => m.fingerprintAfter === fingerprint);
  if (index < 0) return {state: 'unknown', pending: null};
  return {state: manifest.migrations[index].id, pending: manifest.migrations.slice(index + 1).map(m => m.id)};
}

// The next run of a five-field cron expression with only "minute *"-style or list minutes and "*" elsewhere (what
// the Pool Alerts triggers use), in UTC. Anything else returns null rather than a guess.
export function nextCronRun(cron, from = Date.now()) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5 || parts.slice(1).some(p => p !== '*') || !/^\d{1,2}(,\d{1,2})*$/.test(parts[0])) return null;
  const minutes = parts[0].split(',').map(Number).filter(m => m < 60).sort((a, b) => a - b);
  const base = new Date(from);
  base.setUTCSeconds(0, 0);
  for (let h = 0; h < 25; h++) {
    for (const m of minutes) {
      const at = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), base.getUTCHours() + h, m);
      if (at > from) return new Date(at).toISOString();
    }
  }
  return null;
}

// Confirmation words for every operation that changes something: the workflow's "confirm" input must be exactly this.
export const confirmationFor = (operation, environment) => `${operation}-${environment}`;
export const CHANGING = Object.freeze(['backup', 'stage', 'activate', 'pause', 'resume', 'rollback']);

// The read-only fingerprint query of push/fingerprint.sql, without its psql wrapper.
export function fingerprintQuery(text = readFileSync(new URL('./fingerprint.sql', import.meta.url), 'utf8')) {
  const start = text.indexOf('WITH owner_names'), end = text.lastIndexOf('FROM parts');
  if (start < 0 || end < 0) throw new Error('fingerprint.sql has an unexpected shape');
  // Named columns (the file's own SELECT leaves them unnamed for psql -At), so every client reads all six.
  return `SELECT * FROM (${text.slice(start, end + 'FROM parts'.length)}) AS f(schema, counts, functions, relations, triggers, sender_role)`;
}

// ---------------------------------------------------------------------------------------------------------------
// Verify before commit. Every migration and rollback file is one transaction that ends with its own top-level COMMIT.
// The release inserts, just before that COMMIT, a check that the catalog is exactly the reviewed fingerprint: a database
// that would end up in any other state raises inside the transaction and keeps the state it had, so a release can never
// leave a half-reviewed catalog behind. Over HTTP the guard is the last statement of the batch (the batch is the
// transaction). The file itself is otherwise sent unchanged.
// ---------------------------------------------------------------------------------------------------------------
export const GUARD_MESSAGE = 'pool alerts release: the catalog would be';
export function fingerprintGuard(expected, query = fingerprintQuery()) {
  if (!/^[0-9a-f]{64}$/.test(expected || '')) throw new Error('A reviewed fingerprint is 64 lowercase hex digits');
  if (query.includes('$pool_alerts_guard$')) throw new Error('The fingerprint query must not contain the guard delimiter');
  return `DO $pool_alerts_guard$
DECLARE got text;
BEGIN
  SELECT substr(q.schema, 15) INTO got FROM (${query}) AS q;
  IF got IS DISTINCT FROM '${expected}' THEN
    RAISE EXCEPTION '${GUARD_MESSAGE} %, not the reviewed ${expected}; nothing was committed', coalesce(got, 'unknown');
  END IF;
END
$pool_alerts_guard$;`;
}
export function withGuard(script, guard) {
  const match = /(^|\n)COMMIT;\s*$/.exec(script);
  if (!match) throw new Error('A migration file must end with its own top-level COMMIT;');
  const at = match.index + match[1].length;
  return `${script.slice(0, at)}${guard}\n${script.slice(at)}`;
}
