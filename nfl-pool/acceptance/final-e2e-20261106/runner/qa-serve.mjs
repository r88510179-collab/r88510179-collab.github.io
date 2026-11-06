// QA ONLY — final Personal Pool E2E acceptance harness (2026-11-06). Never deploy; never point at production.
//
// Serves the repository's own nfl-pool/ files at http://localhost:8765/nfl-pool/ (the GitHub Pages path), unchanged except
// for an exact, counted substitution table that retargets the three production bindings to the isolated QA child:
//   * Neon Auth / Data API  ep-muddy-forest-au7eygkw (production)  ->  ep-shiny-snow-bbx446zt (QA child br-damp-credit-bbn7d0zr)
//   * publisher identity    the production publisher email        ->  qa.pdf-e2e.publisher@example.com (synthetic)
//   * score gateway         production nflscores2 Function         ->  /__qa-nflscores2/ on this server, which runs the
//                           repository's own gateway source (score-proxy/index.mjs, createHandler) against the real ESPN API
// Fail-closed rules: a substitution whose occurrence count differs from the table refuses the file (HTTP 500); any served
// text that still names a production or QA-parent host or the production identity is refused (HTTP 500); paths outside
// nfl-pool/, dotfiles and the acceptance/ folder are 404; only GET/HEAD. Binds to 127.0.0.1 only. Holds no credentials.
// Every request and every substitution (original and served SHA-256) is appended to a JSONL log.
// Usage: NODE_USE_ENV_PROXY=1 node qa-serve.mjs <log.jsonl> [port]
import {createServer} from 'node:http';
import {readFile,stat,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {extname,join,normalize,sep,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));          // .../nfl-pool/
const logFile=process.argv[2];
const port=Number(process.argv[3]||8765);
if(!logFile)throw new Error('usage: node qa-serve.mjs <log.jsonl> [port]');
if(port!==8765)throw new Error('the QA child Data API CORS allowlist names http://localhost:8765 only');
const ORIGIN=`http://localhost:${port}`;

const PROD_AUTH='https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth';
const PROD_DATA='https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const QA_AUTH='https://ep-shiny-snow-bbx446zt.neonauth.c-15.us-east-1.aws.neon.tech/nfl_pool/auth';
const QA_DATA='https://ep-shiny-snow-bbx446zt.apirest.c-15.us-east-1.aws.neon.tech/nfl_pool/rest/v1';
const QA_EMAIL='qa.pdf-e2e.publisher@example.com';
// The production publisher identity is read from the committed publisher at startup, so this harness and its logs never
// carry a real person's address; logs name every substituted value by label only.
const PROD_EMAIL=(await readFile(new URL('../../../admin/admin.js',import.meta.url),'utf8')).match(/const ADMIN_EMAIL='([^']+)';/)?.[1];
if(!PROD_EMAIL||PROD_EMAIL===QA_EMAIL)throw new Error('could not read the production publisher identity from admin/admin.js');
const PROD_GATEWAY='https://br-late-hat-b55ygmj4-nflscores2.compute.c-7.us-east-2.aws.neon.tech/';
const LOCAL_GATEWAY=`${ORIGIN}/__qa-nflscores2/`;
const AUTH=['production Neon Auth URL',PROD_AUTH,'QA child Neon Auth URL',QA_AUTH];
const DATA=['production Data API URL',PROD_DATA,'QA child Data API URL',QA_DATA];
const IDENTITY=['production publisher identity constant',`ADMIN_EMAIL='${PROD_EMAIL}'`,'synthetic QA publisher identity constant',`ADMIN_EMAIL='${QA_EMAIL}'`];
const SHOWN=['production publisher address shown on the page',PROD_EMAIL,'synthetic QA publisher address',QA_EMAIL];
const GATEWAY=['production nflscores2 gateway URL',PROD_GATEWAY,'local instance of score-proxy/index.mjs',LOCAL_GATEWAY];

// file (relative to nfl-pool/) -> [fromLabel, from, toLabel, to, exact expected occurrence count]
const SUBSTITUTIONS={
  'weekly-app.js':[[...AUTH,1],[...DATA,1]],
  'survivor-app.js':[[...AUTH,1],[...DATA,1]],
  'season-record.js':[[...AUTH,1],[...DATA,1]],
  'admin/admin.js':[[...AUTH,1],[...DATA,1],[...IDENTITY,1]],
  'admin/survivor-admin.js':[[...AUTH,1],[...DATA,1],[...IDENTITY,1]],
  'admin/index.html':[[...SHOWN,1]],
  'admin/survivor.html':[[...SHOWN,1]],
  'score-feed-proxy.js':[[...GATEWAY,1]]
};
// Never present in anything this server sends to the browser: [label, marker].
const FORBIDDEN_MARKERS=[['production Neon endpoint','ep-muddy-forest-au7eygkw'],['QA parent endpoint','ep-silent-sunset-bbdqbm47'],['production score gateway','br-late-hat-b55ygmj4-nflscores2.compute'],['production publisher identity',PROD_EMAIL],['legacy Supabase function','txbrowtmemwldywdpgiy.supabase.co']];

