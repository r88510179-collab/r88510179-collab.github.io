"""QA ONLY. Deterministic synthetic PDF fixtures for the final Personal Pool E2E acceptance (2026-11-06).

Adapted from PR #29's generator (branch qa/personal-pdf-import-e2e-20261105). Every entrant name except the configured
tracked-entry labels the parsers require (D.C., DJS, JC, Thaddeus) is fictitious, and every page says SYNTHETIC QA
FIXTURE. No real participant document is used. Game slates are the real 2026 NFL schedule so the publishers' live NFL
schedule validation can run:
  * Pick'em 2026 Week 5: 15 games, all final, including the real NYG 27-27 WSH tie, a 9:30 ET London game and
    Thursday/Sunday-night/Monday kickoffs whose UTC calendar date differs from the Eastern date.
  * Survivor 2026 Week 8: Weeks 1-6 equal the already-published synthetic Survivor Week 6 revision 2 on the QA child,
    plus Weeks 7-8.
PDFs are byte-reproducible (reportlab invariant=1).

Usage: python3 -I make-fixtures.py <output-dir>
"""
import hashlib, json, os, random, sys
from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
MARK = 'SYNTHETIC QA FIXTURE ONLY - every entrant is fictitious - not a real pool'

# --------------------------------------------------------------------------------------------- Pick'em Week 5 (2026)
# Real 2026 Week 5 slate in kickoff order (away, home). Pick numbers: game i (0-based) is 2i+1 (away) / 2i+2 (home).
WEEK5 = [('Buccaneers', 'Cowboys'), ('Eagles', 'Jaguars'), ('Bengals', 'Dolphins'), ('Browns', 'Jets'),
         ('Texans', 'Titans'), ('Colts', 'Steelers'), ('Raiders', 'Patriots'), ('Vikings', 'Saints'),
         ('Giants', 'Commanders'), ('Bears', 'Packers'), ('Broncos', 'Chargers'), ('Lions', 'Cardinals'),
         ('49ers', 'Seahawks'), ('Ravens', 'Falcons'), ('Bills', 'Rams')]
N = len(WEEK5)
# Real final outcomes (ESPN, read 2026-11-06): winning pick number per game; game 9 (index 8) NYG 27-27 WSH is a tie.
WIN = [1, 4, 5, 8, 9, 12, 14, 15, None, 20, 21, 23, 25, 27, 29]
PICK_X = [140 + i * 26 for i in range(N)]
TB_X, W_X, NAME_X = 140 + N * 26, 140 + N * 26 + 28, 40
PITCH = 14


def winners_except(changes, tie_pick):
    """All real winners, with {game_index: pick_number} overrides; the tie game gets tie_pick."""
    picks = [w if w is not None else tie_pick for w in WIN]
    for i, n in changes.items():
        picks[i] = n
    return picks


def random_picks(seed):
    rng = random.Random(seed)
    return [2 * i + 1 + rng.randint(0, 1) for i in range(N)], 30 + rng.randint(0, 40)


FIELD_NAMES = ['Avery Lantern', 'Brook Sable', 'Cedar Quill', 'Dune Harrow', 'Ember Vale', 'Fable Stone',
               'Grove Tamsin', 'Harbor Lune', 'Iris Copper', 'Juniper Wren', 'Kestrel Moss', 'Lark Ashby',
               'Meadow Pike', 'Nova Thistle', 'Onyx Fairley', 'Pippin Marsh', 'Quarry Bell', 'Rowan Gale',
               'Sorrel Finch', 'Tarn Wilder', 'Umber Croft', 'Vesper Hale', 'Willow Brant', 'Xylo Reed',
               'Yarrow Penn', 'Zephyr Cole', 'Alder Frost', 'Bramble Kay', 'Cinder Lowe', 'Dahlia Voss']


