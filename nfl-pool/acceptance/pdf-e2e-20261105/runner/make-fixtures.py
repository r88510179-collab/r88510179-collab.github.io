"""QA ONLY (PR #29). Deterministic synthetic PDF fixtures for the isolated Personal PDF import acceptance.

Every entrant name except the four configured tracked-entry labels (which the parsers require) is fictitious, and every
page says SYNTHETIC QA FIXTURE. No real participant document is used. Game slates are the real 2026 NFL schedule
(Pick'em Week 10; Survivor Weeks 1-6) so the publishers' live NFL schedule validation can run.

Usage: python3 -I make-fixtures.py <output-dir>
"""
import hashlib, json, os, random, sys
from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
MARK = 'SYNTHETIC QA FIXTURE ONLY - every entrant is fictitious - not a real pool'

# ------------------------------------------------------------------------------------------------ Pick'em Week 10 (2026)
WEEK10 = [('Commanders', 'Giants'), ('Patriots', 'Lions'), ('Chiefs', 'Falcons'), ('Texans', 'Browns'),
          ('Vikings', 'Packers'), ('Jaguars', 'Titans'), ('Dolphins', 'Colts'), ('Panthers', 'Saints'),
          ('Bills', 'Jets'), ('Seahawks', 'Raiders'), ('Rams', 'Cardinals'), ('49ers', 'Cowboys'),
          ('Steelers', 'Bengals'), ('Chargers', 'Ravens')]
PICK_X = [150 + i * 28 for i in range(14)]
TB_X, W_X, NAME_X = 150 + 14 * 28, 150 + 15 * 28, 40
PITCH = 14

def picks_for(seed):
    rng = random.Random(seed)
    return [2 * i + 1 + rng.randint(0, 1) for i in range(14)], 30 + rng.randint(0, 30)

FIELD_NAMES = ['Avery Lantern', 'Brook Sable', 'Cedar Quill', 'Dune Harrow', 'Ember Vale', 'Fable Stone',
               'Grove Tamsin', 'Harbor Lune', 'Iris Copper', 'Juniper Wren', 'Kestrel Moss', 'Lark Ashby',
               'Meadow Pike', 'Nova Thistle', 'Onyx Fairley', 'Pippin Marsh', 'Quarry Bell', 'Rowan Gale',
               'Sorrel Finch', 'Tarn Wilder', 'Umber Croft', 'Vesper Hale', 'Willow Brant', 'Xylo Reed',
               'Yarrow Penn', 'Zephyr Cole', 'Alder Frost', 'Bramble Kay', 'Cinder Lowe', 'Dahlia Voss',
               'Elm Garrick', 'Fern Oakley', 'Gale Mercer', 'Heath Rourke', 'Ivy Calder', 'Jasper Quint']

def pickem_rows(variant):
    """Rows in table order. Each row: (name, picks or None, tiebreak or None, wins, blank_game_index or None)."""
    tracked = [('D.C.', 101), ('DJS', 102), ('JC', 103), ('Thaddeus', 104)]
    rows = []
    for i, name in enumerate(FIELD_NAMES[:12]):
        p, tb = picks_for(1000 + i); rows.append([name, p, tb, 0, None])
    for name, seed in tracked:
        p, tb = picks_for(seed); rows.append([name, p, tb, 0, None])
    for i, name in enumerate(FIELD_NAMES[12:31]):
        p, tb = picks_for(2000 + i); rows.append([name, p, tb, 0, None])
    # Duplicate display name: two different fictitious entrants share one name (counted as two field entries).
    p, tb = picks_for(3001); rows.insert(20, ['Synthetic Twin', p, tb, 0, None])
    p, tb = picks_for(3002); rows.append(['Synthetic Twin', p, tb, 0, None])
    # A field entrant whose game 7 cell is blank (recovered by column geometry as an explicit no-pick).
    p, tb = picks_for(3003); rows.insert(25, ['Gap Cell Entrant', p, tb, 0, 6])
    for i, name in enumerate(FIELD_NAMES[31:36]):
        p, tb = picks_for(4000 + i); rows.append([name, p, tb, 0, None])
    by = {r[0]: r for r in rows}
    if variant == 'r1':
        by['Thaddeus'][1] = None; by['Thaddeus'][2] = None   # tracked entrant with no weekly submission yet
    if variant == 'missing-picks':
        by['JC'][4] = 9                                      # JC's game 10 cell is blank: a structurally invalid tracked row
    if variant == 'duplicate-tracked':
        p, tb = picks_for(5001); rows.insert(rows.index(by['JC']) + 1, ['DJS', p, tb, 0, None])
    return rows

