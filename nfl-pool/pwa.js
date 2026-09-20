'use strict';
let deferredInstallPrompt=null;
const installButtons=()=>[...document.querySelectorAll('[data-install-app]')];
function standalone(){return window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true}
function syncInstallUi(){
  const ready=!!deferredInstallPrompt&&!standalone();
  installButtons().forEach(btn=>{btn.hidden=!ready;btn.disabled=!ready});
  document.documentElement.classList.toggle('standalone',standalone());
}
window.addEventListener('beforeinstallprompt',event=>{
  event.preventDefault();
  deferredInstallPrompt=event;
  syncInstallUi();
});
document.addEventListener('click',async event=>{
  const btn=event.target.closest('[data-install-app]');
  if(!btn||!deferredInstallPrompt)return;
  btn.disabled=true;
  try{
    await deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
  }finally{
    deferredInstallPrompt=null;
    syncInstallUi();
  }
});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;syncInstallUi()});
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('/nfl-pool/service-worker.js',{scope:'/nfl-pool/'}).catch(err=>console.warn('Pool Center service worker registration failed',err)));
}
syncInstallUi();