def tracked_rows(variant):
    rows = {
        # name: (picks, tiebreak)   expected r1: D.C. 13-2 (TB 70, d1) · DJS 13-2 (TB 75, d4) · JC 11-4 · Thaddeus 12-3
        'D.C.': (winners_except({2: 6}, 17), 70),
        'DJS': (winners_except({11: 24}, 18), 75),
        'JC': (winners_except({1: 3, 6: 13, 12: 26}, 17), 80),
        'Thaddeus': (winners_except({0: 2, 14: 30}, 18), 68),
    }
    if variant == 'r2':
        # Revision 2 corrections: JC's game 2 pick 3 -> 4 (now 12-3) and DJS's tiebreak 75 -> 71 (exact).
        p, tb = rows['JC']; p = list(p); p[1] = 4; rows['JC'] = (p, tb)
        rows['DJS'] = (rows['DJS'][0], 71)
    return rows


def field_rows():
    """Anonymous field (36 rows). Deterministic, with planned standings anchors around the tracked entries."""
    rows = [
        ['Avery Lantern', winners_except({}, 17), 60, None],          # 14-1, d11
        ['Brook Sable', winners_except({}, 18), 90, None],            # 14-1, d19
        ['Cedar Quill', winners_except({3: 7}, 17), 73, None],        # 13-2, d2
        ['Dune Harrow', winners_except({9: 19}, 18), 67, None],       # 13-2, d4 (ties DJS r1 exactly)
        ['Ember Vale', winners_except({13: 28}, 17), 81, None],       # 13-2, d10
        ['Fable Stone', winners_except({4: 10, 5: 11}, 18), 72, None],  # 12-3, d1
    ]
    for i, name in enumerate(FIELD_NAMES[6:30]):
        p, tb = random_picks(5000 + i)
        rows.append([name, p, tb, None])
    # Duplicate display name: two different fictitious entrants share one name (counted as two field entries).
    p, tb = random_picks(6001); rows.insert(12, ['Synthetic Twin', p, tb, None])
    p, tb = random_picks(6002); rows.append(['Synthetic Twin', p, tb, None])
    # A field entrant whose game 7 cell is blank (recovered by column geometry as an explicit no-pick).
    p, tb = random_picks(6003); rows.insert(20, ['Gap Cell Entrant', p, tb, 6])
    p, tb = random_picks(6004); rows.append(['Zinnia Hollow', p, tb, None])
    return rows


def pickem_rows(variant):
    """Rows in table order: [name, picks or None, tiebreak or None, blank_game_index or None]."""
    tracked = tracked_rows(variant)
    field = field_rows()
    rows = field[:10] + [[n, p, tb, None] for n, (p, tb) in tracked.items()] + field[10:]
    by = {r[0]: r for r in rows}
    if variant == 'missing-picks':
        by['JC'][3] = 9                                   # JC's game 10 cell is blank: a structurally invalid tracked row
    if variant == 'duplicate-tracked':
        p, tb = random_picks(7001); rows.insert(rows.index(by['JC']) + 1, ['DJS', p, tb, None])
    return rows


def draw_pickem_row(c, y, row):
    name, picks, tb, blank = row
    c.drawString(NAME_X, y, name)
    if picks is not None:
        for i, n in enumerate(picks):
            if i != blank:
                c.drawString(PICK_X[i], y, str(n))
        c.drawString(TB_X, y, str(tb))
    c.drawString(W_X, y, '0')


def pickem_header(c, y):
    c.setFont('Helvetica-Bold', 9)
    c.drawString(NAME_X, y, 'Entry'); c.drawString(TB_X, y, 'Pts'); c.drawString(W_X, y, 'W')
    c.setFont('Helvetica', 9)


