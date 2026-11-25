#!/usr/bin/env python3
"""Self-test of compare-catalog.py on small made-up snapshots. No database. Run: python3 nfl-pool/sql-tests/test_compare_catalog.py"""
import contextlib, importlib.util, io, json, os, tempfile, unittest

spec = importlib.util.spec_from_file_location('compare_catalog', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compare-catalog.py'))
cc = importlib.util.module_from_spec(spec); spec.loader.exec_module(cc)

BACKUP = 'smokke_personal_cloud_backup_ro'
BASE = {
    'columns': [['nfl_pool_weeks', 'week', 'integer', True, '', '', '']],
    'tables': [['nfl_pool_weeks', 'r', 'nfl_pool_owner', True, False]],
    'constraints': [['nfl_pool_weeks', 'nfl_pool_weeks_pkey', 'p', 'PRIMARY KEY (week)']],
    'indexes': [], 'triggers': [],
    'policies': [['nfl_pool_weeks', 'public_read', 'PERMISSIVE', 'SELECT', '{anonymous}', 'true', '']],
    'functions': [['f', '', 'void', 'plpgsql', False, 'v', '', 'nfl_pool_owner', 'ab' * 32]],
    'privileges': [['table', 'nfl_pool_weeks', 'anonymous', 'SELECT', False]],
}


def doc(**changes):
    d = json.loads(json.dumps(BASE)); d.update(changes); return d


def run(a, b, *extra, environment=False):
    with tempfile.TemporaryDirectory() as folder:
        paths = []
        for name, value in (('a.json', a), ('b.json', b)):
            path = os.path.join(folder, name)
            with open(path, 'w') as handle: handle.write(json.dumps(value) + '\n')
            paths.append(path)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = cc.main([*paths, '--label-a', 'live', '--label-b', 'rebuilt', *(['--environment'] if environment else []), *extra])
        return status, out.getvalue()


class CompareCatalog(unittest.TestCase):
    def test_identical_catalogs_pass_and_say_so(self):
        status, out = run(doc(), doc())
        self.assertEqual(status, 0); self.assertIn('IDENTICAL', out)

    def test_the_backup_roles_grants_and_policies_are_environment_specific(self):
        live = doc(policies=BASE['policies'] + [['nfl_pool_weeks', 'smokke_personal_cloud_backup_read', 'PERMISSIVE', 'SELECT', '{%s}' % BACKUP, 'true', '']],
                   privileges=BASE['privileges'] + [['table', 'nfl_pool_weeks', BACKUP, 'SELECT', False]])
        status, out = run(live, doc())
        self.assertEqual(status, 0, out); self.assertIn('0 material difference(s), 2 expected environment-specific', out)
        self.assertIn('only in live', out)

    def test_anything_else_is_material(self):
        for label, live in {
            'a column default': doc(columns=[['nfl_pool_weeks', 'week', 'integer', True, '1', '', '']]),
            'a function body': doc(functions=[['f', '', 'void', 'plpgsql', False, 'v', '', 'nfl_pool_owner', 'cd' * 32]]),
            'another role gaining a privilege': doc(privileges=BASE['privileges'] + [['table', 'nfl_pool_weeks', 'authenticated', 'DELETE', False]]),
            'a policy for another role': doc(policies=BASE['policies'] + [['nfl_pool_weeks', 'x', 'PERMISSIVE', 'ALL', '{authenticated}', 'true', '']]),
            'a policy for the backup role and another': doc(policies=BASE['policies'] + [['nfl_pool_weeks', 'x', 'PERMISSIVE', 'SELECT', '{%s,authenticated}' % BACKUP, 'true', '']]),
            'row-level security switched off': doc(tables=[['nfl_pool_weeks', 'r', 'nfl_pool_owner', False, False]]),
            'a different owner': doc(tables=[['nfl_pool_weeks', 'r', 'neondb_owner', True, False]]),
        }.items():
            with self.subTest(label):
                status, out = run(live, doc())
                self.assertEqual(status, 1, out); self.assertIn('MATERIAL:', out)

    def test_a_row_missing_from_the_live_side_is_shown_as_only_in_the_other(self):
        status, out = run(doc(privileges=[]), doc())
        self.assertEqual(status, 1); self.assertIn('only in rebuilt', out)

    def test_an_extra_environment_role_can_be_named(self):
        live = doc(privileges=BASE['privileges'] + [['table', 'nfl_pool_weeks', 'a_new_reader', 'SELECT', False]])
        self.assertEqual(run(live, doc())[0], 1)
        self.assertEqual(run(live, doc(), '--env-role', 'a_new_reader')[0], 0)

    def test_a_file_that_is_not_a_snapshot_is_refused(self):
        with self.assertRaises(SystemExit) as stop: run({'something': 1}, doc())
        self.assertEqual(stop.exception.code, 2)

    def test_environments_are_listed_and_never_fail_but_a_bypassing_role_is_noted(self):
        a = {'roles': [['reader', True, False, False, True, False]], 'extensions': [['plpgsql', '1.0', 'pg_catalog']]}
        b = {'roles': [], 'extensions': [['plpgsql', '1.0', 'pg_catalog']]}
        status, out = run(a, b, environment=True)
        self.assertEqual(status, 0); self.assertIn('only in live', out); self.assertIn('NOTE live: role reader', out)

    def test_the_hash_is_that_of_the_text_without_its_line_end(self):
        import hashlib
        text = json.dumps(doc())
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as handle: handle.write(text + '\n'); path = handle.name
        try: self.assertEqual(cc.load(path, cc.SECTIONS)[1], hashlib.sha256(text.encode()).hexdigest())
        finally: os.unlink(path)


if __name__ == '__main__':
    unittest.main()
