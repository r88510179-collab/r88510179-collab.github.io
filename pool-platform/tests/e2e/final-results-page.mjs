// Page-driving helpers for the commissioner final-score panel, shared by the hermetic suite
// (final-results.e2e.test.mjs) and the signed-in acceptance routine (signed-in-acceptance-core.mjs).
// Nothing here reads, returns or logs a token, a cookie or a sign-in code.
export const scoreInput=(page,gameId,side)=>page.locator(`input[data-final-id="${gameId}"][data-final-side="${side}_score"]`);

export async function openWeek(page,weekId,poolName){
  await page.locator('#poolName').filter({hasText:poolName}).waitFor({state:'visible'});
  await page.locator('#weekSelect').selectOption(weekId);
}
// ---- pointer actions and content that arrives late -----------------------------------------------------------
// The two standings cards sit above the final-score panel and are filled in by their own requests: after a week is
// chosen, and again after a revision is recorded. When they grow, everything below them moves (205 px at 1280 px
// wide with the test fixture). A pointer click is a press and a release, and a browser may deliver the two
// separately; when the move falls between them the release reaches another element and nothing is clicked, while
// the automation reports a click. A person does not act within a fraction of a second of choosing a week, so this
// is a hazard for automation and not for them. Two measures, both here and neither in the page:
//   quiet(page)      waits until the page has finished every request it started and has laid out the result;
//   openPanel(page)  checks that the panel really opened, repeats the click if not, and says what the pointer reached.

// For BrowserContext.addInitScript: counts the page's own requests from before its first script runs. A request
// counts until its whole response has arrived, because the page reads the body before it changes anything.
export function countRequests(){
  if(window.__pendingRequests!==undefined)return;
  window.__pendingRequests=0;
  const original=window.fetch;
  window.fetch=function(...args){
    window.__pendingRequests++;
    let open=true;
    const settle=()=>{if(open){open=false;window.__pendingRequests--}};
    let response;
    try{response=original.apply(this,args)}catch(error){settle();throw error}
    response.then(received=>received.clone().arrayBuffer().then(settle,settle),settle);
    return response;
  };
}
// Resolves once no request of the page has been pending for three animation frames in a row. Without
// countRequests installed it waits the three frames only.
export async function quiet(page){
  await page.evaluate(()=>{window.__quietFrames=0});
  await page.waitForFunction(()=>{
    if(window.__pendingRequests>0){window.__quietFrames=0;return false}
    window.__quietFrames=(window.__quietFrames||0)+1;
    return window.__quietFrames>=3;
  },null,{polling:'raf'});
}
// A pointer click on a control of the panel, once the page has stopped moving it.
export async function press(page,selector){
  await quiet(page);
  await page.locator(selector).click();
}
const pointerEvents=page=>page.evaluate(()=>{
  if(!window.__pointerEvents){
    window.__pointerEvents=[];
    const named=element=>element?`${element.tagName.toLowerCase()}${element.id?`#${element.id}`:''}`:'nothing';
    for(const type of ['mousedown','mouseup','click'])window.addEventListener(type,event=>{
      const heading=document.getElementById('finalResultHeading')?.getBoundingClientRect();
      window.__pointerEvents.push(`${type} reached ${named(event.target)} at y=${Math.round(event.clientY)}`
        +(heading?` (heading at y=${Math.round(heading.top)} to ${Math.round(heading.bottom)})`:''));
    },true);
  }
  return window.__pointerEvents.splice(0);
});
export async function openPanel(page,{log=line=>console.log(line)}={}){
  await page.locator('#finalResultAdmin').waitFor({state:'visible'});
  const isOpen=()=>page.locator('#finalResultDetails').evaluate(el=>el.open);
  for(let attempt=1;!await isOpen();attempt++){
    await quiet(page);
    await pointerEvents(page);
    await page.locator('#finalResultHeading').click();
    if(await isOpen())break;
    const reached=(await pointerEvents(page)).join('; ')||'no pointer event reached the page';
    if(attempt===3)throw new Error(`the final-score panel did not open after ${attempt} clicks on its heading: ${reached}`);
    log(`[final-score panel] a click on the heading opened nothing (attempt ${attempt}): ${reached}`);
  }
  await page.locator('#finalResultForm').waitFor({state:'visible'});
}
export async function fillScores(page,scores){
  for(const [gameId,[away,home]] of Object.entries(scores)){
    await scoreInput(page,gameId,'away').fill(String(away));
    await scoreInput(page,gameId,'home').fill(String(home));
  }
}
export const shown=(page,id,pattern,timeout)=>page.locator(`#${id}`).filter({hasText:pattern}).waitFor({state:'visible',timeout});
export async function reviewAndRecord(page){
  await press(page,'#finalResultPreview');
  await page.locator('#finalResultReview').waitFor({state:'visible'});
  await quiet(page);
  await page.locator('#finalResultConfirmCheck').check();
  await press(page,'#finalResultConfirm');
}
export const gameIds=page=>page.locator('#finalResultGames [data-final-game-row]').evaluateAll(rows=>rows.map(row=>row.dataset.finalGameRow));

