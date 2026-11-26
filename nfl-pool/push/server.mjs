import {identity,releaseDecision,validateSubscription,deliveryResult} from './core.mjs';
import {randomUUID,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function tx(pool,fn){
  const c=await pool.connect();
  try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result}
  catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
const rowIdentity=r=>({...r,published_at:new Date(r.published_at).toISOString()});
export async function publicLatest(authUrl,dataUrl,fetcher=fetch){
  const get=async(url,headers={})=>{const r=await fetcher(url,{headers:{Accept:'application/json',...headers},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Public read failed: '+r.status);return r.json()};
  const {token}=await get(authUrl+'/token/anonymous');
  if(typeof token!=='string'||!token)throw Error('Anonymous token unavailable');
  const rows=await get(dataUrl+'/nfl_pool_weeks?select=season,week,revision,status,published_at&status=eq.locked&order=season.desc,week.desc&limit=1',{Authorization:'Bearer '+token});
  if(!Array.isArray(rows)||rows.length!==1)throw Error('Public latest unavailable');
  identity(rows[0]);return rows[0];
}
// Dedicated sender credentials must have only SELECT on the publication identity and private alert-store access.
export async function detectRelease(pool,readPublic){
  const visible=await readPublic();
  return tx(pool,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(69271384)");
    const latest=(await c.query("SELECT season,week,revision,status,published_at FROM public.nfl_pool_weeks WHERE status='locked' ORDER BY season DESC,week DESC LIMIT 1")).rows[0];
    if(!latest)return 'empty';
    const prev=(await c.query("SELECT season,week,revision,published_at FROM pool_alerts.cursor WHERE singleton")).rows[0];
    const decision=releaseDecision(prev?rowIdentity(prev):null,rowIdentity(latest),visible);
    if(decision.action==='ignore')return 'ignore';
    const n=decision.next,args=[n.season,n.week,n.revision,n.published_at];
    if(decision.action==='enqueue'){
      await c.query("INSERT INTO pool_alerts.events(season,week,revision,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[...args.slice(0,3),decision.kind]);
      await c.query("INSERT INTO pool_alerts.deliveries(season,week,revision,subscription_id) SELECT $1,$2,$3,id FROM pool_alerts.subscriptions WHERE enabled AND ($4='release' OR corrections) ON CONFLICT DO NOTHING",[...args.slice(0,3),decision.kind]);
    }
    await c.query("INSERT INTO pool_alerts.cursor(singleton,season,week,revision,published_at) VALUES(true,$1,$2,$3,$4) ON CONFLICT(singleton) DO UPDATE SET season=EXCLUDED.season,week=EXCLUDED.week,revision=EXCLUDED.revision,published_at=EXCLUDED.published_at",args);
    return decision.action;
  });
}
// Enrollment is called only behind an independently rate-limited group invitation check.
// Never return endpoint keys in a response or log them.
export async function subscribe(pool,value,corrections=true){
  const s=validateSubscription(value),token=randomBytes(32).toString('base64url');
  const result=await pool.query("INSERT INTO pool_alerts.subscriptions(endpoint,p256dh,auth,manage_token_hash,corrections) VALUES($1,$2,$3,$4,$5) ON CONFLICT(endpoint) DO NOTHING RETURNING id",[s.endpoint,s.keys.p256dh,s.keys.auth,hash(token),corrections===true]);
  if(result.rowCount!==1)throw Error('Subscription already exists; use its existing management token');
  return {id:result.rows[0].id,token};
}
export async function changeSubscription(pool,id,token,{enabled,corrections}){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))return false;
  if(typeof enabled!=='boolean'||typeof corrections!=='boolean')return false;
  return tx(pool,async c=>{
    const row=(await c.query("SELECT manage_token_hash FROM pool_alerts.subscriptions WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(!row||!equal(hash(token),row.manage_token_hash))return false;
    await c.query("UPDATE pool_alerts.subscriptions SET enabled=$2,corrections=$3 WHERE id=$1",[id,enabled,corrections]);
    await c.query("UPDATE pool_alerts.deliveries d SET state='cancelled',lease_token=NULL,lease_until=NULL FROM pool_alerts.events e WHERE d.subscription_id=$1 AND (d.season,d.week,d.revision)=(e.season,e.week,e.revision) AND d.state IN ('pending','retry','sending') AND (NOT $2 OR (NOT $3 AND e.kind='correction'))",[id,enabled,corrections]);
    return true;
  });
}
export async function deliverOne(pool,send){
  const lease=randomUUID();
  const job=await tx(pool,async c=>{
    // Expired leases may have sent before a crash; clients use a stable notification tag.
    await c.query("UPDATE pool_alerts.deliveries SET state='failed',lease_token=NULL,lease_until=NULL WHERE state='sending' AND lease_until<=now() AND attempts>=6");
    const d=(await c.query("SELECT d.*,e.kind FROM pool_alerts.deliveries d JOIN pool_alerts.events e USING(season,week,revision) JOIN pool_alerts.subscriptions s ON s.id=d.subscription_id WHERE s.enabled AND (e.kind='release' OR s.corrections) AND d.attempts<6 AND ((d.state IN ('pending','retry') AND d.next_attempt_at<=now()) OR (d.state='sending' AND d.lease_until<=now())) ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED")).rows[0];
    if(!d)return null;
    await c.query("UPDATE pool_alerts.deliveries SET state='sending',attempts=attempts+1,lease_token=$5,lease_until=now()+interval '2 minutes' WHERE season=$1 AND week=$2 AND revision=$3 AND subscription_id=$4",[d.season,d.week,d.revision,d.subscription_id,lease]);
    return {...d,attempts:d.attempts+1};
  });
  if(!job)return false;
  const args=[job.season,job.week,job.revision,job.subscription_id,lease];
  const sub=(await pool.query("SELECT s.endpoint,s.p256dh,s.auth FROM pool_alerts.subscriptions s JOIN pool_alerts.deliveries d ON d.subscription_id=s.id WHERE d.season=$1 AND d.week=$2 AND d.revision=$3 AND s.id=$4 AND d.lease_token=$5 AND d.state='sending' AND s.enabled AND ($6='release' OR s.corrections)",[...args,job.kind])).rows[0];
  if(!sub)return true;
  let status=0;
  try{const target=validateSubscription({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}});const result=await send(target,{season:job.season,week:job.week,revision:job.revision,kind:job.kind});status=result.statusCode}
  catch(e){status=Number.isInteger(e?.statusCode)?e.statusCode:0}
  const result=deliveryResult(status,job.attempts);
  await tx(pool,async c=>{
    const changed=await c.query("UPDATE pool_alerts.deliveries SET state=$6,next_attempt_at=now()+make_interval(secs=>$7),lease_token=NULL,lease_until=NULL WHERE season=$1 AND week=$2 AND revision=$3 AND subscription_id=$4 AND lease_token=$5 AND state='sending'",[...args,result.state,result.delaySeconds||0]);
    if(changed.rowCount&&result.state==='expired'){
      await c.query("UPDATE pool_alerts.subscriptions SET enabled=false WHERE id=$1",[job.subscription_id]);
      await c.query("UPDATE pool_alerts.deliveries SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE subscription_id=$1 AND state IN ('pending','retry','sending')",[job.subscription_id]);
    }
  });
  return true;
}
