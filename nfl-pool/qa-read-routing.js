// Isolated Personal QA preview transport. Admin pages do not include this script.
(function(){
  'use strict';
  const page=new URL(window.location.href);
  if(!page.hostname.endsWith('.vercel.app'))return;
  const auth='https://ep-silent-sunset-bbdqbm47.neonauth.c-15.us-east-1.aws.neon.tech/nfl_pool/auth/token/anonymous';
  const data='https://ep-silent-sunset-bbdqbm47.apirest.c-15.us-east-1.aws.neon.tech/nfl_pool/rest/v1/';
  const nativeFetch=window.fetch.bind(window);
  window.fetch=function(input,init){
    const request=input instanceof Request?input:null;
    if(String(init?.method||request?.method||'GET').toUpperCase()!=='GET')return nativeFetch(input,init);
    let url;try{url=new URL(request?.url||input,page)}catch{return nativeFetch(input,init)}
    const target=new URL('/api/qa-read',page);
    if(url.href===auth)target.searchParams.set('kind','anonymous');
    else if(url.href.startsWith(data)){
      const resource=url.pathname.slice(new URL(data).pathname.length);
      if(!/^nfl_(pool_weeks|survivor_weeks|contests|contest_policies|incident_rulings)$/.test(resource))return nativeFetch(input,init);
      target.search=url.search;target.searchParams.set('resource',resource);
    }else return nativeFetch(input,init);
    // No change to the scoring modules, signals or cache rules; only the protected read transport changes.
    return nativeFetch(request?new Request(target,request):target.href,init);
  };
})();
