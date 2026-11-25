#!/usr/bin/env python3
"""Self-test of compare-catalog.py on small made-up snapshots. No database. Run: python3 nfl-pool/sql-tests/test_compare_catalog.py

The negative tests are the point: the tool is what decides whether the real database matches the repository, so it is shown
to refuse every way it could be fooled: a write grant, a missing read grant, a grant option, an overbroad or different policy,
the documented rows in the wrong direction or twice, and documents that are empty, incomplete or malformed."""
import contextlib, hashlib, importlib.util, io, json, os, tempfile, unittest

spec = importlib.util.spec_from_file_location('compare_catalog', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compare-catalog.py'))
cc = importlib.util.module_from_spec(spec); spec.loader.exec_module(cc)

BACKUP = 'smokke_personal_cloud_backup_ro'
TABLES = list(cc.BACKUP_TABLES)
SEQUENCE = cc.BACKUP_SEQUENCE
BASE = {
    'columns': [['nfl_pool_weeks', 'week', 'integer', True, '', '', '']],
    'tables': [[t, 'r', 'nfl_pool_owner', True, False] for t in TABLES],
    'constraints': [['nfl_pool_weeks', 'nfl_pool_weeks_pkey', 'p', 'PRIMARY KEY (week)']],
    'indexes': [['nfl_pool_weeks', 'nfl_pool_weeks_pkey', 'CREATE UNIQUE INDEX nfl_pool_weeks_pkey ON public.nfl_pool_weeks USING btree (week)']],
    'triggers': [['nfl_pool_weeks', 'guard', 'O', 'CREATE TRIGGER guard BEFORE UPDATE ON public.nfl_pool_weeks FOR EACH ROW EXECUTE FUNCTION f()']],
    'policies': [['nfl_pool_weeks', 'public_read', 'PERMISSIVE', 'SELECT', '{anonymous}', 'true', '']],
    'functions': [['f', '', 'void', 'plpgsql', False, 'v', '', 'nfl_pool_owner', 'ab' * 32]],
    'privileges': [['table', 'nfl_pool_weeks', 'anonymous', 'SELECT', False]],
}
POLICY = [TABLES[0], cc.BACKUP_POLICY, 'PERMISSIVE', 'SELECT', '{%s}' % BACKUP, 'true', '']


def doc(**changes):
    d = json.loads(json.dumps(BASE)); d.update(changes); return d


def with_documented(base=None, **extra):
    """The migrations-only catalog plus the eleven documented rows (what the live database is documented to be)."""
    d = json.loads(json.dumps(base or BASE))
    for section, added in cc.documented_rows().items(): d[section] = d[section] + json.loads(json.dumps(added))
    for section, added in extra.items(): d[section] = d[section] + added
    return d


def run_text(a, b, *extra):
    """a and b are the text of the two files (or a document, which is dumped). Returns (status, stdout, stderr)."""
    with tempfile.TemporaryDirectory() as folder:
        paths = []
        for name, value in (('a.json', a), ('b.json', b)):
            if value is None: continue
            path = os.path.join(folder, name)
            with open(path, 'w') as handle: handle.write(value if isinstance(value, str) else json.dumps(value) + '\n')
            paths.append(path)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try: status = cc.main([*paths, '--label-a', 'live', '--label-b', 'rebuilt', *extra])
            except SystemExit as stop: status = stop.code
        return status, out.getvalue(), err.getvalue()


class StrictComparison(unittest.TestCase):
    def test_identical_catalogs_pass_and_say_so(self):
        status, out, _ = run_text(doc(), doc())
        self.assertEqual(status, 0); self.assertIn('IDENTICAL', out)

    def test_without_the_flag_the_backup_roles_rows_are_material_like_any_others(self):
        status, out, _ = run_text(with_documented(), doc())
        self.assertEqual(status, 1, out); self.assertIn('11 material difference(s)', out); self.assertIn('MATERIAL:', out)
        self.assertIn('documented backup-role rows', out)  # it says what they are and how to allow exactly them

    def test_there_is_no_wildcard_role_any_more(self):
        for extra in (['--env-role', 'a_new_reader'], ['--env-role=smokke_personal_cloud_backup_ro']):
            with self.subTest(extra):
                self.assertEqual(run_text(doc(), doc(), *extra)[0], 2)  # an unknown option: the command line is refused

    def test_anything_else_is_material(self):
        for label, live in {
            'a column default': doc(columns=[['nfl_pool_weeks', 'week', 'integer', True, '1', '', '']]),
            'a function body': doc(functions=[['f', '', 'void', 'plpgsql', False, 'v', '', 'nfl_pool_owner', 'cd' * 32]]),
            'another role gaining a privilege': doc(privileges=BASE['privileges'] + [['table', 'nfl_pool_weeks', 'authenticated', 'DELETE', False]]),
            'a policy for another role': doc(policies=BASE['policies'] + [['nfl_pool_weeks', 'x', 'PERMISSIVE', 'ALL', '{authenticated}', 'true', '']]),
            'row-level security switched off': doc(tables=[['nfl_pool_weeks', 'r', 'nfl_pool_owner', False, False]] + BASE['tables'][1:]),
            'a different owner': doc(tables=[['nfl_pool_weeks', 'r', 'neondb_owner', True, False]] + BASE['tables'][1:]),
        }.items():
            with self.subTest(label):
                status, out, _ = run_text(live, doc())
                self.assertEqual(status, 1, out); self.assertIn('MATERIAL:', out)

    def test_a_row_missing_from_the_live_side_is_shown_as_only_in_the_other(self):
        status, out, _ = run_text(doc(privileges=[]), doc())
        self.assertEqual(status, 1); self.assertIn('only in rebuilt', out)

    def test_null_and_an_empty_list_are_the_same_aggregate(self):
        status, out, _ = run_text(doc(triggers=None, indexes=None), doc(triggers=[], indexes=[]))
        self.assertEqual(status, 0, out); self.assertIn('IDENTICAL in content', out)
        self.assertEqual(run_text(doc(triggers=None), doc(triggers=None))[0], 0)  # null is legitimate
        self.assertEqual(run_text(doc(triggers=None), doc())[0], 1)  # but a real difference is still one


class DocumentedBackupRole(unittest.TestCase):
    def check(self, live, expected_status, *fragments, rebuilt=None):
        status, out, err = run_text(live, rebuilt if rebuilt is not None else doc(), '--documented-backup-role')
        self.assertEqual(status, expected_status, out + err)
        for fragment in fragments: self.assertIn(fragment, out + err)
        return out

    def test_the_eleven_documented_rows_and_nothing_else_match(self):
        out = self.check(with_documented(), 0, 'MATCHES')
        self.assertIn('exactly the eleven documented backup-role rows', out)

    def test_the_documented_set_is_the_eleven_it_says(self):
        rows = cc.documented_rows()
        self.assertEqual((len(rows['privileges']), len(rows['policies'])), (6, 5))
        self.assertEqual({tuple(r[:4]) for r in rows['privileges']}, {('table', t, BACKUP, 'SELECT') for t in TABLES} | {('sequence', SEQUENCE, BACKUP, 'SELECT')})
        self.assertTrue(all(r[4] is False for r in rows['privileges']), 'no grant option')
        self.assertTrue(all(r[2:] == ['PERMISSIVE', 'SELECT', '{%s}' % BACKUP, 'true', ''] for r in rows['policies']), 'read-only, for the role alone, USING (true)')

    def test_a_missing_read_grant_or_policy_is_material_whichever_is_missing(self):
        for section, rows in cc.documented_rows().items():
            for row in rows:
                with self.subTest(section=section, row=row[:2]):
                    live = with_documented()
                    live[section] = [r for r in live[section] if r != row]
                    out = self.check(live, 1, 'MATERIAL:', 'documented')
                    self.assertIn('is missing', out)

    def test_every_write_capable_grant_to_the_backup_role_is_material(self):
        for privilege in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'):
            with self.subTest(privilege):
                live = with_documented(privileges=[['table', TABLES[1], BACKUP, privilege, False]])
                self.check(live, 1, 'MATERIAL:', f'a {privilege} privilege for the backup role, which may only read')
        for privilege in ('USAGE', 'UPDATE'):
            with self.subTest('sequence ' + privilege):
                self.check(with_documented(privileges=[['sequence', SEQUENCE, BACKUP, privilege, False]]), 1, f'a {privilege} privilege')

    def test_a_grant_option_is_material(self):
        live = with_documented()
        live['privileges'] = [['table', TABLES[2], BACKUP, 'SELECT', True] if r == ['table', TABLES[2], BACKUP, 'SELECT', False] else r for r in live['privileges']]
        self.check(live, 1, 'a grant option', 'a documented read grant is missing')

    def test_a_read_grant_beyond_the_six_is_material(self):
        for label, row in {'another table': ['table', 'nfl_pool_weeks_extra', BACKUP, 'SELECT', False],
                           'a column': ['column', 'nfl_contests.contest_id', BACKUP, 'SELECT', False],
                           'a function': ['function', 'f()', BACKUP, 'EXECUTE', False],
                           'another sequence': ['sequence', 'other_seq', BACKUP, 'SELECT', False]}.items():
            with self.subTest(label):
                self.check(with_documented(privileges=[row]), 1, 'MATERIAL:')

    def test_another_role_with_the_same_access_is_not_the_backup_role(self):
        self.check(with_documented(privileges=[['table', TABLES[0], 'smokke_backup_ro', 'SELECT', False]]), 1, 'MATERIAL:')
        live = with_documented(); live['privileges'] = [['table', TABLES[0], 'smokke_backup', 'SELECT', False] if r == ['table', TABLES[0], BACKUP, 'SELECT', False] else r for r in live['privileges']]
        self.check(live, 1, 'is missing')

    def test_an_overbroad_or_different_policy_is_material(self):
        def replaced(**changes):
            live = with_documented(); fields = dict(zip(('table', 'name', 'permissive', 'cmd', 'roles', 'qual', 'check'), POLICY)); fields.update(changes)
            live['policies'] = [list(fields.values()) if r == POLICY else r for r in live['policies']]
            return live
        for label, live, reason in [
            ('it also names another role', replaced(roles='{%s,authenticated}' % BACKUP), 'too broad'),
            ('it names no role, which is PUBLIC', replaced(roles='{}'), None),
            ('it is for ALL commands', replaced(cmd='ALL'), 'may only read'),
            ('it is for UPDATE', replaced(cmd='UPDATE'), 'may only read'),
            ('it is for INSERT', replaced(cmd='INSERT'), 'may only read'),
            ('it reads as something other than USING (true)', replaced(qual='(owner = current_user)'), 'USING (true)'),
            ('it has a WITH CHECK', replaced(check='true'), None),
            ('it is restrictive', replaced(permissive='RESTRICTIVE'), None),
            ('it has another name', replaced(name='backup_all'), None)]:
            with self.subTest(label):
                out = self.check(live, 1, 'MATERIAL:', 'a documented policy is missing')
                if reason: self.assertIn(reason, out)

    def test_a_sixth_policy_or_a_policy_twice_is_material(self):
        self.check(with_documented(policies=[['nfl_pool_weeks_extra', cc.BACKUP_POLICY, 'PERMISSIVE', 'SELECT', '{%s}' % BACKUP, 'true', '']]), 1, 'MATERIAL:')
        self.check(with_documented(policies=[POLICY]), 1, 'found more often than documented')

    def test_the_direction_matters(self):
        # The catalog with the role must be the first snapshot. Given the other way round, the second already holds the
        # documented rows: refused as a misuse, never "compared".
        status, out, err = run_text(doc(), with_documented(), '--documented-backup-role')
        self.assertEqual(status, 2); self.assertIn('already holds documented backup-role rows', err)

    def test_a_migrations_only_snapshot_that_already_has_some_of_the_rows_is_refused(self):
        partial = doc(privileges=BASE['privileges'] + [cc.documented_rows()['privileges'][0]])
        self.assertEqual(run_text(with_documented(), partial, '--documented-backup-role')[0], 2)

    def test_any_other_difference_still_fails_beside_the_documented_rows(self):
        def changed(section, rows):
            live = with_documented(); live[section] = rows; return live
        for label, live in {
            'a column default': changed('columns', [['nfl_pool_weeks', 'week', 'integer', True, '1', '', '']]),
            'a missing index': changed('indexes', []),
            'a missing trigger': changed('triggers', []),
            'another role gaining DELETE': changed('privileges', with_documented()['privileges'] + [['table', TABLES[0], 'authenticated', 'DELETE', False]])}.items():
            with self.subTest(label):
                self.check(live, 1, 'MATERIAL:')

    def test_the_documented_rows_alone_are_not_enough_if_the_rest_differs_from_a_snapshot_taken_before(self):
        # Equality is against the adjusted shape of the SECOND snapshot, not a loose count: one extra and one missing row do not cancel.
        live = with_documented(privileges=[['table', TABLES[0], 'authenticated', 'DELETE', False]])
        live['privileges'] = [r for r in live['privileges'] if r != ['table', 'nfl_pool_weeks', 'anonymous', 'SELECT', False]]
        out = self.check(live, 1, 'MATERIAL:')
        self.assertIn('2 material difference(s)', out)

    def test_the_flag_has_no_meaning_for_environments(self):
        self.assertEqual(run_text(doc(), doc(), '--documented-backup-role', '--environment')[0], 2)


class Validation(unittest.TestCase):
    def test_every_section_is_required(self):
        for section in cc.SECTIONS:
            with self.subTest(section):
                broken = doc(); del broken[section]
                status, out, err = run_text(broken, doc())
                self.assertEqual(status, 2); self.assertIn(f'missing section(s): {section}', err); self.assertNotIn('IDENTICAL', out)

    def test_two_identical_but_incomplete_documents_do_not_pass_as_identical(self):
        # The hash shortcut must never be reached by a document that is not a whole snapshot.
        for broken in ({}, {'tables': [], 'columns': []}, {k: v for k, v in BASE.items() if k != 'privileges'}):
            with self.subTest(sorted(broken)):
                status, out, err = run_text(broken, broken)
                self.assertEqual(status, 2); self.assertNotIn('IDENTICAL', out)
                self.assertEqual(run_text(broken, broken, '--documented-backup-role')[0], 2)

    def test_no_unknown_section(self):
        extra = doc(); extra['rows'] = []
        self.assertEqual(run_text(extra, doc())[0], 2)

    def test_the_document_must_be_an_object(self):
        for text in ('[]', '"snapshot"', '7', 'null', 'true'):
            with self.subTest(text): self.assertEqual(run_text(text + '\n', doc())[0], 2)

    def test_a_section_must_be_a_list_or_null(self):
        for value in ({}, 'x', 5, True):
            with self.subTest(value): self.assertEqual(run_text(doc(tables=value), doc())[0], 2)

    def test_null_aggregates_are_legitimate(self):
        # jsonb_agg over no rows is null: a database with no triggers or indexes gives a document with nulls, and is valid.
        sparse = {section: None for section in cc.SECTIONS}
        status, out, _ = run_text(sparse, sparse)
        self.assertEqual(status, 0, out); self.assertIn('IDENTICAL', out)

    def test_a_row_of_the_wrong_length_or_type_is_refused(self):
        bad = {
            'too short': doc(columns=[['t', 'c', 'integer', True, '', '']]),
            'too long': doc(tables=[['t', 'r', 'o', True, False, 'extra']]),
            'a field that is null': doc(policies=[['t', 'p', 'PERMISSIVE', 'SELECT', '{a}', None, '']]),
            'a number for a name': doc(indexes=[['t', 7, 'CREATE INDEX']]),
            'a string for a flag': doc(tables=[['t', 'r', 'o', 'true', False]]),
            'a flag for a string': doc(columns=[['t', 'c', True, True, '', '', '']]),
            'a function hash that is not 64 hex digits': doc(functions=[['f', '', 'void', 'plpgsql', False, 'v', '', 'o', 'xyz']]),
            'a function hash in capitals': doc(functions=[['f', '', 'void', 'plpgsql', False, 'v', '', 'o', 'AB' * 32]]),
            'a policy command that does not exist': doc(policies=[['t', 'p', 'PERMISSIVE', 'MERGE', '{a}', 'true', '']]),
            'a policy that is neither permissive nor restrictive': doc(policies=[['t', 'p', 'MAYBE', 'SELECT', '{a}', 'true', '']]),
            'a policy role list that is not one': doc(policies=[['t', 'p', 'PERMISSIVE', 'SELECT', 'a,b', 'true', '']]),
            'a privilege in lower case': doc(privileges=[['table', 't', 'r', 'select', False]]),
            'a privilege kind that does not exist': doc(privileges=[['view', 't', 'r', 'SELECT', False]]),
            'a grant option that is not a flag': doc(privileges=[['table', 't', 'r', 'SELECT', 0]]),
            'a relation kind of two letters': doc(tables=[['t', 'rr', 'o', True, False]]),
            'a row that is not a list': doc(tables=['nfl_pool_weeks']),
        }
        for label, document in bad.items():
            with self.subTest(label):
                status, out, err = run_text(document, document)
                self.assertEqual(status, 2, out); self.assertIn('not a valid snapshot', err); self.assertNotIn('IDENTICAL', out)

    def test_a_row_is_not_echoed_in_the_message(self):
        secret = 'hunter2-not-a-credential'
        status, out, err = run_text(doc(columns=[['t', secret, 'integer', True, '', '']]), doc())
        self.assertEqual(status, 2); self.assertNotIn(secret, out + err)  # the message names the section and the position, never the row

    def test_files_that_are_not_documents_are_refused(self):
        for label, text in {'empty': '', 'only a line end': '\n', 'blank': '   \n\n', 'not json': 'SELECT 1', 'truncated': '{"columns": [[',
                            'psql noise before it': 'NOTICE: x\n' + json.dumps(BASE), 'two documents': json.dumps(BASE) + '\n' + json.dumps(BASE),
                            'a repeated section': '{"tables": [], "tables": []}'}.items():
            with self.subTest(label):
                status, out, err = run_text(text, doc())
                self.assertEqual(status, 2, out); self.assertIn('not a valid snapshot', err)

    def test_a_missing_file_is_refused(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as stop:
            cc.main(['/nonexistent/a.json', '/nonexistent/b.json'])
        self.assertEqual(stop.exception.code, 2)

    def test_validate_mode(self):
        for document, status in ((doc(), 0), ({}, 2), (doc(tables=[['x']]), 2)):
            with self.subTest(status):
                with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as handle: handle.write(json.dumps(document) + '\n'); path = handle.name
                try:
                    out, err = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        try: got = cc.main(['--validate', path])
                        except SystemExit as stop: got = stop.code
                    self.assertEqual(got, status, err.getvalue())
                    if status == 0: self.assertEqual(out.getvalue().strip(), 'sha256 ' + hashlib.sha256(json.dumps(document).encode()).hexdigest())
                finally: os.unlink(path)

    def test_the_hash_is_that_of_the_text_without_its_line_end(self):
        body = json.dumps(doc())
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as handle: handle.write(body + '\n'); path = handle.name
        try: self.assertEqual(cc.load(path, cc.SECTIONS, cc.CATALOG_SHAPES)[1], hashlib.sha256(body.encode()).hexdigest())
        finally: os.unlink(path)


ENV = {
    'database': [['nfl_pool', 'owner', 'UTF8']], 'settings': [['server_major', '17'], ['timezone', 'GMT']], 'schemas': [['public', 'owner']],
    'extensions': [['plpgsql', '1.0', 'pg_catalog']],
    'roles': [['reader', True, False, False, False, False, True, False, -1], ['owner', True, False, True, True, True, True, True, -1]],
    'memberships': [['reader', 'authenticated', False, True, True, True]],
    'effective_privileges': [['reader', 'table', 'nfl_contests', 'SELECT', True, True, 'direct', False]],
}


def env(**changes):
    d = json.loads(json.dumps(ENV)); d.update(changes); return d


class Environments(unittest.TestCase):
    def test_environments_are_listed_and_never_fail(self):
        a = env(extensions=[['plpgsql', '1.0', 'pg_catalog'], ['pg_session_jwt', '0.3', 'public']])
        status, out, _ = run_text(a, env(), '--environment')
        self.assertEqual(status, 0); self.assertIn('only in live', out); self.assertIn('pg_session_jwt', out)

    def test_a_superuser_or_bypassing_role_is_noted(self):
        status, out, _ = run_text(env(roles=[['bypasser', True, False, False, True, False, True, False, -1]]), env(), '--environment')
        self.assertEqual(status, 0); self.assertIn('NOTE live: role bypasser is a superuser or bypasses row-level security', out)

    def test_membership_of_a_predefined_role_is_noted_with_its_inheritance(self):
        a = env(memberships=[['older_login', 'pg_read_all_data', False, True, True, True], ['other_login', 'pg_write_all_data', False, False, True, False]])
        status, out, _ = run_text(a, env(), '--environment')
        self.assertEqual(status, 0)
        self.assertIn('NOTE live: role older_login is a member of the predefined role pg_read_all_data (inherits its privileges)', out)
        self.assertIn('NOTE live: role other_login is a member of the predefined role pg_write_all_data (does not inherit its privileges)', out)

    def test_what_is_effective_but_not_explicit_is_told_apart_from_a_grant(self):
        rows = [['older_login', 'table', t, 'SELECT', False, True, 'pg_read_all_data', True] for t in ('nfl_contests', 'nfl_pool_weeks')] \
             + [['older_login', 'table', 'nfl_contests', 'INSERT', True, True, 'direct', False],
                ['reader', 'table', 'nfl_contests', 'SELECT', False, True, 'public', False]]
        status, out, _ = run_text(env(effective_privileges=rows), env(), '--environment')
        self.assertEqual(status, 0)
        self.assertIn('role older_login holds 2 effective privilege(s)', out)
        self.assertIn('that no grant gives it explicitly, through pg_read_all_data; row-level security does not apply to it on 2 of them', out)
        self.assertNotIn('through direct', out); self.assertNotIn('through public', out)  # an explicit grant, or PUBLIC's, is not a surprise

    def test_the_two_sides_are_noted_separately(self):
        a = env(memberships=[['left_login', 'pg_read_all_data', False, True, True, True]])
        b = env(memberships=[['right_login', 'pg_read_all_data', False, True, True, True]])
        out = run_text(a, b, '--environment')[1]
        self.assertIn('NOTE live: role left_login', out); self.assertIn('NOTE rebuilt: role right_login', out)

    def test_null_sections_are_legitimate(self):
        empty = {section: None for section in cc.ENVIRONMENT_SECTIONS}
        status, out, _ = run_text(empty, empty, '--environment')
        self.assertEqual(status, 0); self.assertIn('the two environments list the same things', out)

    def test_an_invalid_environment_is_refused_not_listed(self):
        old_format = {k: v for k, v in ENV.items() if k != 'effective_privileges'}  # what environment-snapshot.sql gave before
        short_membership = env(memberships=[['a', 'b']])
        for label, document in {'a section missing': old_format, 'a membership without its inheritance': short_membership,
                                'a flag that is text': env(roles=[['r', 'yes', False, False, False, False, True, False, -1]]),
                                'a kind that does not exist': env(effective_privileges=[['r', 'view', 'x', 'SELECT', True, True, 'direct', False]]),
                                'an empty object': {}}.items():
            with self.subTest(label):
                status, out, err = run_text(document, env(), '--environment')
                self.assertEqual(status, 2, out); self.assertIn('not a valid snapshot', err)


if __name__ == '__main__':
    unittest.main()
