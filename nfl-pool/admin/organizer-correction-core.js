// Pure, fail-closed planner. An organizer may email corrections without issuing a replacement weekly sheet.
// Source names are used in memory to establish an anonymous entry ID from the *original* PDF/Excel file;
// neither names, raw documents nor images are included in a proposed database configuration.
import {validateConfig} from './parser-core.js?v=16';

const normalizeName=v=>String(v??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const integer=v=>/^(0|[1-9]\d*)$/.test(String(v??'').trim())?Number(v):NaN;
function requireState(ok,message){if(!ok)throw new Error(message);}
export function organizerNoticeLabel(sourceType){
  switch(sourceType){
    case 'organizer-email':return 'Organizer email';
    case 'organizer-spreadsheet':return 'Organizer spreadsheet';
    case 'organizer-notice':return 'Organizer notice';
    default:return '';
  }
}
function currentEntryMatchesSource(now,original,history){
  if(now?.id===original?.id&&same(now.pickNumbers,original.pickNumbers)&&now.tiebreak===original.tiebreak)return true;
  const last=history.filter(c=>c?.entryId===now?.id).at(-1);
  return !!last&&same(last.correctedPickNumbers,now.pickNumbers)&&last.correctedTiebreak===now.tiebreak;
}
export function planOrganizerCorrection({published,source,digest,participantName,picksText,tiebreakText,sourceType='organizer-email'}){
  const cfg=published?.config,src=source?.config;
  requireState(published?.status==='locked'&&Number.isSafeInteger(published?.revision)&&published.revision>0,'A locked published week with a known revision is required.');
  requireState(cfg?.fullFieldReady===true&&src?.fullFieldReady===true,'Both the published week and original source must have validated complete fields.');
  requireState(validateConfig(cfg).length===0&&validateConfig(src).length===0,'Original or published configuration failed validation.');
  requireState(published.season===src.season&&published.week===src.week,'Original source season/week does not match the published week.');
  requireState(typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest)&&
    published.source_sha256===digest&&cfg?.source?.sha256===digest,
    'This is not the exact original uploaded sheet. Select the PDF or Excel file that was used for this published week.');
  requireState(Array.isArray(cfg.games)&&cfg.games.length>0&&src.games.length===cfg.games.length,'Original sheet matchup count differs from the published week.');
  for(let i=0;i<cfg.games.length;i++){
    const a=cfg.games[i],b=src.games[i];
    requireState(a.awayNumber===b.awayNumber&&a.homeNumber===b.homeNumber&&a.away===b.away&&a.home===b.home,
      'Original sheet matchup order differs from the published week.');
  }
  const entries=cfg.fieldEntries,original=src.fieldEntries,names=source.localFieldNames;
  requireState(Array.isArray(entries)&&Array.isArray(original)&&Array.isArray(names)&&
    entries.length===original.length&&original.length===names.length&&entries.length>0,
    'Could not prove a one-to-one anonymous field-to-original-sheet mapping.');
  requireState(cfg.competitionSize===src.competitionSize&&cfg.fullFieldEntryCount===entries.length,
    'The published field size differs from the original sheet.');
  const history=Array.isArray(cfg.organizerCorrections)?cfg.organizerCorrections:[];
  for(let i=0;i<entries.length;i++){
    requireState(entries[i]?.id===original[i]?.id&&currentEntryMatchesSource(entries[i],original[i],history),
      `Published entry ${i+1} cannot be reconciled to the original sheet and recorded corrections. Nothing can be changed.`);
  }
  const name=normalizeName(participantName);
  requireState(name.length>0,'Enter the participant name exactly as it appears on the original organizer sheet.');
  const matches=names.map((n,i)=>normalizeName(n)===name?i:-1).filter(i=>i>=0);
  requireState(matches.length===1,matches.length===0?'Participant was not found in the original organizer sheet.':'Name occurs more than once; do not guess which entry to correct.');
  const index=matches[0],before=entries[index],parts=String(picksText??'').trim().split(/[\s,;|]+/).filter(Boolean);
  requireState(parts.length===cfg.games.length,`Enter exactly ${cfg.games.length} numbered picks in matchup order.`);
  const picks=parts.map(integer);
  for(let i=0;i<picks.length;i++){
    const g=cfg.games[i];
    // An already-published no-pick (0) is not a missing form field: keep it unchanged when
    // correcting a different game or tiebreaker. Never silently turn a valid selection into 0.
    const retainNoPick=picks[i]===0&&before.pickNumbers[i]===0;
    requireState(Number.isSafeInteger(picks[i])&&
      (retainNoPick||picks[i]===g.awayNumber||picks[i]===g.homeNumber),
      `Pick ${i+1} must be ${g.awayNumber} or ${g.homeNumber}. Use 0 only to retain an existing no-pick.`);
  }
  // The parser can legitimately publish null when the organizer did not supply a
  // tiebreaker. Blank input preserves that exact null; it cannot erase a known number.
  const blankTiebreak=String(tiebreakText??'').trim()==='';
  const retainBlankTiebreak=blankTiebreak&&before.tiebreak===null;
  const tiebreak=retainBlankTiebreak?null:integer(tiebreakText);
  requireState(retainBlankTiebreak||
    (Number.isSafeInteger(tiebreak)&&tiebreak<=999),
    'Enter a nonnegative whole-number tiebreaker (0–999), or leave blank only to retain an existing blank tiebreaker.');
  requireState(organizerNoticeLabel(sourceType),'Unsupported organizer notice type.');
  requireState(!same(before.pickNumbers,picks)||before.tiebreak!==tiebreak,'The published entry already matches this correction. No new revision is needed.');
  const afterConfig=JSON.parse(JSON.stringify(cfg));
  afterConfig.fieldEntries[index]={id:before.id,pickNumbers:picks,tiebreak};
  const errors=validateConfig(afterConfig);
  requireState(errors.length===0,'Corrected configuration failed validation: '+errors.join(' · '));
  const changes=picks.map((value,i)=>value===before.pickNumbers[i]?null:{
    gameIndex:i,game:cfg.games[i],before:before.pickNumbers[i],after:value
  }).filter(Boolean);
  return{entryId:before.id,index,priorRevision:published.revision,previousPicks:[...before.pickNumbers],
    correctedPicks:picks,previousTiebreak:before.tiebreak,correctedTiebreak:tiebreak,
    changes,sourceType,afterConfig};
}
export function finalizeOrganizerCorrection(plan,published,recordedAt){
  requireState(plan?.priorRevision===published?.revision&&published?.status==='locked','The published revision changed. Preview again.');
  const timestamp=Date.parse(recordedAt);
  requireState(Number.isFinite(timestamp),'Correction timestamp is invalid.');
  const noticeSubject=organizerNoticeLabel(plan.sourceType);
  requireState(noticeSubject,'Unsupported organizer notice type.');
  const cfg=JSON.parse(JSON.stringify(plan.afterConfig));
  const history=Array.isArray(cfg.organizerCorrections)?cfg.organizerCorrections:[];
  cfg.organizerCorrections=[...history,{
    version:1,entryId:plan.entryId,sourceType:plan.sourceType,noticeSubject,
    sourceWeek:published.week,priorRevision:published.revision,
    priorPickNumbers:plan.previousPicks,correctedPickNumbers:plan.correctedPicks,
    priorTiebreak:plan.previousTiebreak,correctedTiebreak:plan.correctedTiebreak,
    recordedAt:new Date(timestamp).toISOString()
  }];
  const errors=validateConfig(cfg);requireState(errors.length===0,'Final correction is invalid: '+errors.join(' · '));
  return cfg;
}