def make_pickem(path, variant):
    games = list(WEEK5)
    if variant == 'invalid-schedule':
        games[13] = ('Ravens', 'Chiefs')       # KC has a bye in 2026 Week 5; BAL is listed (at ATL): no such NFL game
    if variant == 'duplicate-team':
        games[13] = ('Ravens', 'Packers')      # GB already plays game 10 (Bears at Packers): a team in two matchups
    rows = pickem_rows(variant)
    c = canvas.Canvas(path, pagesize=letter, invariant=1)
    c.setTitle('Synthetic QA Pick Sheet - not a real pool'); c.setAuthor('QA fixture generator'); c.setSubject(MARK)
    # Page 1: title, matchup key, header, then table rows down to the physical bottom of the page.
    c.setFont('Helvetica-Bold', 13); c.drawString(NAME_X, 760, 'QA Synthetic Pool - Week 5 Pick Sheet')
    c.setFont('Helvetica', 8); c.drawString(NAME_X, 746, MARK)
    c.setFont('Helvetica', 9)
    y = 728
    for i, (away, home) in enumerate(games):
        c.drawString(NAME_X, y, f'{2 * i + 1}) {away} at {2 * i + 2}) {home}'); y -= 12
    pickem_header(c, 530)
    y, idx = 516, 0
    while y >= 48 and idx < len(rows):   # the last page-1 row must sit in the physical-bottom band (<= 60pt) to continue
        draw_pickem_row(c, y, rows[idx]); y -= PITCH; idx += 1
    pages = [rows[:idx]]
    c.showPage()
    # Page 2: the table continues under a repeated header at the top of the page.
    c.setFont('Helvetica', 9); pickem_header(c, 760)
    y = 746
    for row in rows[idx:]:
        draw_pickem_row(c, y, row); y -= PITCH
    pages.append(rows[idx:])
    c.showPage()
    # Last page: notes only (no participant-shaped rows).
    c.setFont('Helvetica-Bold', 11); c.drawString(NAME_X, 760, 'Notes')
    c.setFont('Helvetica', 9)
    notes = [MARK, 'Generated for the isolated QA child branch final E2E acceptance (2026-11-06).',
             'The matchup key and pick numbers follow the real NFL schedule; entrants and picks are invented.']
    for i, line in enumerate(notes):
        c.drawString(NAME_X, 740 - 14 * i, line)
    c.showPage(); c.save()
    return {'pages': len(pages) + 1, 'tableRowsPerPage': [len(p) for p in pages], 'entries': len(rows)}


# --------------------------------------------------------------------------------------------- Survivor Week 8 (2026)
# Weeks 1-6 equal the already-published synthetic Survivor Week 6 revision 2 on the QA child exactly.
W6 = [('D.C.', ['NE', 'MIN', 'SF', 'GB', 'DEN', 'BUF']),          # OUT: NE lost Week 1
      ('DJS', ['SF', 'GB', 'DET', 'SEA', 'NYG', 'KC']),           # OUT: NYG-WSH 27-27 tie in Week 5
      ('Thaddeus', ['BUF', 'PHI', 'BAL', 'KC', 'DEN', 'PIT']),    # alive after Week 6 (PIT won at TB)
      ('Lumen Hart', ['KC', 'BUF', 'KC', 'LAR', 'BUF', 'GB'])]    # OUT: repeated KC in Week 3


def survivor_rows(w7_w8):
    return [(n, p + (w7_w8.get(n) or [None, None])) for n, p in W6]


SURVIVOR = {
    # r1: Thaddeus loses Week 7 with SF (SF 20 at ATL 29) yet the sheet still lists a Week 8 pick (GB).
    'r1': survivor_rows({'Thaddeus': ['SF', 'GB']}),
    # r2 correction: Thaddeus wins Week 7 with TB (43-13 at CAR), then loses Week 8 with SEA (CHI 34 at SEA 17).
    'r2': survivor_rows({'Thaddeus': ['TB', 'SEA']}),
}
SURVIVOR['bye-pick'] = survivor_rows({'Thaddeus': ['TB', 'SF']})          # SF has a bye in 2026 Week 8
SURVIVOR['unknown-team'] = [(n, p if n != 'DJS' else ['SF', 'GB', 'DET', 'XYZ', 'NYG', 'KC', None, None])
                            for n, p in SURVIVOR['r2']]
SURVIVOR['duplicate-tracked'] = SURVIVOR['r2'][:2] + [('DJS', ['SF', 'GB', 'DET', 'SEA', 'NYG', 'KC', None, None])] + SURVIVOR['r2'][2:]
WEEK_X = [150 + i * 34 for i in range(18)]


