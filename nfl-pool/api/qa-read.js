// Personal PR previews only. Fixed isolated QA backend, anonymous RLS reads, no caller credentials or writes.
import {PUBLIC_COLUMNS} from '../contest-rulings.js';

// QA ONLY (PR #29): reads come from the authorized isolated QA child branch br-damp-credit-bbn7d0zr (endpoint
// ep-shiny-snow-bbx446zt), never its QA parent or production. The module refuses to load with any other backend.
const BACKEND='ep-shiny-snow-bbx446zt';
const AUTH='https://ep-shiny-snow-bbx446zt.neonauth.c-15.us-east-1.aws.neon.tech/nfl_pool/auth';
const DATA='https://ep-shiny-snow-bbx446zt.apirest.c-15.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const REFUSED_BACKENDS=['ep-muddy-forest-au7eygkw','ep-silent-sunset-bbdqbm47'];
for(const url of [AUTH,DATA]){
  const host=new URL(url).hostname;
  if(!host.startsWith(BACKEND+'.')||REFUSED_BACKENDS.some(id=>host.includes(id)))throw new Error('qa_read_backend_refused');
}
const PUBLICATION=['season','week','status','revision','published_at','config'];
const RESOURCES={
  nfl_pool_weeks:PUBLICATION,nfl_survivor_weeks:PUBLICATION,
  nfl_contests:PUBLIC_COLUMNS.contests,nfl_contest_policies:PUBLIC_COLUMNS.policies,
  nfl_incident_rulings:PUBLIC_COLUMNS.rulings
};
const KEYS=new Set(['resource','select','season','week','status','order','contest_id']);
const numericFilter=(value,key)=>{
  const match=/^(eq|lte)\.(\d+)$/.exec(value);
  return !!match&&(key==='season'?match[1]==='eq'&&Number(match[2])===2026:Number(match[2])>=1&&Number(match[2])<=18);
};

export function createQaReadHandler({fetchImpl=(...args)=>fetch(...args),environment=()=>process.env.VERCEL_ENV}={}){
  return async function handler(req,res){
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-QA-Read-Only','1');
    if(environment()!=='preview'||!String(req.headers?.host||'').endsWith('.vercel.app'))
      return res.status(404).json({error:'qa_preview_only'});
    if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({error:'method_not_allowed'})}
    const url=new URL(req.url,'https://preview.invalid'),params=url.searchParams;
    if(url.search.length>4096||[...params.keys()].some((k,i,all)=>all.indexOf(k)!==i))
      return res.status(400).json({error:'invalid_query'});
    const anonymous=params.get('kind')==='anonymous'&&params.size===1;
    let target=null;
    if(!anonymous){
      const resource=params.get('resource'),columns=Object.hasOwn(RESOURCES,resource||'')?RESOURCES[resource]:null;
      const selection=params.get('select')?.split(',');
      if(!columns||!selection?.length||selection.some(c=>!columns.includes(c))||[...params.keys()].some(k=>!KEYS.has(k)))
        return res.status(400).json({error:'invalid_public_read'});
      for(const [key,value] of params){
        if(['season','week'].includes(key)&&!numericFilter(value,key))return res.status(400).json({error:'invalid_context'});
        if(key==='status'&&value!=='eq.locked')return res.status(400).json({error:'published_only'});
        if(key==='contest_id'&&!/^eq\.pool-center-2026-(pickem|survivor)$/.test(value))return res.status(400).json({error:'invalid_contest'});
        if(key==='order'&&!value.split(',').every(x=>/^(season|week|revision|chain_seq)\.(asc|desc)$/.test(x)))
          return res.status(400).json({error:'invalid_order'});
      }
      if(!resource.endsWith('_weeks')&&!params.has('contest_id'))return res.status(400).json({error:'contest_required'});
      target=new URL(DATA+'/'+resource);
      for(const [key,value] of params)if(key!=='resource')target.searchParams.set(key,value);
      if(resource.endsWith('_weeks')){
        target.searchParams.set('status','eq.locked');
        target.searchParams.set('season','eq.2026');
      }
    }
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
    try{
      // Always acquire the existing anonymous role. Never forward a caller's cookies, JWT, API key or Origin.
      const auth=await fetchImpl(AUTH+'/token/anonymous',{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
      if(!auth.ok)throw new Error('qa_auth_unavailable');
      const token=(await auth.json())?.token;
      if(typeof token!=='string'||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(token))throw new Error('qa_auth_invalid');
      if(anonymous)return res.status(200).json({token});
      const response=await fetchImpl(target.href,{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',Authorization:'Bearer '+token}});
      if(!response.ok)throw new Error('qa_data_http_'+response.status);
      const rows=await response.json();
      if(!Array.isArray(rows))throw new Error('qa_data_invalid');
      res.setHeader('X-QA-Backend',BACKEND);
      return res.status(200).json(rows);
    }catch(error){
      const code=error?.name==='AbortError'?'qa_read_timeout':/^qa_(auth|data)_[-\w]+$/.test(error?.message||'')?error.message:'qa_read_failed';
      return res.status(code==='qa_read_timeout'?504:502).json({error:code});
    }finally{clearTimeout(timeout)}
  };
}

export default createQaReadHandler();