def draw_pickem_row(c, y, row):
    name, picks, tb, wins, blank = row
    c.drawString(NAME_X, y, name)
    if picks is not None:
        for i, n in enumerate(picks):
            if i != blank:
                c.drawString(PICK_X[i], y, str(n))
        c.drawString(TB_X, y, str(tb))
    c.drawString(W_X, y, str(wins))

def pickem_header(c, y):
    c.setFont('Helvetica-Bold', 9)
    c.drawString(NAME_X, y, 'Entry'); c.drawString(TB_X, y, 'Pts'); c.drawString(W_X, y, 'W')
    c.setFont('Helvetica', 9)

def make_pickem(path, variant):
    games = list(WEEK10)
    if variant == 'invalid-schedule':
        games[12] = ('Bears', 'Bengals')                      # Chicago is on a bye in 2026 Week 10: no such NFL game
    rows = pickem_rows(variant)
    c = canvas.Canvas(path, pagesize=letter, invariant=1)
    c.setTitle('Synthetic QA Pick Sheet - not a real pool'); c.setAuthor('QA fixture generator'); c.setSubject(MARK)
    # Page 1: title, matchup key, header, then table rows down to the physical bottom of the page.
    c.setFont('Helvetica-Bold', 13); c.drawString(NAME_X, 760, 'QA Synthetic Pool - Week 10 Pick Sheet')
    c.setFont('Helvetica', 8); c.drawString(NAME_X, 746, MARK)
    c.setFont('Helvetica', 9)
    y = 728
    for i, (away, home) in enumerate(games):
        c.drawString(NAME_X, y, f'{2 * i + 1}) {away} at {2 * i + 2}) {home}'); y -= 12
    pickem_header(c, 556)
    y, idx = 542, 0
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
    if variant == 'duplicate-page':
        c.setFont('Helvetica', 9); pickem_header(c, 760)
        y = 746
        for row in rows[idx:]:
            draw_pickem_row(c, y, row); y -= PITCH
        c.showPage()
    # Last page: notes only (no participant-shaped rows), except the deliberately unanchored variant.
    c.setFont('Helvetica-Bold', 11); c.drawString(NAME_X, 760, 'Notes')
    c.setFont('Helvetica', 9)
    notes = [MARK, 'Generated for the isolated QA child branch publisher acceptance.',
             'The matchup key and pick numbers follow the real NFL schedule; entrants and picks are invented.']
    for i, line in enumerate(notes):
        c.drawString(NAME_X, 740 - 14 * i, line)
    if variant == 'unanchored':
        p, tb = picks_for(6001); draw_pickem_row(c, 600, ['Stray Late Entry', p, tb, 0, None])
    c.showPage(); c.save()
    return {'pages': len(pages) + (2 if variant == 'duplicate-page' else 1), 'tableRowsPerPage': [len(p) for p in pages],
            'entries': len(rows), 'trackedNoSubmission': variant == 'r1'}