def make_survivor(path, variant):
    rows = SURVIVOR[variant]
    c = canvas.Canvas(path, pagesize=landscape(letter), invariant=1)
    c.setTitle('Synthetic QA Survivor Sheet - not a real pool'); c.setAuthor('QA fixture generator'); c.setSubject(MARK)
    c.setFont('Helvetica-Bold', 13); c.drawString(30, 580, 'QA Synthetic Survivor Pool - picks through Week 8')
    c.setFont('Helvetica', 8); c.drawString(30, 566, MARK)
    c.setFont('Helvetica-Bold', 9); c.drawString(110, 540, 'Week')
    for i, x in enumerate(WEEK_X):
        c.drawString(x, 540, str(i + 1))
    c.setFont('Helvetica', 9)
    split = 2 if variant != 'duplicate-tracked' else 3

    def draw(y, name, picks):
        c.drawString(30, y, name)
        for i, team in enumerate(picks):
            if team:
                c.drawString(WEEK_X[i] - 6, y - 1.8, team)
    y = 516
    for name, picks in rows[:split]:
        draw(y, name, picks); y -= 20
    c.showPage()
    c.setFont('Helvetica', 9); y = 560          # the participant table continues on page 2 (no repeated header)
    for name, picks in rows[split:]:
        draw(y, name, picks); y -= 20
    c.showPage(); c.save()
    return {'pages': 2, 'rowsPerPage': [split, len(rows) - split], 'entries': len(rows)}


def make_malformed(path):
    data = b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' + bytes(random.Random(11).getrandbits(8) for _ in range(2048))
    with open(path, 'wb') as f:
        f.write(data)                      # truncated object graph, no xref, no trailer
    return {'pages': None}


manifest = {}


def record(name, info, purpose):
    path = os.path.join(OUT, name)
    manifest[name] = {'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(), 'bytes': os.path.getsize(path), 'purpose': purpose, **info}


for v, purpose in [('r1', "Pick'em positive: 2026 Week 5 revision 1 (4 tracked + 34 field = 38 entries)"),
                   ('r2', "Pick'em revision: Week 5 correction (JC game 2 pick 3->4; DJS tiebreak 75->71)"),
                   ('missing-picks', "Pick'em negative: tracked JC row missing its game 10 pick cell"),
                   ('duplicate-team', "Pick'em negative: GB in two matchups (game 10 and game 14) - validation added after PR #29"),
                   ('invalid-schedule', "Pick'em negative: BAL at KC is not a 2026 Week 5 NFL game"),
                   ('duplicate-tracked', "Pick'em negative: two DJS rows")]:
    name = f'QA-FINAL-E2E-Pickem-2026-W5-{v}.pdf'
    record(name, make_pickem(os.path.join(OUT, name), v), purpose)
for v, purpose in [('r1', 'Survivor positive: 2026 Week 8 revision 1 (Thaddeus OUT Week 7 with SF; stray Week 8 pick GB)'),
                   ('r2', 'Survivor revision: Week 8 correction (Thaddeus Week 7 TB win, Week 8 SEA loss)'),
                   ('bye-pick', 'Survivor negative: SF picked in Week 8, when SF had a bye'),
                   ('unknown-team', 'Survivor negative: unknown team code XYZ'),
                   ('duplicate-tracked', 'Survivor negative: two DJS rows')]:
    name = f'QA-FINAL-E2E-Survivor-2026-W8-{v}.pdf'
    record(name, make_survivor(os.path.join(OUT, name), v), purpose)
make_malformed(os.path.join(OUT, 'QA-FINAL-E2E-malformed.pdf'))
record('QA-FINAL-E2E-malformed.pdf', {'pages': None}, 'Negative: malformed PDF bytes (both publishers)')
with open(os.path.join(OUT, 'fixtures-manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=1, sort_keys=True)
for name, m in sorted(manifest.items()):
    print(m['sha256'][:16], m['bytes'], name)
