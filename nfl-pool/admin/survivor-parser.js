export const SURVIVOR_TARGETS=[
  {id:'dc',displayName:'D.C.',aliases:['D.C.','D.C','DC']},
  {id:'djs',displayName:'DJS',aliases:['DJS']},
  {id:'thaddeus',displayName:'Thaddeus',aliases:['Thaddius','Thaddeus']}
];

const NFL_TEAMS=new Set(['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS']);
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
  return{headerKey:sourceRowKey(row),weekXs:numeric.map(n=>n.x),sheetWeeks:numeric.length,gap,nameCutoff:numeric[0].x-gap*0.44};
}

function sourceRowKey(row){return 'pdf:'+(row.pageNumber??'?')+':'+Number(row.y??0).toFixed(2)+':'+clean(row.text)}

function targetForName(name){
  const n=exact(name);
  return SURVIVOR_TARGETS.find(t=>t.aliases.some(a=>exact(a)===n))||null;
}

function parseParticipantRow(row,contract){
  if(!row||sourceRowKey(row)===contract.headerKey)return null;
  const parts=(row.parts||[]).map(p=>({x:Number(p.x),text:clean(p.text)})).filter(p=>Number.isFinite(p.x)&&p.text);
  if(!parts.length)return null;
  const nameParts=parts.filter(p=>p.x<contract.nameCutoff).sort((a,b)=>a.x-b.x);
  const sourceName=clean(nameParts.map(p=>p.text).join(' '));
  if(!sourceName||/^suicide pool$/i.test(sourceName)||/^week$/i.test(sourceName))return null;
  const bins=Array.from({length:contract.sheetWeeks},()=>[]);
  for(const part of parts){
    if(part.x<contract.nameCutoff)continue;
    let best=-1,bestDist=Infinity;
    contract.weekXs.forEach((x,i)=>{const d=Math.abs(part.x-x);if(d<bestDist){best=i;bestDist=d}});
    if(best>=0&&bestDist<=contract.gap*0.62)bins[best].push(part.text);
  }
  const rawPicks=bins.map(xs=>clean(xs.join(' '))||null);
  const picks=[],issues=[];
  rawPicks.forEach((raw,i)=>{
    if(!raw){picks.push(null);return}
    const team=normalizeSurvivorTeam(raw);
    if(!team){issues.push(sourceName+': unknown Week '+(i+1)+' team '+raw);picks.push(null)}
    else picks.push(team);
  });
  return{sourceName,picks,issues,row};
}

export function parseSurvivorPages(pages,{season=2026,filename='survivor.pdf'}={}){
  const errors=[],rows=[];
  for(const page of pages||[])for(const row of page.rows||[])rows.push({...row,kind:'pdf',pageNumber:page.pageNumber});
  const contract=headerContract(rows);
  if(!contract)return{errors:['Survivor Week header/columns could not be proven'],config:null,competitionSize:0,currentWeekEntryCount:0};
  const parsed=[];
  for(const row of rows){
    const p=parseParticipantRow(row,contract);if(!p)continue;
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
  return{errors:[...new Set(errors)],config,competitionSize,currentWeekEntryCount};
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
