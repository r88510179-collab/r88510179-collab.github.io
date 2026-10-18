// Pool Center shareable cards, the page part (share-card.js is the pure part). Each Share button, hidden until this module
// runs, asks the app that owns its view for a snapshot with a poolcenter:share event, builds the card from it, draws it once
// into a 1080 x 1350 PNG and previews that same PNG. Share hands the PNG to the device's share sheet where the browser can
// share files, Download saves it, and Copy link and Copy summary copy text. The snapshot is taken once, when the preview
// opens: the page keeps refreshing underneath it, and the card says when it was taken.
import {buildCard,drawCard,shareSupport,sharePayload,CARD_WIDTH,CARD_HEIGHT} from './share-card.js?v=1';

const TITLES={pickem:"Share Pick'em standings",survivor:'Share Survivor results'};
// A PNG export that has not finished in this time is treated as failed rather than left spinning.
const EXPORT_TIMEOUT_MS=15000;
let ui=null,current=null,generation=0;

function requestSnapshot(contest){
  const detail={contest,snapshot:null};
  document.dispatchEvent(new CustomEvent('poolcenter:share',{detail}));
  return detail.snapshot;
}
function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props)){
    if(key==='class')node.className=value;else if(key==='text')node.textContent=value;
    else if(key==='hidden')node.hidden=value;else node.setAttribute(key,value);
  }
  for(const child of children)node.appendChild(child);
  return node;
}
function ensureDialog(){
  if(ui)return ui;
  const title=el('h2',{id:'shareTitle'}),close=el('button',{type:'button',class:'share-close','aria-label':'Close share preview',text:'✕'});
  const image=el('img',{class:'share-image',alt:'',hidden:true}),message=el('div',{class:'share-placeholder'});
  const note=el('p',{class:'share-note',id:'shareNote'}),status=el('p',{class:'share-status',role:'status','aria-live':'polite'});
  const buttons={
    share:el('button',{type:'button',class:'share-action primary',text:'Share graphic'}),
    download:el('button',{type:'button',class:'share-action',text:'Download PNG'}),
    link:el('button',{type:'button',class:'share-action',text:'Copy link'}),
    summary:el('button',{type:'button',class:'share-action',text:'Copy summary'})
  };
  const actions=el('div',{class:'share-actions'},...Object.values(buttons));
  const dialog=el('dialog',{class:'share-dialog','aria-labelledby':'shareTitle','aria-describedby':'shareNote'},
    el('div',{class:'share-sheet'},el('div',{class:'share-head'},el('div',{},el('span',{class:'section-kicker',text:'Share card'}),title),close),
      el('div',{class:'share-preview'},image,message),note,actions,status));
  close.addEventListener('click',closeDialog);
  buttons.share.addEventListener('click',onShare);
  buttons.download.addEventListener('click',onDownload);
  buttons.link.addEventListener('click',()=>void copy('link'));
  buttons.summary.addEventListener('click',()=>void copy('summary'));
  // A tap on the backdrop closes, as Escape does (the browser's own cancel).
  dialog.addEventListener('click',event=>{if(event.target===dialog)closeDialog()});
  dialog.addEventListener('close',cleanup);
  document.body.appendChild(dialog);
  ui={dialog,title,image,message,note,status,actions,buttons};
  return ui;
}
function setStatus(text,error=false){if(ui){ui.status.textContent=text;ui.status.className=error?'share-status error':'share-status'}}
function release(){if(current?.url)URL.revokeObjectURL(current.url)}
function cleanup(){generation++;const opener=current?.opener;release();current=null;opener?.focus?.()}
function closeDialog(){
  if(!ui)return;
  if(typeof ui.dialog.close==='function'&&ui.dialog.open)ui.dialog.close();else{ui.dialog.removeAttribute('open');cleanup()}
}
async function exportPng(card){
  if(document.fonts?.ready)await Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,1500))]);
  const canvas=document.createElement('canvas');canvas.width=CARD_WIDTH;canvas.height=CARD_HEIGHT;
  const ctx=canvas.getContext?.('2d');if(!ctx)throw new Error('this browser has no canvas drawing');
  drawCard(ctx,card);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('the PNG took too long to create')),EXPORT_TIMEOUT_MS);
    try{canvas.toBlob(blob=>{clearTimeout(timer);blob?resolve(blob):reject(new Error('the PNG could not be created'))},'image/png')}
    catch(error){clearTimeout(timer);reject(error)}
  });
}
async function openCard(contest,opener){
  const id=++generation,view=ensureDialog();
  release();current={contest,opener,card:null,url:null,file:null,support:null};
  view.title.textContent=TITLES[contest];view.image.hidden=true;view.image.removeAttribute('src');view.image.alt='';
  view.message.hidden=false;view.message.textContent='Preparing card…';view.note.textContent='';setStatus('');
  for(const button of Object.values(view.buttons)){button.disabled=true;button.hidden=false}
  view.buttons.download.className='share-action';view.actions.hidden=false;
  if(!view.dialog.open){if(typeof view.dialog.showModal==='function')view.dialog.showModal();else view.dialog.setAttribute('open','')}
  // The one snapshot of this card: everything below is built from it, whatever the page does next.
  const card=buildCard(contest,requestSnapshot(contest),{now:Date.now(),href:location.href});
  if(!card.ok){
    view.message.textContent=card.reason;view.actions.hidden=true;
    view.note.textContent='No card was made, so nothing misleading can be shared. The page keeps updating; try Share again in a moment.';
    return;
  }
  current.card=card;view.buttons.link.disabled=false;view.buttons.summary.disabled=false;
  view.note.textContent=`Snapshot ${card.snapshot}. The page keeps updating behind this preview; close and reopen Share for newer results.`;
  try{
    const blob=await exportPng(card);
    if(id!==generation)return;
    current.url=URL.createObjectURL(blob);
    try{current.file=new File([blob],card.fileName,{type:'image/png'})}catch{current.file=null}
    current.support=shareSupport(navigator,current.file);
    view.image.src=current.url;view.image.alt=card.alt;view.image.hidden=false;view.message.hidden=true;
    view.buttons.download.disabled=false;
    if(current.support.files)view.buttons.share.disabled=false;
    else{
      view.buttons.share.hidden=true;view.buttons.download.className='share-action primary';
      setStatus('This browser can’t share images directly. Download the PNG, or copy the link or the summary.');
    }
  }catch(error){
    if(id!==generation)return;
    view.message.textContent=`The image could not be created on this device (${error?.message||error}). You can still copy the link or the summary.`;
    view.buttons.share.hidden=true;view.buttons.download.hidden=true;
  }
}
// navigator.share is called in the tap itself, with the PNG already made, so the tap's user activation is never lost to a
// wait. Cancelling the share sheet only says so: nothing is downloaded or sent instead.
// One share at a time: the button waits for the sheet to close, so a second tap never starts a share the browser refuses.
function onShare(){
  const c=current,button=ui.buttons.share;if(!c?.file||!c.support?.files||button.disabled)return;
  let pending;
  setStatus('');button.disabled=true;
  try{pending=navigator.share(sharePayload(c.card,c.file,navigator))}catch(error){button.disabled=false;shareFailed(error);return}
  Promise.resolve(pending).then(()=>{if(current===c)setStatus('Shared.')},error=>{if(current!==c)return;if(error?.name==='AbortError')setStatus('Share canceled. Nothing was sent.');else shareFailed(error)})
    .finally(()=>{if(current===c)button.disabled=false});
}
function shareFailed(error){setStatus(`Sharing didn’t work here (${error?.message||error?.name||error}). Use Download PNG or Copy link instead.`,true)}
function onDownload(){
  const c=current;if(!c?.url)return;
  const link=el('a',{href:c.url,download:c.card.fileName,rel:'noopener',hidden:true});
  ui.dialog.appendChild(link);link.click();link.remove();
  setStatus(`Downloading ${c.card.fileName}.`);
}
async function copyText(value){
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);return true}}catch{}
  // The legacy copy command on a selected text area inside the dialog (the page behind a modal dialog cannot take focus).
  try{
    const area=el('textarea',{class:'share-copy',readonly:''});area.value=value;ui.dialog.appendChild(area);area.select();
    const ok=document.execCommand('copy')===true;area.remove();return ok;
  }catch{return false}
}
async function copy(kind){
  const c=current;if(!c?.card)return;
  const value=kind==='link'?c.card.link:c.card.summary,label=kind==='link'?'Link':'Summary',ok=await copyText(value);
  if(current!==c)return;
  if(ok)setStatus(`${label} copied.`);else setStatus(`Couldn’t copy automatically. Press and hold to copy the ${label.toLowerCase()}:\n${value}`,true);
}

for(const button of document.querySelectorAll('[data-share-card]')){
  const contest=button.dataset.shareCard;if(!TITLES[contest])continue;
  button.addEventListener('click',()=>void openCard(contest,button));
  button.hidden=false;
}
