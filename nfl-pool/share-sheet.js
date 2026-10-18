'use strict';
// Shareable Cards V1: the share sheet. A Share button at the foot of the Pick'em standings (Home and Standings) and of the
// Survivor field status opens a dialog that previews the card image, shares the PNG through the device's share sheet where
// the browser can share files, downloads it, and copies the selected week's link or a text summary. The card is drawn from
// the snapshot the app answers with when the dialog opens (share-card.js); this module makes no network request.
import {pickemCard,survivorCard,drawShareCard,deepLink,CARD_WIDTH,CARD_HEIGHT} from './share-card.js?v=1';

const LABEL={pickem:{title:"Share Pick'em standings",button:'Share standings card'},survivor:{title:'Share Survivor status',button:'Share Survivor card'}};
// Where each contest's Share button goes: the foot of the card that shows that contest's standings.
const MOUNTS=[['pickem','homeStandings'],['pickem','standings'],['survivor','svSummaryNote']];
let dialog=null,ui=null,current=null,opener=null,generation=0,sharing=false;

// The app's answer to poolcenter:sharesnapshot, read back synchronously. Undefined when no app answers (an older cached
// module), null when the app has not installed a published week.
export function requestSnapshot(contest){
  const detail={contest,snapshot:undefined};
  document.dispatchEvent(new CustomEvent('poolcenter:sharesnapshot',{detail}));
  return detail.snapshot;
}
export function buildCard(contest,snapshot,now=Date.now()){
  if(snapshot===undefined)return{ok:false,contest,reason:'This page is still updating. Reload Pool Center, then try again.'};
  return contest==='survivor'?survivorCard(snapshot,{now}):pickemCard(snapshot,{now});
}
// The card as a 1080 × 1350 PNG. The preview, the shared file and the download are all this one blob.
export function renderCardPng(card){
  const canvas=document.createElement('canvas');canvas.width=CARD_WIDTH;canvas.height=CARD_HEIGHT;
  const ctx=canvas.getContext('2d');if(!ctx)return Promise.reject(new Error('Canvas is unavailable in this browser'));
  drawShareCard(ctx,card);
  return new Promise((resolve,reject)=>{
    const done=blob=>{canvas.width=canvas.height=0;blob?resolve(blob):reject(new Error('The card image could not be created'))};
    if(typeof canvas.toBlob==='function')canvas.toBlob(done,'image/png');
    else{try{const data=atob(canvas.toDataURL('image/png').split(',')[1]),bytes=new Uint8Array(data.length);for(let i=0;i<data.length;i++)bytes[i]=data.charCodeAt(i);done(new Blob([bytes],{type:'image/png'}))}catch(e){reject(e)}}
  });
}
export function canShareFiles(file){
  try{return typeof navigator.share==='function'&&typeof navigator.canShare==='function'&&navigator.canShare({files:[file]})===true}catch{return false}
}
const shareText=card=>`${card.shareTitle} · ${card.status.label}\n${card.url}`;

