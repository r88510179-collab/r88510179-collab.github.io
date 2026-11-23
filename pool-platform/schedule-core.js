// Presentation-only/manual schedule preparation. A manually entered schedule is NOT verified NFL data.
// The backend independently authorizes the commissioner and validates every field before storage.
export const NFL_TEAMS = Object.freeze([
  ['ARI','Arizona','Cardinals'],['ATL','Atlanta','Falcons'],['BAL','Baltimore','Ravens'],
  ['BUF','Buffalo','Bills'],['CAR','Carolina','Panthers'],['CHI','Chicago','Bears'],
  ['CIN','Cincinnati','Bengals'],['CLE','Cleveland','Browns'],['DAL','Dallas','Cowboys'],
  ['DEN','Denver','Broncos'],['DET','Detroit','Lions'],['GB','Green Bay','Packers'],
  ['HOU','Houston','Texans'],['IND','Indianapolis','Colts'],['JAX','Jacksonville','Jaguars'],
  ['KC','Kansas City','Chiefs'],['LV','Las Vegas','Raiders'],['LAC','Los Angeles','Chargers'],
  ['LAR','Los Angeles','Rams'],['MIA','Miami','Dolphins'],['MIN','Minnesota','Vikings'],
  ['NE','New England','Patriots'],['NO','New Orleans','Saints'],['NYG','New York','Giants'],
  ['NYJ','New York','Jets'],['PHI','Philadelphia','Eagles'],['PIT','Pittsburgh','Steelers'],
  ['SF','San Francisco','49ers'],['SEA','Seattle','Seahawks'],['TB','Tampa Bay','Buccaneers'],
  ['TEN','Tennessee','Titans'],['WAS','Washington','Commanders']
].map(([key,city,name])=>Object.freeze({key,city,name})));
const teams=new Map(NFL_TEAMS.map(t=>[t.key,t]));
const dateLocal=/^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
export function prepareManualSchedule({week,rows=[],tiebreakRequired=false,now=new Date()}){
  if(week?.status!=='draft')return {ok:false,error:'Only a draft week can have its schedule edited.'};
  if(!Array.isArray(rows)||rows.length<1||rows.length>18)return {ok:false,error:'Enter between 1 and 18 games.'};
  const seenTeams=new Set(),seenGames=new Set(),games=[];
  for(let i=0;i<rows.length;i++){
    const row=rows[i],away=teams.get(row?.away),home=teams.get(row?.home);
    if(!away||!home||away.key===home.key)return {ok:false,error:`Game ${i+1}: select two different NFL teams.`};
    if(seenTeams.has(away.key)||seenTeams.has(home.key))return {ok:false,error:`Game ${i+1}: a team can only appear once in the same week.`};
    const local=String(row?.kickoffLocal||'');
    if(!dateLocal.test(local))return {ok:false,error:`Game ${i+1}: enter a valid kickoff date and time.`};
    const kickoff=new Date(local);
    // Browser may normalize nonexistent local times at daylight-saving transitions. Do not silently move kickoffs.
    if(Number.isFinite(kickoff.getTime())&&`${kickoff.getFullYear()}-${String(kickoff.getMonth()+1).padStart(2,'0')}-${String(kickoff.getDate()).padStart(2,'0')}T${String(kickoff.getHours()).padStart(2,'0')}:${String(kickoff.getMinutes()).padStart(2,'0')}`!==local)
      return {ok:false,error:`Game ${i+1}: that kickoff time does not exist in your local timezone.`};
    if(week.deadline_at&&Number.isFinite(Date.parse(week.deadline_at))&&kickoff.getTime()<Date.parse(week.deadline_at))
      return {ok:false,error:`Game ${i+1}: kickoff is before the weekly submission deadline. Move the deadline earlier before saving.`};
    if(!Number.isFinite(kickoff.getTime())||kickoff.getTime()<now.getTime()-86400000||kickoff.getTime()>now.getTime()+18*31*86400000)
      return {ok:false,error:`Game ${i+1}: kickoff is outside the allowed scheduling window.`};
    const date=kickoff.toISOString().slice(0,10).replaceAll('-','');
    const id=`MANUAL-${date}-${away.key}-${home.key}`;
    if(seenGames.has(id))return {ok:false,error:`Game ${i+1}: duplicate game.`};
    seenGames.add(id);seenTeams.add(away.key);seenTeams.add(home.key);
    games.push({id,away:{...away},home:{...home},kickoff:kickoff.toISOString()});
  }
  games.sort((a,b)=>a.kickoff.localeCompare(b.kickoff)||a.id.localeCompare(b.id));
  // Always mark manual schedules as unverified; a separate controlled operation must verify/open the week.
  return {ok:true,config:{games,tiebreakRequired:Boolean(tiebreakRequired),scheduleSource:'commissioner_manual',scheduleVerification:'pending'},warnings:['Manual schedules are not verified against the official NFL schedule. Saving will NOT open picks.']};
}
