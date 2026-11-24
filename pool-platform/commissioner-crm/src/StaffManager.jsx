import React,{useEffect,useState} from "react";
import {CAPABILITIES,PRESETS} from "./permissions.mjs";
import {normalizeAssistants,prepareAssistantRequest} from "./staff.mjs";

// Deliberately no browser-stored credentials, permission tokens, or direct table writes.
// All writes use the server-checked existing PlatformClient RPC bridge when connected.
const EXAMPLE_ASSISTANTS=[
  {id:"demo-helper",name:"Demo helper",email:"helper@example.test",scope:"selected",
    pool_ids:["office"],capabilities:["view_pool","manage_players","review_picks"]}
];

export default function StaffManager({pool,tenantPools,gateway=null}){
  const [people,setPeople]=useState([]);
  const [choice,setChoice]=useState("new");
  const [email,setEmail]=useState("");
  const [scope,setScope]=useState("selected");
  const [poolIds,setPoolIds]=useState([pool.id]);
  const [preset,setPreset]=useState("assistant");
  const [capabilities,setCapabilities]=useState([...PRESETS.assistant]);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");

  const tenantId=pool.tenantId;
  const tenantPoolIds=tenantPools.map(p=>p.id);
  const current=people.find(p=>p.id===choice);
  function restoreNew(){
    setChoice("new");setEmail("");setScope("selected");setPoolIds([pool.id]);
    setPreset("assistant");setCapabilities([...PRESETS.assistant]);setNotice("");setError("");
  }
  function choosePerson(id){
    setChoice(id);setError("");setNotice("");
    if(id==="new"){
      setEmail("");setScope("selected");setPoolIds([pool.id]);
      setPreset("assistant");setCapabilities([...PRESETS.assistant]);return;
    }
    const user=people.find(x=>x.id===id);
    if(user){setScope(user.scope);setPoolIds([...user.poolIds]);
      setCapabilities([...user.capabilities]);setPreset("custom");setEmail(user.email);}
  }
  useEffect(()=>{
    let active=true;
    setChoice("new");setEmail("");setScope("selected");setPoolIds([pool.id]);
    setPreset("assistant");setCapabilities([...PRESETS.assistant]);
    setError("");setNotice("");
    if(!gateway){setPeople(normalizeAssistants(EXAMPLE_ASSISTANTS,tenantPoolIds));return()=>{active=false};}
    if(typeof gateway.listAssistants!=="function"){setError("Assistant management is not available.");return()=>{active=false};}
    setLoading(true);
    gateway.listAssistants(tenantId).then(data=>{
      if(active)setPeople(normalizeAssistants(data,tenantPoolIds));
    }).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[gateway,tenantId]); // pool change within same tenant does not refetch roster
  function selectPool(id,checked){setPoolIds(old=>checked?[...new Set([...old,id])]:old.filter(x=>x!==id));}
  function selectPreset(id){setPreset(id);if(id!=="custom")setCapabilities([...PRESETS[id]]);}
  function toggleCapability(id,checked){setPreset("custom");setCapabilities(old=>checked?[...new Set([...old,id])]:old.filter(x=>x!==id));}
  async function save(event){
    event.preventDefault();if(saving)return;
    setError("");setNotice("");
    let request;
    try{request=prepareAssistantRequest({
      tenantId:tenantId||"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      email:choice==="new"?email:null,userId:choice==="new"?null:choice,
      scope,poolIds,capabilities,tenantPoolIds
    });}catch(e){setError(e.message);return;}
    if(!gateway){
      // Demo-only local edit; never imply a server write.
      if(request.kind==="add"){
        const added={id:"preview-"+Date.now(),name:"New demo assistant",email:request.email,
          scope:request.scope,poolIds:request.poolIds,capabilities:request.capabilities};
        setPeople(old=>[...old,added]);setChoice(added.id);
      }else setPeople(old=>old.map(x=>x.id===request.userId?{
        ...x,scope:request.scope,poolIds:request.poolIds,capabilities:request.capabilities
      }:x));
      setNotice("Saved in this demo only. No account was changed.");return;
    }
    if(typeof gateway.addAssistant!=="function"||typeof gateway.updateAssistant!=="function"){
      setError("Assistant management is unavailable.");return;
    }
    setSaving(true);
    try{
      if(request.kind==="add")await gateway.addAssistant(request);
      else await gateway.updateAssistant(request);
      const after=normalizeAssistants(await gateway.listAssistants(tenantId),tenantPoolIds);
      setPeople(after);
      if(request.kind==="add"){restoreNew();}
      setNotice("Assistant access saved.");
    }catch(e){setError(e.message||"Could not save permissions. No changes were confirmed.")}
    finally{setSaving(false);}
  }
  return <section className="panel">
    <h3>Assistant commissioner access</h3>
    <p className="subtle">Invite help for just one pool or all your pools. Assistants must first sign in with a verified NFL Pool Center email.</p>
    {loading&&<p className="subtle" role="status">Loading assistants…</p>}
    <form onSubmit={save}>
      <label className="field">
        <span>Who are you assigning?</span>
        <select value={choice} onChange={e=>choosePerson(e.target.value)}>
          <option value="new">Add assistant by email</option>
          {people.map(p=><option key={p.id} value={p.id}>{p.email||p.name}</option>)}
        </select>
      </label>
      {choice==="new"&&<label className="field">
        <span>Assistant's verified email</span>
        <input type="email" required autoComplete="off" value={email} placeholder="assistant@example.com"
          onChange={e=>setEmail(e.target.value)} />
        <small>They need an existing verified account before you can add them.</small>
      </label>}
      {current&&<p className="subtle">{current.email||"This assistant's account details are not yet available."}</p>}
      <label className="field"><span>Which pools can they manage?</span>
        <select value={scope} onChange={e=>setScope(e.target.value)}>
          <option value="selected">Only selected pools</option><option value="all">All my pools</option>
        </select>
      </label>
      {scope==="selected"&&<div className="check-list">
        {tenantPools.map(p=><label key={p.id}><input type="checkbox" checked={poolIds.includes(p.id)}
          onChange={e=>selectPool(p.id,e.target.checked)}/>{p.name}</label>)}
      </div>}
      <label className="field"><span>Access level</span>
        <select value={preset} onChange={e=>selectPreset(e.target.value)}>
          <option value="viewer">View only</option><option value="scorekeeper">Pick reviewer</option>
          <option value="assistant">Assistant commissioner</option><option value="custom">Choose permissions</option>
        </select>
      </label>
      <div className="check-list">
        {CAPABILITIES.map(item=><label key={item.id}><input type="checkbox"
          checked={capabilities.includes(item.id)}
          onChange={e=>toggleCapability(item.id,e.target.checked)}/>{item.label}</label>)}
      </div>
      <button type="submit" className="primary-button" disabled={saving||loading}>
        {saving?"Saving…":choice==="new"?"Add assistant":"Save assistant access"}
      </button>
      {error&&<p className="form-message error-message" role="alert">{error}</p>}
      {notice&&<p className="form-message success-message" role="status">{notice}</p>}
      <p className="subtle">Changing access only affects the selected assistant. Your pool rules and submitted picks stay unchanged.</p>
    </form>
  </section>;
}