function el(tag,props={},children=[]){
  const node=document.createElement(tag);
  for(const [k,v] of Object.entries(props)){if(k==='text')node.textContent=v;else if(k==='class')node.className=v;else if(k in node&&k!=='hidden')node[k]=v;else node.setAttribute(k,v===true?'':String(v))}
  if(props.hidden)node.hidden=true;
  for(const child of children)node.appendChild(child);
  return node;
}
function shareIcon(){
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
  const path=document.createElementNS(ns,'path');path.setAttribute('d','M18 16a3 3 0 0 0-2.4 1.2l-6.7-3.4a3 3 0 0 0 0-1.6l6.7-3.4A3 3 0 1 0 15 7l-6.7 3.4a3 3 0 1 0 0 3.2L15 17a3 3 0 1 0 3-1z');path.setAttribute('fill','currentColor');
  svg.appendChild(path);return svg;
}
function ensureDialog(){
  if(dialog)return;
  const title=el('h2',{id:'share-sheet-title',text:''});
  const close=el('button',{type:'button',class:'share-close','aria-label':'Close share dialog',text:'×'});
  const state=el('p',{class:'share-state',id:'share-sheet-state'});
  const img=el('img',{alt:'',width:CARD_WIDTH,height:CARD_HEIGHT,decoding:'async',hidden:true});
  const waiting=el('span',{class:'share-wait',text:'Drawing the card…'});
  const preview=el('figure',{class:'share-preview','aria-busy':'true'},[img,waiting]);
  const action=(name,text,extra='')=>el('button',{type:'button',class:`share-action${extra}`,'data-share-action':name,text});
  const buttons={share:action('share','Share image',' primary'),link:action('share-link','Share link'),download:action('download','Download PNG'),copyLink:action('copy-link','Copy link'),copyText:action('copy-text','Copy text')};
  const note=el('p',{class:'share-note',hidden:true});
  const manual=el('textarea',{class:'share-manual',readOnly:true,rows:4,'aria-label':'Text to copy',hidden:true});
  const feedback=el('p',{class:'share-feedback',role:'status','aria-live':'polite'});
  const panel=el('div',{class:'share-panel'},[el('div',{class:'share-head'},[title,close]),state,preview,el('div',{class:'share-actions'},Object.values(buttons)),note,manual,feedback]);
  dialog=el('dialog',{class:'share-sheet','aria-labelledby':'share-sheet-title','aria-describedby':'share-sheet-state'},[panel]);
  document.body.appendChild(dialog);
  ui={title,close,state,img,waiting,preview,buttons,note,manual,feedback};
  close.addEventListener('click',()=>closeSheet());
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeSheet()});
  dialog.addEventListener('click',event=>{if(event.target===dialog)closeSheet()});
  buttons.share.addEventListener('click',()=>void shareImage());
  buttons.link.addEventListener('click',()=>void shareLink());
  buttons.download.addEventListener('click',()=>download());
  buttons.copyLink.addEventListener('click',()=>void copy(current?.url||current?.link,'Link copied.'));
  buttons.copyText.addEventListener('click',()=>void copy(current?.card?.text,'Text summary copied.'));
}
function say(text){ui.feedback.textContent=text}
function setActions({ready,link}){
  const file=current?.file,files=!!file&&canShareFiles(file),webShare=typeof navigator.share==='function';
  ui.buttons.share.hidden=!ready||!files;ui.buttons.share.disabled=!ready||sharing;
  ui.buttons.link.hidden=!ready||files||!webShare;
  ui.buttons.download.hidden=!ready;ui.buttons.copyText.hidden=!ready;
  ui.buttons.copyLink.hidden=!link;
  ui.buttons.download.classList.toggle('primary',ready&&!files);
  ui.note.hidden=!ready||files;
  ui.note.textContent=ready&&!files?"This browser can't share image files directly. Download the PNG, then share it from your photos or files, or copy the link.":'';
}
function release(){if(current?.previewUrl)URL.revokeObjectURL(current.previewUrl)}