const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
const TEXT=new Set(['.html','.js','.mjs','.css','.json','.webmanifest','.svg']);
const sha=b=>createHash('sha256').update(b).digest('hex');
const log=entry=>appendFile(logFile,JSON.stringify({t:new Date().toISOString(),...entry})+'\n');
const count=(text,needle)=>text.split(needle).length-1;

// The repository's own score gateway source, unmodified, with the real ESPN upstream (Node fetch via the egress proxy).
const gateway=(await import(new URL('../../../score-proxy/index.mjs',import.meta.url))).createHandler();

function serveText(rel,body){
  let text=body.toString('utf8');
  const rules=SUBSTITUTIONS[rel]||[];
  const applied=[];
  for(const [fromLabel,from,toLabel,to,expected] of rules){
    const found=count(text,from);
    if(found!==expected)return{refusal:`substitution count of the ${fromLabel} in ${rel} is ${found}, expected ${expected}`};
    text=text.split(from).join(to);applied.push({from:fromLabel,to:toLabel,count:found});
  }
  const leaked=FORBIDDEN_MARKERS.filter(([,marker])=>text.includes(marker)).map(([label])=>label);
  if(leaked.length)return{refusal:`${rel} still contains forbidden marker(s): ${leaked.join(', ')}`};
  return{text,applied};
}

createServer(async(req,res)=>{
  const url=new URL(req.url,ORIGIN);
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const done=(status,extra={})=>log({method:req.method,path:url.pathname,query:url.search||undefined,status,...extra});
  try{
    if(url.pathname==='/__qa-nflscores2/'||url.pathname==='/__qa-nflscores2'){
      const headers=new Headers();
      for(const [k,v] of Object.entries(req.headers))if(typeof v==='string')headers.set(k,v);
      // Same-origin request on this harness; the deployed gateway sees a cross-origin request from the Pages origin instead.
      if(headers.get('origin')===ORIGIN)headers.delete('origin');
      const response=await gateway(new Request(url.href,{method:req.method,headers}));
      const body=Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(body);
      return done(response.status,{gateway:true,bytes:body.length});
    }
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return done(405)}
    let path=decodeURIComponent(url.pathname);
    if(path==='/'||path==='/nfl-pool'){res.writeHead(302,{Location:'/nfl-pool/'});res.end();return done(302)}
    if(!path.startsWith('/nfl-pool/')){res.writeHead(404);res.end('not found');return done(404)}
    path=path.slice('/nfl-pool'.length);
    if(path.endsWith('/'))path+='index.html';
    const file=normalize(join(root,path)),rel=relative(root,file).split(sep).join('/');
    if(!file.startsWith(root)||rel.split('/').some(p=>p.startsWith('.'))||rel.startsWith('acceptance/')){res.writeHead(404);res.end('not found');return done(404)}
    if(!(await stat(file)).isFile())throw Object.assign(new Error('not a file'),{code:'ENOENT'});
    const body=await readFile(file),ext=extname(file);
    if(TEXT.has(ext)){
      const out=serveText(rel,body);
      if(out.refusal){res.writeHead(500,{'Content-Type':'text/plain'});res.end('QA harness refused: '+out.refusal);return done(500,{refusal:out.refusal})}
      const served=Buffer.from(out.text,'utf8');
      res.writeHead(200,{'Content-Type':types[ext]||'text/plain'});res.end(req.method==='HEAD'?undefined:served);
      return done(200,out.applied.length?{file:rel,originalSha256:sha(body),servedSha256:sha(served),substitutions:out.applied.map(a=>({from:a.from,to:a.to,count:a.count}))}:{file:rel,sha256:sha(body)});
    }
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:body);
    return done(200,{file:rel,sha256:sha(body)});
  }catch(e){
    if(e?.code==='ENOENT'){res.writeHead(404);res.end('not found');return done(404)}
    res.writeHead(500);res.end('error');return done(500,{error:String(e?.message||e)});
  }
}).listen(port,'127.0.0.1',()=>console.log(`QA harness on ${ORIGIN}/nfl-pool/ (root ${root})`));
