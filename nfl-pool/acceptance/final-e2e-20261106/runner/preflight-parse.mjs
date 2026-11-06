// QA ONLY. STATIC preflight (NOT browser evidence): runs the committed main-branch parsers/validators on the fixture PDFs
// with the same pinned PDF.js version the publishers load (pdfjs-dist 4.10.38), against saved ESPN payloads, so fixture
// mistakes are caught before the browser run. Adapted from PR #29's preflight. Usage:
//   node preflight-parse.mjs <pdfjs-dist dir> <fixtures dir> <espn snapshot dir> <published survivor rows json>
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [pdfjsDir,fixtures,espnDir,publishedFile]=process.argv.slice(2);
const repo=new URL('../../../',import.meta.url);
const pdfjs=await import(pathToFileURL(pdfjsDir+'/legacy/build/pdf.mjs').href);
const core=await import(new URL('admin/parser-core.js',repo));
const sp=await import(new URL('admin/survivor-parser.js',repo));
const checks=await import(new URL('admin/survivor-publish-checks.js',repo));
const espn=w=>JSON.parse(readFileSync(`${espnDir}/week${w}.json`,'utf8'));
const items=async file=>{
  const pdf=await pdfjs.getDocument({data:new Uint8Array(readFileSync(`${fixtures}/${file}`)),useSystemFonts:false,isEvalSupported:false}).promise,pages=[];
  for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n);pages.push({n,items:(await page.getTextContent()).items})}
  return pages;
};
const norm=x=>({JAC:'JAX',WSH:'WAS'}[x]||x);
for(const v of ['r1','r2','missing-picks','duplicate-team','invalid-schedule','duplicate-tracked','malformed']){
  const file=v==='malformed'?'QA-FINAL-E2E-malformed.pdf':`QA-FINAL-E2E-Pickem-2026-W5-${v}.pdf`;
  let pages;
  try{pages=await items(file)}catch(e){console.log(JSON.stringify({file,pdfError:e.message}));continue}
  const groups=core.carryForwardWeekHints(pages.map(({n,items})=>{const sourceRows=core.groupPdfTextItems(items).map(r=>({...r,kind:'pdf',pageNumber:n})),lines=sourceRows.map(r=>r.text);return{week:lines.map(core.detectWeek).find(Boolean)||null,lines,sourceRows,pageNumber:n,pageFingerprint:lines.join('\n').replace(/\s+/g,' ').trim().toLowerCase()}}));
  const cands=core.parseDocumentGroups(groups,{filename:file,season:2026,expectedCompetitionSize:null});
  const valid=cands.filter(c=>!c.errors.length&&c.config.participants.length===core.TARGETS.length);
  const best=core.chooseBestCandidate(cands),c=best||cands[0];
  const events=espn(5).events.map(e=>{const cs=e.competitions[0].competitors;return norm(cs.find(x=>x.homeAway==='away').team.abbreviation)+'@'+norm(cs.find(x=>x.homeAway==='home').team.abbreviation)});
  const offSlate=(c?.config?.games||[]).filter(g=>!events.includes(norm(g.away)+'@'+norm(g.home))).map(g=>g.away+'@'+g.home);
  console.log(JSON.stringify({file,pages:pages.length,week:c?.week,games:c?.gameCount,validCandidates:valid.length,errors:c?.errors,fullFieldReady:c?.config?.fullFieldReady,competitionSize:c?.config?.competitionSize,fieldIssues:c?.fullFieldIssues,tracked:c?.config?.participants?.map(p=>p.displayName+':'+p.pickNumbers.join(' ')+' tb'+p.tiebreak),validateConfig:c?core.validateConfig(c.config):null,offSlate}));
}
const published=JSON.parse(readFileSync(publishedFile,'utf8'));
const payloads=Object.fromEntries([1,2,3,4,5,6,7,8].map(w=>[w,espn(w)]));
for(const v of ['r1','r2','bye-pick','unknown-team','duplicate-tracked','malformed']){
  const file=v==='malformed'?'QA-FINAL-E2E-malformed.pdf':`QA-FINAL-E2E-Survivor-2026-W8-${v}.pdf`;
  let raw;
  try{raw=await items(file)}catch(e){console.log(JSON.stringify({file,pdfError:e.message}));continue}
  const pages=raw.map(({n,items})=>({pageNumber:n,rows:sp.groupSurvivorPdfTextItems(items)}));
  const result=sp.parseSurvivorPages(pages,{season:2026,filename:file});
  const out={file,pages:pages.length,parseErrors:result.errors};
  if(!result.errors.length){
    out.validate=sp.validateSurvivorConfig(result.config);
    const verification=checks.verifySurvivorSchedule(result.config,payloads);
    out.schedule={ok:verification.ok,errors:verification.errors};
    if(verification.ok){
      const guard=checks.survivorPublishGuard(result.config,{resultsByWeek:verification.resultsByWeek,currentGames:verification.weeks.find(w=>w.week===result.config.week)?.games,published:{checked:true,rows:published},detachedRows:result.review.detachedRows,unanchoredRows:result.review.unanchoredRows,gridBreaks:result.review.gridBreaks,symbolRows:result.review.symbolRows});
      out.guard={blocking:guard.blocking,requiresConfirmation:guard.requiresConfirmation,reasons:guard.reasons,facts:guard.facts};
    }
    out.week=result.config.week;out.size=result.config.competitionSize;out.current=result.config.currentWeekEntryCount;out.tracked=result.config.trackedEntries.map(t=>t.displayName+':'+t.picks.map(x=>x||'-').join(','));out.field=result.config.fieldEntries.map(f=>f.id+':'+f.picks.map(x=>x||'-').join(','));
  }
  console.log(JSON.stringify(out));
}
