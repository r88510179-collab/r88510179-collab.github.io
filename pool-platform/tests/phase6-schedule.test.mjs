import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {NFL_TEAMS,prepareManualSchedule} from '../schedule-core.js';
import {authErrorMessage} from '../auth-core.js';
const now=new Date('2026-11-03T17:00:00Z');
const draft={id:'synthetic-week-11',status:'draft',week:11};
const rows=[{away:'MIA',home:'DEN',kickoffLocal:'2026-11-12T19:00'}];
const build=(changes={})=>prepareManualSchedule({week:draft,rows,now,...changes});
test('NFL team catalog includes unique 32 canonical NFL team keys',()=>{
 assert.equal(NFL_TEAMS.length,32);assert.equal(new Set(NFL_TEAMS.map(t=>t.key)).size,32);
});
test('manual NFL schedule is saved only as PENDING, never verified/open',()=>{
 const x=build();assert.equal(x.ok,true);assert.equal(x.config.scheduleVerification,'pending');
 assert.equal(x.config.scheduleSource,'commissioner_manual');assert.equal(x.config.games.length,1);
 assert.equal(x.config.games[0].away.name,'Dolphins');assert.equal(x.config.games[0].home.name,'Broncos');
 assert.match(x.config.games[0].id,/^MANUAL-\d{8}-MIA-DEN$/);assert.equal(x.config.status,undefined);
});
test('open, locked and final weeks reject editing',()=>{
 for(const status of ['open','locked','final'])assert.equal(build({week:{...draft,status}}).ok,false);
});
test('rejects a kickoff earlier than the submission deadline',()=>{
 const x=build({week:{...draft,deadline_at:new Date(new Date(rows[0].kickoffLocal).getTime()+60_000).toISOString()}});
 assert.equal(x.ok,false);assert.match(x.error,/deadline/);
});
test('same team cannot play twice in the selected week',()=>{
 const x=build({rows:[...rows,{away:'MIA',home:'BUF',kickoffLocal:'2026-11-13T19:00'}]});
 assert.equal(x.ok,false);assert.match(x.error,/once/);
});
test('requires both teams and a valid kickoff',()=>{
 assert.equal(build({rows:[{...rows[0],home:'MIA'}]}).ok,false);
 assert.equal(build({rows:[{...rows[0],home:''}]}).ok,false);
 assert.equal(build({rows:[{...rows[0],kickoffLocal:'xyz'}]}).ok,false);
 assert.equal(build({rows:[{...rows[0],kickoffLocal:'2025-10-01T11:00'}]}).ok,false);
});
test('rejects empty weeks or oversized game lists',()=>{
 assert.equal(build({rows:[]}).ok,false);
 assert.equal(build({rows:Array.from({length:19},()=>rows[0])}).ok,false);
});
test('tiebreak flag remains explicit and cannot validate schedule provenance',()=>{
 const x=build({tiebreakRequired:true});assert.equal(x.config.tiebreakRequired,true);
 assert.match(x.warnings.join(' '),/NOT open/i);
});
test('backend RPC SQL is tenant-scoped, draft-only, with no entries or audit mutations',()=>{
 const sql=fs.readFileSync(path.resolve(import.meta.dirname,'../migrations/20261103_commissioner_draft_schedule.sql'),'utf8');
 assert.match(sql,/SECURITY DEFINER/);assert.match(sql,/SET search_path TO 'public', 'neon_auth', 'pg_temp'/);
 assert.match(sql,/REVOKE ALL ON FUNCTION .* FROM PUBLIC/);assert.match(sql,/TO authenticated/);
 assert.ok(sql.indexOf("IF v_uid IS NULL THEN RAISE EXCEPTION 'auth_required'")<sql.indexOf('FROM public.pool_platform_weeks'));
 assert.ok(sql.indexOf('pool_platform_is_tenant_commissioner')<sql.indexOf('UPDATE public.pool_platform_weeks'));
 assert.match(sql,/v_status <> 'draft'/);assert.match(sql,/week_has_submissions/);
 assert.doesNotMatch(sql,/\b(UPDATE|DELETE|INSERT|TRUNCATE)\s+public\.pool_platform_(submissions|submission_audit|entries)/i);
});
test('browser RPC and controls present',()=>{
 const base=path.resolve(import.meta.dirname,'..');
 const js=fs.readFileSync(path.join(base,'commissioner.js'),'utf8');
 const client=fs.readFileSync(path.join(base,'platform-client.js'),'utf8');
 const html=fs.readFileSync(path.join(base,'commissioner.html'),'utf8');
 for(const id of ['scheduleSetup','scheduleGames','previewSchedule','scheduleReview','confirmSchedule','scheduleError','scheduleResult','scheduleTiebreak'])assert.match(html,new RegExp(`id="${id}"`));
 assert.match(js,/prepareManualSchedule/);assert.match(js,/client\.saveDraftSchedule/);
 assert.match(client,/pool_platform_save_draft_schedule/);
});
test('draft schedule errors translated for commissioners',()=>{
 assert.match(authErrorMessage('invalid_draft_schedule'),/games/);
 assert.match(authErrorMessage('week_not_draft'),/draft/);
});
