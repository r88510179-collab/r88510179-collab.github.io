export const SURVIVOR_TARGETS=[
  {id:'dc',displayName:'D.C.',aliases:['D.C.','D.C','DC']},
  {id:'djs',displayName:'DJS',aliases:['DJS']},
  {id:'thaddeus',displayName:'Thaddeus',aliases:['Thaddius','Thaddeus']}
];

export const SURVIVOR_NFL_TEAMS=new Set(['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS']);
const NFL_TEAMS=SURVIVOR_NFL_TEAMS;
const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
const exact=s=>clean(s).toLowerCase();
const median=a=>{const b=a.slice().sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2};

export function normalizeSurvivorTeam(value){
  const raw=clean(value).toUpperCase().replace(/[.]/g,'').replace(/\s+/g,'');
  const aliases={JAC:'JAX',WSH:'WAS',LAC:'LAC',LAR:'LAR'};
  const code=aliases[raw]||raw;
  return NFL_TEAMS.has(code)?code:null;
}

export function groupSurvivorPdfTextItems(items){
  const rows=[];
  for(const item of items||[]){
    const text=clean(item?.str);if(!text)continue;
    const tr=item?.transform||[],x=Number(tr[4]??0),y=Number(tr[5]??0);
    let row=rows.find(r=>Math.abs(r.y-y)<=2.2);
    if(!row){row={y,parts:[]};rows.push(row)}
    row.parts.push({x,text});
  }
  return rows.sort((a,b)=>b.y-a.y).map((row,rowIndex)=>{
    const parts=row.parts.sort((a,b)=>a.x-b.x);
    return{text:clean(parts.map(p=>p.text).join(' ')),y:row.y,rowIndex,parts:parts.map(p=>({x:p.x,text:p.text}))};
  }).filter(r=>r.text);
}

function headerContract(rows){
  const candidates=(rows||[]).filter(row=>{
    const tokens=(row.parts||[]).flatMap(p=>clean(p.text).split(' ').filter(Boolean).map(token=>({token,x:Number(p.x)})));
    const nums=tokens.filter(t=>/^\d{1,2}$/.test(t.token)).map(t=>Number(t.token));
    return /\bweek\b/i.test(row.text)&&nums.includes(1)&&nums.length>=2;
  });
  if(candidates.length!==1)return null;
  const row=candidates[0],tokens=(row.parts||[]).flatMap(p=>clean(p.text).split(' ').filter(Boolean).map(token=>({token,x:Number(p.x)})));
  const numeric=tokens.filter(t=>/^\d{1,2}$/.test(t.token)).map(t=>({week:Number(t.token),x:t.x})).filter(t=>t.week>=1&&t.week<=22).sort((a,b)=>a.week-b.week);
  if(numeric.length<2||numeric[0].week!==1)return null;
  for(let i=1;i<numeric.length;i++)if(numeric[i].week!==numeric[i-1].week+1)return null;
  const gaps=[];for(let i=1;i<numeric.length;i++)gaps.push(numeric[i].x-numeric[i-1].x);
  const gap=median(gaps);if(!Number.isFinite(gap)||gap<12||gap>80)return null;
  return{headerKey:sourceRowKey(row),headerPage:row.pageNumber??0,headerY:Number(row.y),weekXs:numeric.map(n=>n.x),sheetWeeks:numeric.length,gap,nameCutoff:numeric[0].x-gap*0.44};
}

function sourceRowKey(row){return 'pdf:'+(row.pageNumber??'?')+':'+Number(row.y??0).toFixed(2)+':'+clean(row.text)}

function targetForName(name){
  const n=exact(name);
  return SURVIVOR_TARGETS.find(t=>t.aliases.some(a=>exact(a)===n))||null;
}

const MEANINGFUL=/[A-Za-z0-9]/;
const TEAM_CODE_SHAPE=/^(?:[A-Z]{2,3}|LA [CR])$/;
const NAME_X_TOLERANCE=3;

function nearestColumns(x,columnXs){
  const ds=columnXs.map((cx,i)=>({i,d:Math.abs(x-cx)})).sort((a,b)=>a.d-b.d||a.i-b.i);
  return{best:ds[0]||null,second:ds[1]||null};
}

