// Standalone sender; deploy only on an isolated target first. No credentials in source.
import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import pg from 'pg';
import webpush from 'web-push';
import {publicLatest,detectRelease,subscribe,changeSubscription,deliverOne} from './server.mjs';
const env=process.env;
for(const k of ['DATABASE_URL','NEON_AUTH_URL','NEON_DATA_URL','APP_ORIGIN','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT','ENROLLMENT_CODE','EXPECTED_DATABASE'])if(!env[k])throw Error('Missing required setting: '+k);
if(env.ENROLLMENT_CODE.length<20)throw Error('Enrollment code too short');
const origin=new URL(env.APP_ORIGIN);
if(origin.protocol!=='https:'||origin.origin!==env.APP_ORIGIN)throw Error('APP_ORIGIN must be exact HTTPS origin');
for(const k of ['NEON_AUTH_URL','NEON_DATA_URL']){
  const u=new URL(env[k]);if(u.protocol!=='https:'||!u.hostname.endsWith('.neon.tech')||u.username||u.password)throw Error('Invalid Neon endpoint');
}
if(env.PUSH_ENABLED!=='true')throw Error('Sender disabled; explicit PUSH_ENABLED required');
const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:5,connectionTimeoutMillis:5000,statement_timeout:10000});
const guard=await pool.query('SELECT current_database() AS db');
if(guard.rows[0].db!==env.EXPECTED_DATABASE)throw Error('Database guard mismatch');
await pool.query('SELECT 1 FROM pool_alerts.cursor LIMIT 1');
webpush.setVapidDetails(env.VAPID_SUBJECT,env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY);
const digest=s=>createHash('sha256').update(s).digest();
const codeOK=s=>typeof s==='string'&&s.length<=256&&timingSafeEqual(digest(s),digest(env.ENROLLMENT_CODE));
const respond=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
const buckets=new Map();
function allowed(ip){
  const now=Date.now();for(const [k,v] of buckets)if(v.until<now)buckets.delete(k);
  const b=buckets.get(ip)||{count:0,until:now+60000};
  if(b.count>=15||(!buckets.has(ip)&&buckets.size>=2000))return false;
  b.count++;buckets.set(ip,b);return true;
}
async function body(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('Content type');
  let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>8192)throw Error('Request too large');chunks.push(chunk)}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Invalid body');return result;
}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.headers.origin!==origin.origin)return respond(res,403,{error:'Origin not allowed'});
    res.setHeader('Access-Control-Allow-Origin',origin.origin);res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
    if(req.method==='GET'&&req.url==='/v1/config')return respond(res,200,{publicKey:env.VAPID_PUBLIC_KEY});
    if(req.method!=='POST'||!['/v1/subscribe','/v1/preferences'].includes(req.url))return respond(res,404,{error:'Not found'});
    if(!allowed(req.socket.remoteAddress||'unknown'))return respond(res,429,{error:'Try again later'});
    const value=await body(req);
    if(req.url==='/v1/subscribe'){
      if(!codeOK(value.code))return respond(res,403,{error:'Invalid invitation'});
      return respond(res,201,await subscribe(pool,value.subscription,value.corrections));
    }
    if(!await changeSubscription(pool,value.id,value.token,value))return respond(res,403,{error:'Invalid subscription'});
    return respond(res,200,{ok:true});
  }catch(e){return respond(res,400,{error:'Request could not be completed'})}
});
server.requestTimeout=15000;server.headersTimeout=10000;
let running=false;
async function tick(){
  if(running)return;running=true;
  try{
    try{await detectRelease(pool,()=>publicLatest(env.NEON_AUTH_URL,env.NEON_DATA_URL))}catch{console.error('Release verification failed; no new events queued')}
    for(let i=0;i<100;i++){if(!await deliverOne(pool,(sub,payload)=>webpush.sendNotification(sub,JSON.stringify(payload),{TTL:86400,timeout:15000,urgency:'normal'})))break}
  }catch{console.error('Delivery cycle failed')}finally{running=false}
}
server.listen(Number(env.PORT||8080),()=>{console.log('Pool Alerts sender listening');void tick()});
setInterval(tick,30000).unref();
