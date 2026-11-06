// QA ONLY (PR #29). Local static server for the browser acceptance: serves the committed nfl-pool/ files under /nfl-pool/
// exactly like the Vercel rewrites (/nfl-pool/ -> index.html, /nfl-pool/admin/ -> admin/index.html), and runs the committed
// protected QA schedule function api/qa-schedule.js (read-only ESPN scoreboard GET, season 2026 only) at /api/qa-schedule,
// the publishers' designed fallback when the browser's direct ESPN request fails. ESPN's edge answers 403 without CORS
// headers to the HeadlessChrome user agent, so the runner's browser identity is left unchanged and the app's own fallback is
// exercised instead. No other API route, no credentials, no Neon access; it binds to 127.0.0.1 only.
// Usage: node local-server.mjs <port>
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname,join,normalize,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const qaSchedule=(await import(new URL('../../../api/qa-schedule.js',import.meta.url))).default;
const root=fileURLToPath(new URL('../../../',import.meta.url));
const port=Number(process.argv[2]||8765);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(url.pathname==='/api/qa-schedule'){
    // Vercel-style request/response adapter around the unmodified committed function.
    const shim={statusCode:200,setHeader:(k,v)=>res.setHeader(k,v),status(code){this.statusCode=code;return this},json(body){res.writeHead(this.statusCode,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));return this}};
    return qaSchedule({method:req.method,query:Object.fromEntries(url.searchParams),headers:req.headers},shim);
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end()}
  let path=decodeURIComponent(url.pathname);
  if(path==='/'||path==='/nfl-pool'){res.writeHead(302,{Location:'/nfl-pool/'});return res.end()}
  if(!path.startsWith('/nfl-pool/')){res.writeHead(404);return res.end('not found')}
  path=path.slice('/nfl-pool'.length);
  if(path.endsWith('/'))path+='index.html';
  const file=normalize(join(root,path));
  if(!file.startsWith(root)||file.split(sep).some(p=>p.startsWith('.')&&p.length>1)||file.includes(`${sep}acceptance${sep}`)){res.writeHead(404);return res.end('not found')}
  try{
    if(!(await stat(file)).isFile())throw new Error('not a file');
    const body=await readFile(file);
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});
    res.end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(404);res.end('not found')}
}).listen(port,'127.0.0.1',()=>console.log(`QA static server on http://localhost:${port}/nfl-pool/ (root ${root})`));
