#!/usr/bin/env python3
"""Compare two Personal-database catalog snapshots (the output of catalog-snapshot.sql) and say what differs.

  python3 compare-catalog.py live.json rebuilt.json [--label-a live] [--label-b rebuilt]
  python3 compare-catalog.py live.json migrations-only.json --documented-backup-role
  python3 compare-catalog.py --environment live-env.json rebuilt-env.json
  python3 compare-catalog.py --validate [--environment] snapshot.json

Only reads the two files. The first two forms need the snapshot of each database saved as a file: for the real one, the
output of catalog-snapshot.sql run read-only by someone allowed to; for the other, what rebuild.sh built.

STRICT (the default): the two catalogs must be the same, row for row. Any difference is MATERIAL.

DOCUMENTED BACKUP ROLE (--documented-backup-role): the first snapshot is a database with the scoped backup role
(smokke_personal_cloud_backup_ro), the second one rebuilt from the migrations alone. The first must equal the second PLUS
exactly the eleven documented rows and nothing else: SELECT on the five application tables and on the one sequence (six
privilege rows, no grant option) and the five policies smokke_personal_cloud_backup_read (permissive, FOR SELECT, TO that
role only, USING (true)). Equality against that adjusted shape is strict: a documented row that is missing, a write-capable
grant, a grant option, a read grant on another object, a policy that names other roles, is for more than SELECT or tests
anything but true, and every other difference, is MATERIAL. The direction matters: the documented rows must be in the first
snapshot and not in the second; a second snapshot that already holds them is refused.

Both documents are validated first, whatever their hashes: every section must be present and every row of the right shape
(a section may be null, which is what an aggregate over nothing gives). An invalid document is never compared, and two
identical but incomplete documents never pass as identical.

Exit status: 0 when the catalogs are equal (strictly, or, with the flag, equal to the adjusted shape), 1 when anything is
material, 2 for a command line or a file that is not a valid snapshot. With --environment (the output of
environment-snapshot.sql) differences are only listed and never fail: two environments are expected to differ, and what
matters there is read by a person; an invalid document still exits 2.
"""
import argparse, collections, hashlib, json, re, signal, sys

SECTIONS = ('columns', 'tables', 'constraints', 'indexes', 'triggers', 'policies', 'functions', 'privileges')
ENVIRONMENT_SECTIONS = ('database', 'settings', 'schemas', 'extensions', 'roles', 'memberships', 'effective_privileges')

# The eleven rows the live database is documented to hold beyond the migrations (backup-role-delta.sql builds them).
BACKUP_ROLE = 'smokke_personal_cloud_backup_ro'
BACKUP_TABLES = ('nfl_contest_policies', 'nfl_contests', 'nfl_incident_rulings', 'nfl_pool_weeks', 'nfl_survivor_weeks')
BACKUP_SEQUENCE = 'nfl_incident_rulings_ruling_id_seq'
BACKUP_POLICY = 'smokke_personal_cloud_backup_read'


def documented_rows():
    return {
        'privileges': [['table', table, BACKUP_ROLE, 'SELECT', False] for table in BACKUP_TABLES]
                      + [['sequence', BACKUP_SEQUENCE, BACKUP_ROLE, 'SELECT', False]],
        'policies': [[table, BACKUP_POLICY, 'PERMISSIVE', 'SELECT', '{%s}' % BACKUP_ROLE, 'true', ''] for table in BACKUP_TABLES],
    }


# ---- validation -------------------------------------------------------------------------------------------------------
def text(v): return isinstance(v, str)
def flag(v): return isinstance(v, bool)
def maybe_flag(v): return v is None or isinstance(v, bool)
def count(v): return isinstance(v, int) and not isinstance(v, bool)
def char(v): return isinstance(v, str) and len(v) <= 1
def letter(v): return isinstance(v, str) and re.fullmatch(r'[A-Za-z]', v) is not None
def digest(v): return isinstance(v, str) and re.fullmatch(r'[0-9a-f]{64}', v) is not None
def one_of(*options): return lambda v: isinstance(v, str) and v in options
def role_list(v): return isinstance(v, str) and re.fullmatch(r'\{[^{}]*\}', v) is not None
def privilege_name(v): return isinstance(v, str) and re.fullmatch(r'[A-Z]+', v) is not None