export async function openSheet(contest,trigger=null){
  ensureDialog();
  const id=++generation;release();opener=trigger;sharing=false;
  const snapshot=requestSnapshot(contest),card=buildCard(contest,snapshot);
  const link=snapshot&&Number.isSafeInteger(snapshot.season)&&Number.isSafeInteger(snapshot.week)?deepLink(contest,snapshot.season,snapshot.week):null;
  current={contest,card,link,url:card.ok?card.url:link,file:null,blob:null,previewUrl:null};
  ui.title.textContent=LABEL[contest].title;ui.feedback.textContent='';ui.manual.hidden=true;ui.manual.value='';
  ui.img.hidden=true;ui.img.removeAttribute('src');ui.img.alt='';
  ui.preview.setAttribute('aria-busy','true');ui.preview.classList.toggle('unavailable',!card.ok);
  ui.waiting.textContent=card.ok?'Drawing the card…':'No card for this view yet';
  ui.state.textContent=card.ok?`${card.status.label} · ${card.season} Week ${card.week} · revision ${card.revision}${card.status.detail?` · ${card.status.detail.toLowerCase()}`:''}`:card.reason;
  ui.state.className=`share-state ${card.ok?`tone-${card.status.tone}`:'tone-unavailable'}`;
  setActions({ready:false,link:!!current.url});
  document.documentElement.classList.add('share-open');
  if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','')}
  ui.close.focus();
  if(!card.ok){ui.preview.setAttribute('aria-busy','false');return}
  try{
    const blob=await renderCardPng(card);
    if(id!==generation||!dialog.open)return;
    current.blob=blob;current.file=new File([blob],card.filename,{type:'image/png',lastModified:Date.now()});
    current.previewUrl=URL.createObjectURL(blob);ui.img.src=current.previewUrl;ui.img.alt=card.alt;ui.img.hidden=false;
    ui.waiting.textContent='';ui.preview.setAttribute('aria-busy','false');
    setActions({ready:true,link:true});
    (ui.buttons.share.hidden?ui.buttons.download:ui.buttons.share).focus();
  }catch(e){
    if(id!==generation)return;
    console.warn(e);ui.preview.setAttribute('aria-busy','false');ui.waiting.textContent='The card image could not be drawn';
    say("The card image couldn't be created on this device. You can still copy the link.");
  }
}
export function closeSheet(){
  if(!dialog)return;
  generation++;release();current=null;sharing=false;
  if(dialog.open){if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open')}
  document.documentElement.classList.remove('share-open');
  const back=opener;opener=null;if(back&&typeof back.focus==='function')back.focus();
}
// The file share runs straight from the tap (no await before it), so the browser still counts it as the user's action.
// A cancelled share does nothing else: nothing is downloaded and nothing is copied.
export async function shareImage(){
  const file=current?.file,card=current?.card;if(!file||!card||sharing)return;
  if(!canShareFiles(file)){setActions({ready:true,link:true});say("This browser can't share image files. Use Download PNG instead.");return}
  sharing=true;ui.buttons.share.disabled=true;
  try{await navigator.share({files:[file],title:card.shareTitle,text:shareText(card)});if(current?.card===card)say('Card shared.')}
  catch(e){
    if(current?.card!==card)return;
    if(e?.name==='AbortError')say('Sharing cancelled.');
    else if(e?.name==='NotAllowedError')say("Sharing wasn't allowed just now. Tap Share image again, or use Download PNG.");
    else say("This device couldn't share the image. Use Download PNG or Copy link instead.");
  }finally{if(current?.card===card){sharing=false;ui.buttons.share.disabled=false}}
}
async function shareLink(){
  const card=current?.card;if(!card?.ok||sharing||typeof navigator.share!=='function')return;
  sharing=true;
  try{await navigator.share({title:card.shareTitle,text:`${card.shareTitle} · ${card.status.label}`,url:card.url});if(current?.card===card)say('Link shared.')}
  catch(e){if(current?.card===card)say(e?.name==='AbortError'?'Sharing cancelled.':"This device couldn't share the link. Use Copy link instead.")}
  finally{if(current?.card===card)sharing=false}
}
export function download(){
  const blob=current?.blob,card=current?.card;if(!blob||!card)return;
  const url=URL.createObjectURL(blob),a=el('a',{href:url,download:card.filename,rel:'noopener'});
  a.hidden=true;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  say(`Downloading ${card.filename}.`);
}
// Copies with the clipboard API, else the older copy command, else shows the text selected so it can be copied by hand.
export async function copy(text,done){
  if(!text)return false;
  try{if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){await navigator.clipboard.writeText(text);say(done);return true}}catch{}
  const area=ui.manual;area.value=text;area.hidden=false;area.focus();area.select();
  let ok=false;try{ok=document.execCommand('copy')===true}catch{}
  if(ok){area.hidden=true;say(done);return true}
  say('Copying is blocked here. The text is selected below: press and hold it to copy.');
  return false;
}
function mountTriggers(){
  for(const [contest,id] of MOUNTS){
    const anchor=document.getElementById(id),host=id==='standings'?anchor?.closest('.card'):anchor?.parentElement;
    if(!host||host.querySelector(`[data-share-card="${contest}"]`))continue;
    const button=el('button',{type:'button',class:'share-trigger','data-share-card':contest,'aria-haspopup':'dialog'},[shareIcon(),el('span',{text:LABEL[contest].button})]);
    button.addEventListener('click',()=>void openSheet(contest,button));
    const row=el('div',{class:'share-row'},[button]);
    if(id==='svSummaryNote')anchor.after(row);else host.appendChild(row);
  }
}
if(typeof document!=='undefined'&&document.getElementById)mountTriggers();