// A direct Data API call made by the page with its own session token (or none): what a client that skips the UI
// can do. The token is fetched and used inside the page and never leaves it; only the outcome comes back.
export function rpc(page,dataApi,name,args,{anonymous=false}={}){
  return page.evaluate(async({name,args,dataApi,anonymous})=>{
    const headers={'Content-Type':'application/json'};
    if(!anonymous){
      const session=await fetch('/api/auth/get-session',{credentials:'same-origin',cache:'no-store'});
      const token=session.headers.get('set-auth-jwt');
      if(!token)return{status:0,message:'no session token',code:null,body:null};
      headers.Authorization=`Bearer ${token}`;
    }
    const call=()=>fetch(`${dataApi}/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(args)});
    let response=await call(),body=null;
    try{body=await response.json()}catch{}
    // The app's own single retry for a newly opened Data API connection (platform-client.js).
    if(!response.ok&&body?.message==='auth_required'){
      await new Promise(resolve=>setTimeout(resolve,200));
      response=await call();body=null;
      try{body=await response.json()}catch{}
    }
    return{status:response.status,message:body?.message??null,code:body?.code??null,body};
  },{name,args,dataApi,anonymous});
}
// A direct table read with the page's own token: must never return a row of the append-only result tables.
export function readTable(page,dataApi,table){
  return page.evaluate(async({dataApi,table})=>{
    const session=await fetch('/api/auth/get-session',{credentials:'same-origin',cache:'no-store'});
    const token=session.headers.get('set-auth-jwt');
    if(!token)return{status:0,rows:null};
    const response=await fetch(`${dataApi}/${table}?select=*&limit=5`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
    let body=null;
    try{body=await response.json()}catch{}
    return{status:response.status,rows:Array.isArray(body)?body.length:null,code:body?.code??null};
  },{dataApi,table});
}
// Non-secret facts about the session token, decoded inside the page: who issued it and for whom. Never the token.
export function tokenFacts(page){
  return page.evaluate(async()=>{
    const session=await fetch('/api/auth/get-session',{credentials:'same-origin',cache:'no-store'});
    const token=session.headers.get('set-auth-jwt');
    if(!token)return null;
    try{
      const claims=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      return{iss:typeof claims.iss==='string'?claims.iss:null,aud:typeof claims.aud==='string'?claims.aud:null,
        emailVerified:claims.emailVerified===true,expiresInSeconds:Math.round(claims.exp-Date.now()/1000)};
    }catch{return null}
  });
}
// The rows of a standings card, as text: one array of cell texts per row.
export const cardRows=(page,cardId)=>page.locator(`#${cardId} .standings-row`)
  .evaluateAll(items=>items.map(item=>[...item.children].map(cell=>cell.textContent)));

// The standings cards at the current viewport: the page does not scroll sideways and nothing in a shown card is cut
// off. A card that is not shown is a problem only when it is listed in `required`. Returns the problems found.
export async function cardLayoutProblems(page,width,cardIds,required=cardIds){
  const layout=await page.evaluate(ids=>({inner:innerWidth,page:document.documentElement.scrollWidth,
    cards:ids.map(id=>{
      const card=document.getElementById(id);
      if(!card||!card.getClientRects().length)return{id,shown:false,cut:0};
      const parts=[card,...card.querySelectorAll('.standings-row,.standings-row > *,[data-season-status],[data-season-weeks],[data-standings-status]')];
      return{id,shown:true,cut:parts.filter(el=>el.getClientRects().length).filter(el=>{
        const box=el.getBoundingClientRect();return box.left<-0.5||box.right>innerWidth+0.5}).length};
    })}),cardIds);
  const problems=[];
  if(layout.inner!==width)problems.push(`viewport is ${layout.inner}px, not ${width}px`);
  if(layout.page>width)problems.push(`the page is ${layout.page}px wide and scrolls sideways`);
  for(const card of layout.cards){
    if(!card.shown){if(required.includes(card.id))problems.push(`${card.id} is not shown`)}
    else if(card.cut)problems.push(`${card.cut} part(s) of ${card.id} are cut off`);
  }
  return problems;
}

// The panel's layout at the current viewport: nothing wider than the screen, every control reachable and tall
// enough to tap. Returns the problems found (empty when the layout is sound).
export async function panelLayoutProblems(page,width){
  const layout=await page.evaluate(()=>{
    const visible=el=>el.getClientRects().length>0;
    const panel=document.querySelector('#finalResultAdmin');
    return{inner:innerWidth,page:document.documentElement.scrollWidth,
      overflowing:[...panel.querySelectorAll('*')].filter(el=>visible(el)&&el.scrollWidth>el.clientWidth+1&&getComputedStyle(el).overflowX==='visible').map(el=>el.id||el.className||el.tagName),
      controls:[...panel.querySelectorAll('input,textarea,button,summary')].filter(visible).map(el=>{
        const box=el.getBoundingClientRect();
        return{name:el.id||`${el.dataset.finalId}:${el.dataset.finalSide}`,type:el.type||el.tagName,left:box.left,right:box.right,height:box.height};
      })};
  });
  const problems=[];
  if(layout.inner!==width)problems.push(`viewport is ${layout.inner}px, not ${width}px`);
  if(layout.page>width)problems.push(`the page is ${layout.page}px wide and scrolls sideways`);
  for(const name of layout.overflowing)problems.push(`${name} overflows its box`);
  for(const control of layout.controls){
    if(control.left<0||control.right>width+0.5)problems.push(`${control.name} is cut off`);
    if(control.type!=='checkbox'&&control.height<44)problems.push(`${control.name} is only ${control.height}px tall`);
  }
  return{problems,scoreInputs:layout.controls.filter(control=>control.type==='number').length};
}