// Text split into several PDF items inside one cell (e.g. "LA" + "C") is merged first; a cell is placed by its start x.
// Continuation is measured from the cell's first item, so a split cell can never chain into the next column's text.
// A fragment that turns an incomplete lettered code into a team code (LA + C) completes its cell even in tight layouts;
// a complete team code never continues another cell.
function pickCells(pickParts,gap){
  const cells=[];
  for(const part of pickParts){
    const prev=cells[cells.length-1],distance=prev?part.x-prev.x:Infinity;
    const completesCode=!!prev&&distance<=gap*0.9&&MEANINGFUL.test(prev.texts.join(' '))&&!normalizeSurvivorTeam(prev.texts.join(' '))&&!normalizeSurvivorTeam(part.text)&&!!normalizeSurvivorTeam([...prev.texts,part.text].join(' '));
    if(prev&&(distance<=gap*0.7||completesCode)){prev.texts.push(part.text);continue}
    cells.push({x:part.x,texts:[part.text]});
  }
  return cells.map(c=>{const text=clean(c.texts.join(' '));return{x:c.x,text,meaningful:MEANINGFUL.test(text)}});
}

function analyzeRow(row,contract){
  const parts=(row.parts||[]).map(p=>({x:Number(p.x),text:clean(p.text)})).filter(p=>Number.isFinite(p.x)&&p.text).sort((a,b)=>a.x-b.x);
  const nameParts=parts.filter(p=>p.x<contract.nameCutoff),cells=pickCells(parts.filter(p=>p.x>=contract.nameCutoff),contract.gap);
  const sourceName=clean(nameParts.map(p=>p.text).join(' ')),meaningful=cells.some(c=>c.meaningful);
  const kind=sourceName?(meaningful?'picks':'name-only'):(meaningful?'nameless':'noise');
  return{row,nameParts,cells,sourceName,nameX:nameParts[0]?.x??null,kind};
}

// Observed Week-column positions: the header anchors shifted by the median offset of pick cells from their header.
function columnModel(region,contract){
  const offsets=[];
  for(const a of region){
    if(a.kind!=='picks')continue;
    for(const cell of a.cells){
      if(!cell.meaningful)continue;
      const {best}=nearestColumns(cell.x,contract.weekXs);
      if(best&&best.d<=contract.gap*0.62)offsets.push(cell.x-contract.weekXs[best.i]);
    }
  }
  const offset=offsets.length?median(offsets):0;
  // Text may start well left of its header (left-aligned codes under centered numbers) but not past the name cutoff.
  return{offset,columnXs:contract.weekXs.map(x=>x+offset),valid:offset<0?-offset<contract.gap*0.44:offset<=contract.gap*0.375};
}

// A cell belongs to a Week column only when it is within tolerance and clearly nearer that column than any other.
function assignCell(x,model,gap){
  const {best,second}=nearestColumns(x,model.columnXs);
  if(!best||best.d>gap*0.62)return{column:-1,problem:'outside'};
  if(second&&second.d-best.d<gap*0.25)return{column:-1,problem:'between',columns:[Math.min(best.i,second.i)+1,Math.max(best.i,second.i)+1]};
  return{column:best.i};
}

function participantPicks(a,contract,model){
  const bins=Array.from({length:contract.sheetWeeks},()=>[]),issues=[],label=a.sourceName;
  for(const part of a.nameParts){
    if(part.x>=contract.nameCutoff-contract.gap*0.5&&TEAM_CODE_SHAPE.test(part.text)&&normalizeSurvivorTeam(part.text))issues.push(label+': text '+part.text+' sits between the name column and the Week 1 column');
  }
  for(const cell of a.cells){
    const hit=assignCell(cell.x,model,contract.gap);
    if(hit.column>=0){bins[hit.column].push(cell.text);continue}
    if(!cell.meaningful)continue;
    if(hit.problem==='between')issues.push(label+': text '+cell.text+' is between the Week '+hit.columns[0]+' and Week '+hit.columns[1]+' columns');
    else issues.push(label+': text '+cell.text+' is outside every Week column');
  }
  const picks=[];
  bins.map(xs=>clean(xs.join(' '))||null).forEach((raw,i)=>{
    if(!raw){picks.push(null);return}
    const team=normalizeSurvivorTeam(raw);
    if(!team){issues.push(label+': unknown Week '+(i+1)+' team '+raw);picks.push(null)}
    else picks.push(team);
  });
  return{sourceName:label,picks,issues,row:a.row};
}

