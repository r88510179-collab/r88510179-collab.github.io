'use strict';

// Presentation-only calendar range from the already-verified NFL kickoff timestamps.
// Historical publication dates may be UTC calendar dates. Never rewrite them or
// infer a kickoff time from an unverified date; wait for the trusted feed instead.
export function verifiedWeekRange(games) {
  if (!Array.isArray(games) || games.length === 0) return null;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric'
  });
  const dates = [];
  for (const game of games) {
    if (typeof game?.kickoff !== 'string' || !game.kickoff.trim()) return null;
    const kickoff = new Date(game.kickoff);
    if (!Number.isFinite(kickoff.getTime())) return null;
    const parts = Object.fromEntries(formatter.formatToParts(kickoff)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]));
    if (!/^\d{4}$/.test(parts.year) || !/^\d{1,2}$/.test(parts.day)) return null;
    const monthNo = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', month: '2-digit'
    }).format(kickoff);
    const dayNo = parts.day.padStart(2, '0');
    dates.push({ key: parts.year + '-' + monthNo + '-' + dayNo,
      year: parts.year, month: parts.month, day: String(Number(parts.day)) });
  }
  dates.sort((a, b) => a.key.localeCompare(b.key));
  const first = dates[0], last = dates[dates.length - 1];
  const short = date => date.month + ' ' + date.day;
  if (first.key === last.key) return short(first) + ', ' + first.year;
  if (first.year === last.year) return short(first) + '–' + short(last) + ', ' + first.year;
  return short(first) + ', ' + first.year + '–' + short(last) + ', ' + last.year;
}

// Keep the existing status, week, revision, and entrant text verbatim.
// The source app writes those fields, so the independent date display touches
// only the single range between the revision and the first entrant separator.
// While the publication on screen cannot be re-verified, the strip leads with
// PUBLISHED DATA STALE in place of "Week N"; that warning is kept verbatim and
// the same revision still names the publication whose kickoffs are verified.
export function correctedWeekLine(line, snapshot) {
  if (typeof line !== 'string' || snapshot?.ready !== true) return line;
  if (!Number.isInteger(snapshot.week) || !Number.isInteger(snapshot.revision)) return line;
  const revision = ' · revision ' + snapshot.revision + ' · ';
  const marker = ['Week ' + snapshot.week + revision, 'PUBLISHED DATA STALE' + revision]
    .find(lead => line.includes(lead));
  if (!marker) return line;
  const hit = line.indexOf(marker);
  const start = hit + marker.length, end = line.indexOf(' · ', start);
  if (end < 0) return line;
  const range = verifiedWeekRange(snapshot.games) || 'Kickoff dates unverified';
  return line.slice(0, start) + range + line.slice(end);
}

// Reuse the public Pick'em snapshot, which is already the Picks board's verified
// read-only interface. No new fetch, write, timer, auth, or shared mutable state.
export function bootVerifiedWeekDates(doc) {
  if (!doc || typeof doc.addEventListener !== 'function') return;
  const update = () => {
    const line = doc.getElementById('weekLine');
    if (!line || typeof CustomEvent !== 'function') return;
    const detail = { contest: 'pickem', snapshot: null };
    doc.dispatchEvent(new CustomEvent('poolcenter:picks', { detail }));
    const text = correctedWeekLine(line.textContent, detail.snapshot);
    if (text !== line.textContent) line.textContent = text;
  };
  doc.addEventListener('poolcenter:update', event => {
    if (!event?.detail || event.detail.contest === 'pickem') update();
  });
  update();
}

if (typeof document !== 'undefined') bootVerifiedWeekDates(document);
