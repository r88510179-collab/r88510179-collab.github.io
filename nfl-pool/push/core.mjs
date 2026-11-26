// Pure Personal Pool push policy. No database writes or network access here.
export function identity(row){
  if(!row||row.status!=='locked'||!Number.isInteger(row.season)||row.season<2000||row.season>2100||!Number.isInteger(row.week)||row.week<1||row.week>18||!Number.isSafeInteger(row.revision)||row.revision<1||typeof row.published_at!=='string'||!Number.isFinite(Date.parse(row.published_at)))throw Error('Invalid published identity');
  return {season:row.season,week:row.week,revision:row.revision,published_at:new Date(row.published_at).toISOString()};
}
export const key=x=>[x.season,x.week,x.revision].join(':');
export function releaseDecision(previous,row,publicRow){
  const next=identity(row),verified=identity(publicRow);
  if(key(next)!==key(verified)||next.published_at!==verified.published_at)throw Error('Public revision not confirmed');
  if(previous===null)return {action:'baseline',next};
  const order=next.season-previous.season||next.week-previous.week||next.revision-previous.revision;
  if(order<=0)return {action:'ignore',next:previous};
  const kind=next.season===previous.season&&next.week===previous.week?'correction':'release';
  return {action:'enqueue',next,kind,payload:{season:next.season,week:next.week,revision:next.revision,kind}};
}
export function validateSubscription(value){
  if(!value||typeof value.endpoint!=='string'||value.endpoint.length>2048)throw Error('Invalid endpoint');
  const u=new URL(value.endpoint);
  const allowed=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','notify.windows.com'];
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!allowed.some(h=>u.hostname===h|| (h==='notify.windows.com'&&u.hostname.endsWith('.'+h))))throw Error('Unsupported push provider');
  if(!u.pathname||u.pathname==='/')throw Error('Invalid push path');
  const keys=value.keys;
  for(const [name,length] of [['p256dh',65],['auth',16]]){
    if(typeof keys?.[name]!=='string'||!/^[A-Za-z0-9_-]+$/.test(keys[name]))throw Error('Invalid push key');
    const bytes=Buffer.from(keys[name],'base64url');
    if(bytes.length!==length||bytes.toString('base64url')!==keys[name]||(name==='p256dh'&&bytes[0]!==4))throw Error('Invalid push key');
  }
  return {endpoint:u.href,keys:{p256dh:keys.p256dh,auth:keys.auth}};
}
export function deliveryResult(status,attempt){
  if(status>=200&&status<300)return {state:'sent'};
  if(status===404||status===410)return {state:'expired'};
  if(attempt<6&&(status===0||status===429||status>=500))return {state:'retry',delaySeconds:Math.min(3600,30*2**Math.max(0,attempt-1))};
  return {state:'failed'};
}
