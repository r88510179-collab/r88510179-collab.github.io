import React,{useState} from "react";
import {DUES_KINDS,validateDuesEntry} from "./dues.mjs";

const currency=cents=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);

export default function LiveDuesPanel({pool,entries,loaded,gateway,onEnabledChange,onRecorded}) {
  const [enableBusy,setEnableBusy]=useState(false);
  const [busyEntry,setBusyEntry]=useState(null);
  const [drafts,setDrafts]=useState({});
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const authorized=pool.permissions?.record_dues===true;
  if(!authorized) return <section className="panel">
    <h3>Optional dues log</h3>
    <p className="subtle">This log is only available to commissioners with dues-recording access.</p>
  </section>;
  const totalPaid=entries.reduce((sum,x)=>sum+(x.initialPaid||0),0);
  const totalBalance=entries.reduce((sum,x)=>sum+(Number.isSafeInteger(x.balanceOverride)?x.balanceOverride:(x.charge-x.initialPaid)),0);
  async function updateEnabled(next) {
    if(enableBusy||pool.permissions?.edit_rules!==true)return;
    setEnableBusy(true);setError("");setNotice("");
    try {
      await gateway.setDuesEnabled(pool.id,next);
      await onEnabledChange(next);
      setNotice(next?"Dues log enabled. No payments are collected here.":"Dues log hidden. Existing records are retained.");
    }catch(e){setError(e.message||"Could not update dues settings");}
    finally{setEnableBusy(false);}
  }
  function updateDraft(entryId,key,value){setDrafts(old=>({...old,[entryId]:{kind:"charge",amount:"",note:"",...old[entryId],[key]:value}}));}
  async function save(entryId) {
    if(busyEntry)return;
    setError("");setNotice("");
    let record;
    try{record=validateDuesEntry({entryId,...{kind:"charge",amount:"",note:"",...drafts[entryId]}});}
    catch(e){setError(e.message);return;}
    setBusyEntry(entryId);let written=false;
    try{
      await gateway.recordDuesEvent(record);
      written=true;
      await onRecorded();
      setDrafts(old=>({...old,[entryId]:{kind:"charge",amount:"",note:""}}));
      setNotice("Bookkeeping entry saved. No money was collected by this app.");
    }catch(e){
      setError(written
        ?"The entry was saved, but totals could not refresh. Reload before recording it again."
        :(e.message||"Could not record this entry"));
    }finally{setBusyEntry(null);}
  }
  return <section className="panel">
    <h3>Dues log</h3>
    <p className="subtle">A private record of contributions and payments managed by your pool organizer outside this app. No checkout or transfers.</p>
    <label className="toggle-row">
      <span><b>Use a dues log for this pool</b><small>This setting affects only this pool.</small></span>
      <input aria-label="Enable optional dues log" type="checkbox" checked={pool.duesTrackingEnabled===true}
        disabled={enableBusy||pool.permissions?.edit_rules!==true}
        onChange={e=>updateEnabled(e.target.checked)} />
    </label>
    {pool.duesTrackingEnabled===true&&(!loaded?<p className="subtle" role="status">Loading ledger records…</p>:<>
      <div className="metric-grid two">
        <div className="metric"><span>Recorded as paid externally</span><strong>{currency(totalPaid)}</strong></div>
        <div className="metric"><span>Outstanding balance</span><strong>{currency(totalBalance)}</strong></div>
      </div>
      <div className="entry-list">{entries.map(entry=>{
        const draft={kind:"charge",amount:"",note:"",...drafts[entry.id]};
        const balance=Number.isSafeInteger(entry.balanceOverride)?entry.balanceOverride:entry.charge-entry.initialPaid;
        return <div className="dues-entry" key={entry.id}>
          <div className="dues-head"><strong>{entry.name}</strong>
            <span className="chip">{currency(balance)} balance</span>
          </div>
          <div className="dues-form-grid">
            <label className="field"><span>Entry type</span><select value={draft.kind} disabled={!!busyEntry}
              onChange={e=>updateDraft(entry.id,"kind",e.target.value)}>
              {DUES_KINDS.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}
            </select></label>
            <label className="field"><span>Amount ($)</span><input type="text" inputMode="decimal"
              placeholder="0.00" value={draft.amount} disabled={!!busyEntry}
              onChange={e=>updateDraft(entry.id,"amount",e.target.value)}/></label>
          </div>
          <label className="field"><span>Optional note</span><input type="text" maxLength={250}
            value={draft.note} disabled={!!busyEntry} placeholder="Example: received in person"
            onChange={e=>updateDraft(entry.id,"note",e.target.value)}/></label>
          <button type="button" className="primary-button" disabled={!!busyEntry}
            onClick={()=>save(entry.id)}>{busyEntry===entry.id?"Saving…":"Save bookkeeping entry"}</button>
        </div>;
      })}</div>
    </>)}
    {error&&<p role="alert" className="form-message error-message">{error}</p>}
    {notice&&<p role="status" className="form-message success-message">{notice}</p>}
  </section>;
}
