// Serves a built commercial frontend (dist/ by default) for local browser checks at http://localhost:<port>/ only.
// Neon Auth trusts the hostname localhost, not 127.0.0.1, so a request naming any other Host is refused instead of
// being served from an origin the live sign-in would reject. It listens on loopback only: 127.0.0.1 and, where the
// machine has it, ::1, so "localhost" answers whichever family a browser, curl or adb reverse tries first.
// Every response carries the Content-Security-Policy the pages are built for, with connect-src limited to this
// build's own Auth and Data API origins. Service-Worker-Allowed is never sent, and the log shows paths without
// query strings, because invite links carry tokens.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {contentSecurityPolicy,parseRuntimeConfig} from './runtime-config.mjs';

export const DEFAULT_PORT=4173;
const APP_DIR=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const TYPES={
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8'
};

function listen(server,port,host){
  return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,host,()=>{server.off('error',reject);resolve()});
  });
}

export async function startServer({dir=path.join(APP_DIR,'dist'),port=DEFAULT_PORT,log=console.log}={}){
  let root,config;
  try{
    root=fs.realpathSync(dir);
    config=parseRuntimeConfig(fs.readFileSync(path.join(root,'platform-config.js'),'utf8'));
  }catch(error){
    throw new Error(`${dir} is not a commercial build (${error.message}); run npm run build first`);
  }
  const csp=contentSecurityPolicy(config);
  let host='';
  const handler=(req,res)=>{
    // Origin-form request targets only ("/path?query"), parsed so that "//x" stays a path and never becomes a host.
    let url;
    try{url=req.url.startsWith('/')?new URL(`http://localhost${req.url}`):null}catch{url=null}
    const reply=(status,headers={},body='')=>{
      res.writeHead(status,{
        'content-security-policy':csp,'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
        'cache-control':'no-cache',...headers
      });
      res.end(req.method==='HEAD'?undefined:body);
      log(`${req.method} ${url?url.pathname:'(unparseable)'} ${status}`);
    };
    if(req.headers.host!==host){
      reply(421,{'content-type':'text/plain; charset=utf-8'},`Open http://${host}/ instead: the live sign-in trusts the hostname localhost only.\n`);
      return;
    }
    if(req.method!=='GET'&&req.method!=='HEAD'){reply(405,{allow:'GET, HEAD'});return}
    let name;
    try{name=decodeURIComponent(url.pathname)}catch{reply(404);return}
    if(name==='/')name='/index.html';
    const segments=name.slice(1).split('/');
    if(segments.some(s=>s===''||s==='.'||s==='..'||s.includes('\\')||s.includes('\0'))||!TYPES[path.extname(name)]){reply(404);return}
    // root is already a real path, so any symbolic link on the way changes the real path and is refused. Any
    // filesystem error (missing, removed meanwhile, unreadable) is a 404, never a crashed server.
    const file=path.join(root,...segments);
    let body=null;
    try{if(fs.realpathSync(file)===file&&fs.statSync(file).isFile())body=fs.readFileSync(file)}catch{body=null}
    if(body===null){reply(404);return}
    reply(200,{'content-type':TYPES[path.extname(name)]},body);
  };
  // 127.0.0.1 first (port 0 picks a free port), then ::1 on the same port when the machine has IPv6 loopback.
  const servers=[http.createServer(handler)];
  await listen(servers[0],port,'127.0.0.1');
  const actualPort=servers[0].address().port;
  host=`localhost:${actualPort}`;
  const v6=http.createServer(handler);
  try{await listen(v6,actualPort,'::1');servers.push(v6)}catch{}
  return{
    url:`http://${host}/`,port:actualPort,config,csp,root,
    close:()=>Promise.all(servers.map(server=>new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections()})))
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--dir'&&args[i+1])options.dir=args[++i];
    else if(args[i]==='--port'&&/^\d+$/.test(args[i+1]??''))options.port=Number(args[++i]);
    else{console.error(`Unknown argument: ${args[i]} (usage: node scripts/serve.mjs [--dir <build>] [--port <n>])`);process.exit(2)}
  }
  try{
    const {url,config,csp,root}=await startServer(options);
    console.log(`Serving the ${config.mode} build in ${root} at ${url}`);
    console.log('Open exactly that URL: the hostname must be localhost (not 127.0.0.1). Stop with Ctrl+C.');
    console.log(`Content-Security-Policy: ${csp}`);
  }catch(error){
    console.error(`Cannot serve: ${error.message}`);
    process.exitCode=1;
  }
}