// Participant-table contract: rows below the single Week header (and on later pages). Rows with Week-column text are
// participants; a row without picks is an entrant only when it sits on the table's row grid, chained to participant
// rows on its page, with its name inside the participant name column.
function participantRegion(rows,contract,review,errors){
  const ignore=(row,reason)=>review.ignoredRows.push({page:row.pageNumber??null,text:clean(row.text),reason});
  const region=[];
  for(const row of rows){
    if(sourceRowKey(row)===contract.headerKey)continue;
    const page=row.pageNumber??0,headerPage=contract.headerPage??0;
    if(page<headerPage||(page===headerPage&&Number(row.y)>contract.headerY)){ignore(row,'above the Week header');continue}
    const a=analyzeRow(row,contract);
    if(a.kind==='noise')continue;
    if(/^suicide pool$/i.test(a.sourceName)||/^week$/i.test(a.sourceName)){ignore(row,'sheet title or label');continue}
    if(a.kind==='name-only'&&!/[A-Za-z]/.test(a.sourceName)){ignore(row,'row without a participant name');continue}
    region.push(a);
  }
  const model=columnModel(region,contract);
  if(!model.valid)errors.push('Survivor Week column positions could not be proven (pick text starts '+model.offset.toFixed(1)+'pt from its Week header)');
  for(const a of region){
    if(a.kind!=='nameless')continue;
    const suspect=a.cells.filter(c=>c.meaningful&&TEAM_CODE_SHAPE.test(c.text)&&normalizeSurvivorTeam(c.text)&&assignCell(c.x,model,contract.gap).problem!=='outside');
    if(suspect.length)errors.push('Page '+(a.row.pageNumber??'?')+': Week-column team text '+suspect.map(c=>c.text).join(' ')+' has no participant name');
    else ignore(a.row,'text in the Week columns without a participant name');
  }
  const named=region.filter(a=>a.kind==='picks'||a.kind==='name-only'),byPage=new Map();
  for(const a of named){const p=a.row.pageNumber??0;if(!byPage.has(p))byPage.set(p,[]);byPage.get(p).push(a)}
  for(const list of byPage.values())list.sort((x,y)=>Number(y.row.y)-Number(x.row.y));
  const gaps=[];
  for(const list of byPage.values())for(let i=1;i<list.length;i++){
    if(list[i-1].kind!=='picks'||list[i].kind!=='picks')continue;
    const g=Number(list[i-1].row.y)-Number(list[i].row.y);if(Number.isFinite(g)&&g>0)gaps.push(g);
  }
  const pitch=gaps.length?median(gaps):null;
  const minGap=pitch===null?null:pitch-Math.max(2.5,pitch*0.25);
  const onGrid=(upper,lower)=>{const g=Number(upper.row.y)-Number(lower.row.y);return pitch!==null&&Number.isFinite(g)&&g>=minGap&&g<=pitch*1.75};
  const tooClose=(upper,lower)=>minGap!==null&&Number(upper.row.y)-Number(lower.row.y)<minGap;
  // Distance from the row grid, measured from the nearest row with picks on the page.
  const gridDeviation=(list,idx)=>{for(let d=1;d<list.length;d++)for(const k of [idx-d,idx+d]){const r=list[k];if(r&&r.kind==='picks'){const m=Math.abs(Number(r.row.y)-Number(list[idx].row.y))%pitch;return Math.min(m,pitch-m)}}return Infinity};
  const nameXs=named.filter(a=>a.kind==='picks'&&Number.isFinite(a.nameX)).map(a=>a.nameX);
  const nameMin=nameXs.length?Math.min(...nameXs)-NAME_X_TOLERANCE:null,nameMax=nameXs.length?Math.max(...nameXs)+NAME_X_TOLERANCE:null;
  const accepted=new Set();
  const inNameColumn=a=>nameMin!==null&&a.nameX>=nameMin&&a.nameX<=nameMax;
  for(const list of byPage.values()){
    const pageHasPicks=list.some(a=>a.kind==='picks');
    if(!pageHasPicks){
      // A page holding only rows without picks (e.g. blank entrants sorted last) cannot be anchored by picks. It is
      // counted only as one unbroken grid chain inside the name column, and needs explicit admin confirmation.
      if(pitch===null){for(const a of list)errors.push(a.sourceName+': row has no picks and the Survivor row spacing could not be proven');continue}
      const chained=list.every((a,i)=>i===0||onGrid(list[i-1],a)),aligned=list.every(inNameColumn);
      if(!chained||!aligned){for(const a of list)errors.push(a.sourceName+': row has no picks on a page without participant picks and '+(aligned?'is not on the participant row grid':'is outside the participant name column')+'; table membership cannot be proven');continue}
      for(const a of list){accepted.add(a);const entry={page:a.row.pageNumber??null,label:a.sourceName};review.blankEntrants.push(entry);review.unanchoredRows.push(entry)}
      continue;
    }
    list.forEach((a,idx)=>{
      if(a.kind==='picks'){accepted.add(a);return}
      // Walk the row grid toward a row with picks; stray off-grid rows without picks are stepped over, not trusted.
      const reaches=dir=>{let j=idx;for(let k=idx+dir;k>=0&&k<list.length;k+=dir){if(!onGrid(dir<0?list[k]:list[j],dir<0?list[j]:list[k])){if(list[k].kind==='picks')return false;continue}if(list[k].kind==='picks')return true;j=k}return false};
      if(pitch===null){errors.push(a.sourceName+': row has no picks and the Survivor row spacing could not be proven');return}
      // Two rows closer than the grid allows cannot both be table rows: a row without picks squeezed against a
      // participant row, or further from the grid than the row it collides with, is stray text.
      const collisions=[idx>0&&tooClose(list[idx-1],a)?idx-1:-1,idx<list.length-1&&tooClose(a,list[idx+1])?idx+1:-1].filter(k=>k>=0);
      if(collisions.some(k=>list[k].kind==='picks'||gridDeviation(list,k)<=gridDeviation(list,idx))){ignore(a.row,'row without picks squeezed off the participant row grid');review.detachedRows.push({page:a.row.pageNumber??null,label:a.sourceName});return}
      if(!reaches(-1)&&!reaches(1)){ignore(a.row,'row without picks separated from the participant table');review.detachedRows.push({page:a.row.pageNumber??null,label:a.sourceName});return}
      if(!inNameColumn(a)){errors.push(a.sourceName+': row has no picks and its name is outside the participant name column');return}
      accepted.add(a);review.blankEntrants.push({page:a.row.pageNumber??null,label:a.sourceName});
    });
  }
  review.geometry={weekGap:+contract.gap.toFixed(2),columnOffset:+model.offset.toFixed(2),rowPitch:pitch===null?null:+pitch.toFixed(2),nameX:nameXs.length?[+Math.min(...nameXs).toFixed(2),+Math.max(...nameXs).toFixed(2)]:null};
  return{participants:region.filter(a=>accepted.has(a)),model};
}

