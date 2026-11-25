#!/usr/bin/env python3
"""Compare two Personal-database catalog snapshots (the output of catalog-snapshot.sql) and say what differs.

  python3 compare-catalog.py live.json rebuilt.json [--label-a live] [--label-b rebuilt] [--env-role ROLE ...]
  python3 compare-catalog.py --environment live-env.json rebuilt-env.json

Only reads the two files. The first form needs the snapshot of each database saved as a file: for the real one, the
output of catalog-snapshot.sql run read-only by someone allowed to; for the other, what rebuild.sh built.

A row that names only a role of the environment (by default the scoped backup role) is EXPECTED ENVIRONMENT-SPECIFIC: a
privilege granted to it, or a policy that is for it alone. Everything else that is on one side only is MATERIAL: a column,
constraint, index, trigger, function body, owner, row-level-security flag, or any privilege or policy of any other role.
Exit status: 0 when the two are identical or differ only in environment-specific rows, 1 when anything is material, 2 for
a command line or a file that is not a snapshot. With --environment (the output of environment-snapshot.sql) differences are
only listed and never fail: two environments are expected to differ, and what matters there is read by a person.
"""
import argparse, collections, hashlib, json, sys

SECTIONS = ('columns', 'tables', 'constraints', 'indexes', 'triggers', 'policies', 'functions', 'privileges')
ENVIRONMENT_SECTIONS = ('database', 'settings', 'schemas', 'extensions', 'roles', 'memberships')
DEFAULT_ENV_ROLES = ('smokke_personal_cloud_backup_ro',)


def load(path, sections):
    try:
        with open(path, encoding='utf-8') as handle:
            text = handle.read().rstrip('\n')
        document = json.loads(text)
    except (OSError, ValueError) as error:
        sys.stderr.write(f'{path}: not a snapshot ({error})\n')
        raise SystemExit(2)
    if not isinstance(document, dict) or not set(document) <= set(sections):
        sys.stderr.write(f'{path}: not a snapshot of the expected kind (sections: {sorted(document) if isinstance(document, dict) else type(document).__name__})\n')
        raise SystemExit(2)
    # The hash rebuild.sh prints is of this very text, without the line end psql adds.
    return document, hashlib.sha256(text.encode('utf-8')).hexdigest()


def rows(document, section):
    return collections.Counter(json.dumps(row, sort_keys=True) for row in (document.get(section) or []))


def policy_roles(row):
    return {name for name in str(row[4]).strip('{}').split(',') if name}


def environment_specific(section, row, env_roles):
    if section == 'privileges':
        return row[2] in env_roles
    if section == 'policies':
        roles = policy_roles(row)
        return bool(roles) and roles <= set(env_roles)
    return False


def compare_catalog(a, b, env_roles):
    material, environment = [], []
    for section in SECTIONS:
        left, right = rows(a, section), rows(b, section)
        for side, only in (('a', left - right), ('b', right - left)):
            for text, count in sorted(only.items()):
                row = json.loads(text)
                target = environment if environment_specific(section, row, env_roles) else material
                target.append((section, side, row, count))
    return material, environment


def show(items, label_a, label_b):
    for section, side, row, count in items:
        where = f'only in {label_a if side == "a" else label_b}'
        print(f'  {section:<11} {where:<22} {json.dumps(row)}' + (f'  (x{count})' if count > 1 else ''))


def environment_report(a, b, label_a, label_b):
    different = False
    for section in ENVIRONMENT_SECTIONS:
        left, right = rows(a, section), rows(b, section)
        for side, only in ((label_a, left - right), (label_b, right - left)):
            for text in sorted(only):
                different = True
                print(f'  {section:<11} only in {side:<14} {text}')
    flagged = [row for row in (a.get('roles') or []) if len(row) > 3 and (row[2] or row[4])]
    for row in flagged:
        print(f'  NOTE {label_a}: role {row[0]} is a superuser or bypasses row-level security: {json.dumps(row)}')
    print('environments differ (listed above; read by a person)' if different else 'the two environments list the same things')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('a'); parser.add_argument('b')
    parser.add_argument('--label-a', default='A'); parser.add_argument('--label-b', default='B')
    parser.add_argument('--env-role', action='append', default=None, help='a role that exists only in one environment (default: the scoped backup role)')
    parser.add_argument('--environment', action='store_true', help='the files are environment-snapshot.sql output')
    args = parser.parse_args(argv)
    env_roles = tuple(args.env_role) if args.env_role else DEFAULT_ENV_ROLES
    if args.environment:
        a, _ = load(args.a, ENVIRONMENT_SECTIONS); b, _ = load(args.b, ENVIRONMENT_SECTIONS)
        return environment_report(a, b, args.label_a, args.label_b)
    a, sha_a = load(args.a, SECTIONS); b, sha_b = load(args.b, SECTIONS)
    print(f'{args.label_a:<10} sha256 {sha_a}\n{args.label_b:<10} sha256 {sha_b}')
    if sha_a == sha_b:
        print('IDENTICAL: the same catalog, row for row')
        return 0
    material, environment = compare_catalog(a, b, env_roles)
    print(f'{len(material)} material difference(s), {len(environment)} expected environment-specific ({", ".join(env_roles)})')
    if environment:
        print('EXPECTED ENVIRONMENT-SPECIFIC:'); show(environment, args.label_a, args.label_b)
    if material:
        print('MATERIAL:'); show(material, args.label_a, args.label_b)
    return 1 if material else 0


if __name__ == '__main__':
    sys.exit(main())