# --------------------------------------------------------------------------------------------- Survivor Week 6 (2026)
# Weeks 1-2 match the already-published synthetic Survivor Week 2 revision 2 on the QA child exactly.
SURVIVOR = {
    'r1': [('D.C.', ['NE', 'MIN', 'SF', 'GB', 'DEN', 'BUF']),        # OUT: NE lost Week 1; later picks still listed
           ('DJS', ['SF', 'GB', 'DET', 'SEA', 'NYG', 'KC']),         # OUT: NYG-WSH 27-27 tie in Week 5
           ('Thaddeus', ['BUF', 'PHI', 'BAL', 'KC', 'DEN', None]),   # alive entering Week 6, no Week 6 pick yet
           ('Lumen Hart', ['KC', 'BUF', 'KC', 'LAR', 'BUF', 'GB'])],  # OUT: repeated KC in Week 3
}
SURVIVOR['r2'] = [(n, p if n != 'Thaddeus' else ['BUF', 'PHI', 'BAL', 'KC', 'DEN', 'PIT']) for n, p in SURVIVOR['r1']]
SURVIVOR['bye-pick'] = [(n, p if n != 'Lumen Hart' else ['KC', 'BUF', 'KC', 'LAR', 'KC', 'GB']) for n, p in SURVIVOR['r2']]
SURVIVOR['unknown-team'] = [(n, p if n != 'DJS' else ['SF', 'GB', 'DET', 'XYZ', 'NYG', 'KC']) for n, p in SURVIVOR['r2']]
SURVIVOR['duplicate-tracked'] = SURVIVOR['r2'][:2] + [('DJS', ['SF', 'GB', 'DET', 'SEA', 'NYG', 'KC'])] + SURVIVOR['r2'][2:]
WEEK_X = [150 + i * 34 for i in range(18)]

def make_survivor(path, variant):
    rows = SURVIVOR[variant]
    c = canvas.Canvas(path, pagesize=landscape(letter), invariant=1)
    c.setTitle('Synthetic QA Survivor Sheet - not a real pool'); c.setAuthor('QA fixture generator'); c.setSubject(MARK)
    c.setFont('Helvetica-Bold', 13); c.drawString(30, 580, 'QA Synthetic Survivor Pool - picks through Week 6')
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
    data = b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' + bytes(random.Random(7).getrandbits(8) for _ in range(2048))
    with open(path, 'wb') as f:
        f.write(data)                      # truncated object graph, no xref, no trailer
    return {'pages': None}

manifest = {}
def record(name, info, purpose):
    path = os.path.join(OUT, name)
    manifest[name] = {'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(), 'bytes': os.path.getsize(path), 'purpose': purpose, **info}

for v, purpose in [('r1', "Pick'em positive: Week 10 revision 1 (Thaddeus has no submission yet)"),
                   ('r2', "Pick'em revision: Week 10 correction (Thaddeus picks added)"),
                   ('missing-picks', "Pick'em negative: tracked JC row missing a pick cell"),
                   ('invalid-schedule', "Pick'em negative: CHI at CIN is not a 2026 Week 10 NFL game"),
                   ('duplicate-tracked', "Pick'em negative: two DJS rows"),
                   ('unanchored', "Pick'em field gate: participant-shaped row outside the proven table"),
                   ('duplicate-page', "Pick'em field gate: repeated table page")]:
    name = f'QA-PDF-E2E-Pickem-2026-W10-{v}.pdf'
    record(name, make_pickem(os.path.join(OUT, name), v), purpose)
for v, purpose in [('r1', 'Survivor positive: Week 6 revision 1 (Thaddeus has no Week 6 pick)'),
                   ('r2', 'Survivor revision: Week 6 correction (Thaddeus Week 6 PIT)'),
                   ('bye-pick', 'Survivor negative: KC picked in Week 5, when KC had a bye'),
                   ('unknown-team', 'Survivor negative: unknown team code XYZ'),
                   ('duplicate-tracked', 'Survivor negative: two DJS rows')]:
    name = f'QA-PDF-E2E-Survivor-2026-W6-{v}.pdf'
    record(name, make_survivor(os.path.join(OUT, name), v), purpose)
make_malformed(os.path.join(OUT, 'QA-PDF-E2E-malformed.pdf'))
record('QA-PDF-E2E-malformed.pdf', {'pages': None}, 'Negative: malformed PDF bytes (both publishers)')
with open(os.path.join(OUT, 'fixtures-manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=1, sort_keys=True)
for name, m in sorted(manifest.items()):
    print(m['sha256'][:16], m['bytes'], name)