export function parseSurvivorPages(pages,{season=2026,filename='survivor.pdf'}={}){
  const errors=[],rows=[],review={blankEntrants:[],ignoredRows:[],detachedRows:[],unanchoredRows:[]};
  for(const page of pages||[])for(const row of page.rows||[])rows.push({...row,kind:'pdf',pageNumber:page.pageNumber});
  const contract=headerContract(rows);
  if(!contract)return{errors:['Survivor Week header/columns could not be proven'],config:null,competitionSize:0,currentWeekEntryCount:0,review};
  const parsed=[];
  const region=participantRegion(rows,contract,review,errors);
  for(const a of region.participants){
    const p=participantPicks(a,contract,region.model);
    errors.push(...p.issues);parsed.push(p);
  }
  if(!parsed.length)errors.push('No Survivor entries found');
  let week=0;
  for(const p of parsed)for(let i=0;i<p.picks.length;i++)if(p.picks[i])week=Math.max(week,i+1);
  if(!week)errors.push('No populated Survivor week found');
  for(const p of parsed){
    for(let i=week;i<p.picks.length;i++)if(p.picks[i])errors.push(p.sourceName+': pick exists after detected current week');
  }

  const tracked=[];
  for(const target of SURVIVOR_TARGETS){
    const hits=parsed.filter(p=>target.aliases.some(a=>exact(a)===exact(p.sourceName)));
    if(hits.length!==1){errors.push(hits.length?'Multiple '+target.displayName+' Survivor rows found':'Missing '+target.displayName+' Survivor row');continue}
    tracked.push({id:target.id,displayName:target.displayName,picks:hits[0].picks.slice(0,week)});
  }

  const field=parsed.filter(p=>!targetForName(p.sourceName));
  const fieldEntries=field.map((p,i)=>({id:'survivor-'+String(i+1).padStart(3,'0'),picks:p.picks.slice(0,week)}));
  const competitionSize=parsed.length,currentWeekEntryCount=parsed.filter(p=>p.picks[week-1]).length;
  const config={
    schemaVersion:1,season,week,label:'Survivor Week '+week,
    competitionSize,currentWeekEntryCount,sheetWeeks:contract.sheetWeeks,
    trackedEntries:tracked,fieldEntries,
    source:{kind:'survivor-upload',filename}
  };
  return{errors:[...new Set(errors)],config,competitionSize,currentWeekEntryCount,review};
}