CATALOG_SHAPES = {
    'columns': (text, text, text, flag, text, char, char),
    'tables': (text, letter, text, flag, flag),
    'constraints': (text, text, letter, text),
    'indexes': (text, text, text),
    'triggers': (text, text, letter, text),
    'policies': (text, text, one_of('PERMISSIVE', 'RESTRICTIVE'), one_of('ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'), role_list, text, text),
    'functions': (text, text, text, text, flag, letter, text, text, digest),
    'privileges': (one_of('table', 'sequence', 'function', 'column'), text, text, privilege_name, flag),
}
ENVIRONMENT_SHAPES = {
    'database': (text, text, text),
    'settings': (text, text),
    'schemas': (text, text),
    'extensions': (text, text, text),
    # name, login, superuser, createrole, bypassrls, createdb, inherit, replication, connection limit
    'roles': (text, flag, flag, flag, flag, flag, flag, flag, count),
    # member, role, admin option, inherit option (null before PostgreSQL 16), set option (null before 16), inherits (the effective answer)
    'memberships': (text, text, flag, maybe_flag, maybe_flag, flag),
    # role, kind, object, privilege, explicitly granted, effective, how, row-level security does not apply to the role
    'effective_privileges': (text, one_of('table', 'sequence'), text, privilege_name, flag, flag, text, flag),
}


class InvalidSnapshot(Exception):
    pass


