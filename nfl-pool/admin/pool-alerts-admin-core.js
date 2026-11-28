// Pool Alerts Admin helpers with no browser or network dependency (unit-tested in nfl-pool/pool-alerts.test.mjs).
// The exact success messages the publishing pages show only after their read-back confirms the write.
export const VERIFIED_SUCCESS=[/^Week \d+ published and locked successfully\. Revision \d+\./,/^Official correction published and read-back verified as Week \d+ revision \d+\./,/^Correction did reach the database; confirmed by read-back\./];
export const isVerifiedSuccess=(className,text)=>/\bsuccess\b/.test(className||'')&&VERIFIED_SUCCESS.some(re=>re.test(text||''));

export function describeStatus(s){
  if(!s||typeof s!=='object')return['Status unavailable.'];
  const subs=s.subscriptions||{},del=s.deliveries30d||{},last=s.runs?.[0],n=s.notifications?.[0];
  const lines=[
    (s.sendingConfigured&&s.settings?.sending_enabled?'Sending is ON.':'Sending is PAUSED'+(s.sendingConfigured?' (database switch).':' (deployment switch).'))+' Enrollment: '+(s.settings?.enrollment_mode||'unknown')+'.',
    'Devices: '+(subs.active||0)+' active'+(subs.expired?', '+subs.expired+' expired':'')+'. Last 30 days: '+(del.sent||0)+' delivered, '+((del.failed||0)+(del.expired||0))+' failed, '+((del.pending||0)+(del.retry||0)+(del.sending||0))+' waiting.'
  ];
  if(n)lines.push('Latest alert: Week '+n.week+' revision '+n.revision+' ('+n.base_kind+') is '+n.status+': '+n.sent+' sent, '+n.pending+' waiting, '+n.failed+' failed.');
  if(last)lines.push('Last check: '+new Date(last.started_at).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})+' ('+last.trigger+', '+last.outcome+(last.error_class?', '+last.error_class:'')+').');
  if(s.captureGaps30d?.length)lines.push('Attention: '+s.captureGaps30d.length+' publication(s) were found by the hourly check instead of being recorded at publishing time. See the Pool Alerts runbook.');
  if(s.failures7d?.length)lines.push('Recent delivery problems: '+s.failures7d.map(f=>f.error+' ×'+f.n).join(', ')+'.');
  return lines;
}