export function validateSurvivorConfig(config){
  const errors=[];
  if(!config||config.schemaVersion!==1)return['Unsupported Survivor configuration'];
  if(!Number.isInteger(config.season)||config.season<2020||config.season>2100)errors.push('Invalid season');
  if(!Number.isInteger(config.week)||config.week<1||config.week>22)errors.push('Invalid week');
  if(!Number.isInteger(config.sheetWeeks)||config.sheetWeeks<config.week||config.sheetWeeks>22)errors.push('Invalid sheet week count');
  const tracked=config.trackedEntries,field=config.fieldEntries;
  if(!Array.isArray(tracked)||tracked.length!==SURVIVOR_TARGETS.length)errors.push('Expected three tracked Survivor entries');
  if(!Array.isArray(field))errors.push('Missing anonymous Survivor field');
  const validatePicks=(p,label)=>{
    if(!Array.isArray(p?.picks)||p.picks.length!==config.week){errors.push(label+': wrong pick history length');return}
    for(const pick of p.picks)if(pick!==null&&!NFL_TEAMS.has(pick))errors.push(label+': invalid team '+pick);
  };
  if(Array.isArray(tracked)){
    const ids=new Set();
    tracked.forEach((p,i)=>{
      const target=SURVIVOR_TARGETS.find(t=>t.id===p?.id);
      if(!target||p?.displayName!==target.displayName)errors.push('Tracked Survivor identity mismatch');
      if(ids.has(p?.id))errors.push('Duplicate tracked Survivor id');ids.add(p?.id);
      const keys=Object.keys(p||{}).sort(),allowed=['displayName','id','picks'];
      if(keys.length!==allowed.length||keys.some((k,ki)=>k!==allowed[ki]))errors.push('Tracked Survivor entries may contain only displayName, id, and picks');
      validatePicks(p,'Tracked '+(p?.displayName||i+1));
    });
  }
  if(Array.isArray(field)){
    const ids=new Set(),allowed=['id','picks'];
    field.forEach((p,i)=>{
      const keys=Object.keys(p||{}).sort();
      if(keys.length!==allowed.length||keys.some((k,ki)=>k!==allowed[ki]))errors.push('Anonymous Survivor entries may contain only id and picks');
      if(typeof p?.id!=='string'||!p.id||ids.has(p.id))errors.push('Invalid anonymous Survivor id');else ids.add(p.id);
      validatePicks(p,'Field Survivor '+(i+1));
    });
  }
  const all=[...(Array.isArray(tracked)?tracked:[]),...(Array.isArray(field)?field:[])];
  if(config.competitionSize!==all.length)errors.push('Survivor competition size mismatch');
  const current=all.filter(p=>p?.picks?.[config.week-1]).length;
  if(config.currentWeekEntryCount!==current)errors.push('Survivor current-week entry count mismatch');
  return[...new Set(errors)];
}