def _no_duplicate_keys(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise InvalidSnapshot('a section appears twice')
    return dict(pairs)


def validate(document, sections, shapes):
    """Raise InvalidSnapshot unless the document has every section, no other, and every row of the right shape."""
    if not isinstance(document, dict):
        raise InvalidSnapshot(f'the document is a {type(document).__name__}, not an object of sections')
    missing = [name for name in sections if name not in document]
    unknown = sorted(name for name in document if name not in sections)
    if missing: raise InvalidSnapshot(f'missing section(s): {", ".join(missing)}')
    if unknown: raise InvalidSnapshot(f'unknown section(s): {", ".join(unknown)}')
    problems = []
    for name in sections:
        value = document[name]
        if value is None:  # an aggregate over no rows is null: legitimate
            continue
        if not isinstance(value, list):
            problems.append(f'{name}: not a list of rows'); continue
        shape = shapes[name]
        for index, row in enumerate(value):
            if not isinstance(row, list) or len(row) != len(shape):
                problems.append(f'{name}[{index}]: expected a row of {len(shape)} fields')
            else:
                bad = [str(position) for position, (check, field) in enumerate(zip(shape, row)) if not check(field)]
                if bad: problems.append(f'{name}[{index}]: field(s) {", ".join(bad)} of the wrong type or value')
            if len(problems) >= 5: break
        if len(problems) >= 5: break
    if problems:
        raise InvalidSnapshot('; '.join(problems) + (' (first problems only)' if len(problems) >= 5 else ''))


def load(path, sections, shapes):
    """Read, parse and validate one snapshot. Exit status 2, with a message on standard error, if it is not a valid one."""
    try:
        with open(path, encoding='utf-8') as handle:
            body = handle.read().rstrip('\n')
        if not body.strip():
            raise InvalidSnapshot('the file is empty')
        document = json.loads(body, object_pairs_hook=_no_duplicate_keys)
        validate(document, sections, shapes)
    except (OSError, ValueError, InvalidSnapshot) as error:
        sys.stderr.write(f'{path}: not a valid snapshot: {error}\n')
        raise SystemExit(2)
    # The hash rebuild.sh prints is of this very text, without the line end psql adds.
    return document, hashlib.sha256(body.encode('utf-8')).hexdigest()


# ---- comparison -------------------------------------------------------------------------------------------------------
def rows(document, section):
    return collections.Counter(json.dumps(row, sort_keys=True) for row in (document.get(section) or []))


def expected_with_documented_rows(b):
    """The migrations-only catalog plus the eleven documented rows: what the live database is documented to be."""
    expected = {section: rows(b, section) for section in SECTIONS}
    for section, extra in documented_rows().items():
        expected[section] = expected[section] + collections.Counter(json.dumps(row, sort_keys=True) for row in extra)
    return expected


def already_documented(b):
    return [section for section, extra in documented_rows().items()
            for row in extra if rows(b, section)[json.dumps(row, sort_keys=True)]]


def why(section, side, row, documented_mode):
    """What a difference means when it concerns the backup role. side is 'a' (the first snapshot has it) or 'b' (it lacks it)."""
    documented = documented_rows()
    if side == 'a' and row in documented.get(section, []):
        return ('a documented row found more often than documented' if documented_mode
                else 'one of the eleven documented backup-role rows (--documented-backup-role allows exactly these against a migrations-only catalog)')
    if section == 'privileges' and row[2] == BACKUP_ROLE:
        if side == 'b':
            return 'a documented read grant is missing' if row in documented['privileges'] else 'a documented grant differs from what was found'
        if row[4]: return 'a grant option: the backup role may not pass anything on'
        if row[3] != 'SELECT': return f'a {row[3]} privilege for the backup role, which may only read'
        return 'a read grant to the backup role that is not one of the six documented'
    if section == 'policies' and BACKUP_ROLE in row[4].strip('{}').split(','):
        if side == 'b':
            return 'a documented policy is missing' if row in documented['policies'] else 'a documented policy differs from what was found'
        if row[4] != '{%s}' % BACKUP_ROLE: return 'a policy that names roles besides the backup role: too broad'
        if row[3] != 'SELECT': return f'a policy for {row[3]}: the backup role may only read'
        if row[5] != 'true': return 'a policy for the backup role that does not read as USING (true)'
        return 'a policy for the backup role that is not one of the five documented'
    return ''


def differences(a, expected):
    found = []
    for section in SECTIONS:
        left, right = rows(a, section), expected[section]
        for side, only in (('a', left - right), ('b', right - left)):
            for body, number in sorted(only.items()):
                found.append((section, side, json.loads(body), number))
    return found


def show(items, label_a, label_b, documented_mode):
    for section, side, row, number in items:
        where = f'only in {label_a if side == "a" else label_b}'
        reason = why(section, side, row, documented_mode)
        print(f'  {section:<11} {where:<22} {json.dumps(row)}' + (f'  (x{number})' if number > 1 else '') + (f'\n  {"":<11} -> {reason}' if reason else ''))


# ---- environments -----------------------------------------------------------------------------------------------------
def environment_report(a, b, label_a, label_b):
    different = False
    for section in ENVIRONMENT_SECTIONS:
        left, right = rows(a, section), rows(b, section)
        for side, only in ((label_a, left - right), (label_b, right - left)):
            for body in sorted(only):
                different = True
                print(f'  {section:<20} only in {side:<14} {body}')
    for label, document in ((label_a, a), (label_b, b)):
        for name, _, superuser, _, bypass, *_ in document.get('roles') or []:
            if superuser or bypass:
                print(f'  NOTE {label}: role {name} is a superuser or bypasses row-level security: no policy applies to it')
        # What is held by membership rather than by grant: the catalog document lists explicit grants only, so this is where it shows.
        for member, role, _, _, _, inherits in document.get('memberships') or []:
            if role.startswith('pg_'):
                print(f'  NOTE {label}: role {member} is a member of the predefined role {role} ({"inherits its privileges" if inherits else "does not inherit its privileges"})')
        by_role = collections.defaultdict(lambda: collections.Counter())
        for role, kind, relation, privilege, explicit, effective, via, exempt in document.get('effective_privileges') or []:
            if effective and not explicit and via != 'public':
                by_role[(role, via)]['privileges'] += 1
                if exempt: by_role[(role, via)]['exempt'] += 1
        for (role, via), numbers in sorted(by_role.items()):
            rls = f'; row-level security does not apply to it on {numbers["exempt"]} of them' if numbers['exempt'] else ''
            print(f'  NOTE {label}: role {role} holds {numbers["privileges"]} effective privilege(s) on the application tables and sequences that no grant gives it explicitly, through {via}{rls}')
    print('environments differ (listed above; read by a person)' if different else 'the two environments list the same things')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('a'); parser.add_argument('b', nargs='?')
    parser.add_argument('--label-a', default='A'); parser.add_argument('--label-b', default='B')
    parser.add_argument('--documented-backup-role', action='store_true',
                        help='A must equal B plus exactly the eleven documented backup-role rows (B being the migrations-only catalog)')
    parser.add_argument('--environment', action='store_true', help='the files are environment-snapshot.sql output')
    parser.add_argument('--validate', action='store_true', help='only check that the one file is a valid snapshot and print its SHA-256')
    args = parser.parse_args(argv)
    if args.validate:
        if args.b is not None or args.documented_backup_role: parser.error('--validate takes one file and no other comparison')
        _, sha = load(args.a, ENVIRONMENT_SECTIONS if args.environment else SECTIONS, ENVIRONMENT_SHAPES if args.environment else CATALOG_SHAPES)
        print(f'sha256 {sha}')
        return 0
    if args.b is None: parser.error('two snapshots are needed (or --validate with one)')
    if args.environment and args.documented_backup_role:
        parser.error('--environment and --documented-backup-role are different comparisons')
    if args.environment:
        a, _ = load(args.a, ENVIRONMENT_SECTIONS, ENVIRONMENT_SHAPES); b, _ = load(args.b, ENVIRONMENT_SECTIONS, ENVIRONMENT_SHAPES)
        return environment_report(a, b, args.label_a, args.label_b)
    # Both documents are validated before anything is compared: nothing below can pass on an incomplete one.
    a, sha_a = load(args.a, SECTIONS, CATALOG_SHAPES); b, sha_b = load(args.b, SECTIONS, CATALOG_SHAPES)
    print(f'{args.label_a:<10} sha256 {sha_a}\n{args.label_b:<10} sha256 {sha_b}')
    if args.documented_backup_role:
        held = already_documented(b)
        if held:
            sys.stderr.write(f'{args.b}: already holds documented backup-role rows ({", ".join(sorted(set(held)))}): it must be the migrations-only catalog, and the snapshot with the role must come first\n')
            return 2
        expected = expected_with_documented_rows(b)
        found = differences(a, expected)
        if not found:
            print(f'MATCHES: {args.label_a} is {args.label_b} plus exactly the eleven documented backup-role rows, and nothing else')
            return 0
        print(f'{len(found)} material difference(s) from {args.label_b} plus the eleven documented backup-role rows')
        print('MATERIAL:'); show(found, args.label_a, args.label_b, True)
        return 1
    if sha_a == sha_b:
        print('IDENTICAL: the same catalog, row for row')
        return 0
    found = differences(a, {section: rows(b, section) for section in SECTIONS})
    if not found:  # the hashes differ only where one document has null and the other an empty list
        print('IDENTICAL in content: the same rows in every section (one document has null where the other has an empty list)')
        return 0
    print(f'{len(found)} material difference(s)')
    print('MATERIAL:'); show(found, args.label_a, args.label_b, False)
    return 1


if __name__ == '__main__':
    if hasattr(signal, 'SIGPIPE'): signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # `| head` must not end in a traceback
    sys.exit(main())
