import React, {useEffect,useRef,useState} from "react";
import {createCrmSessionStore} from "./crm-data.mjs";
import {motion} from "motion/react";
import StaffManager from "./StaffManager.jsx";
import LiveDuesPanel from "./LiveDuesPanel.jsx";

const DEMO_POOLS=[
  {id:"office",name:"Office Football Pool",type:"Pick'em",entries:24,submitted:18,week:7},
  {id:"survivor",name:"Friday Survivor",type:"Survivor",entries:15,submitted:12,week:7}
];
const DEMO_ENTRIES=[
  {id:"alex",name:"Alex R.",pool:"office",submitted:true,charge:5000,initialPaid:5000},
  {id:"blair",name:"Blair M.",pool:"office",submitted:false,charge:5000,initialPaid:2500},
  {id:"casey",name:"Casey T.",pool:"office",submitted:true,charge:5000,initialPaid:0},
  {id:"drew",name:"Drew K.",pool:"office",submitted:false,charge:5000,initialPaid:0},
  {id:"eli",name:"Eli P.",pool:"survivor",submitted:true,charge:0,initialPaid:0},
  {id:"frankie",name:"Frankie J.",pool:"survivor",submitted:false,charge:0,initialPaid:0}
];
const TABS=[["overview","Home"],["players","Players"],["picks","Picks"],["settings","Settings"],["dues","Dues log"]];
const DOLLARS = cents=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(cents/100);
function Chip({children,tone=""}){return <span className={"chip "+tone}>{children}</span>;}
function SectionTitle({eyebrow,title,description}){return <div className="section-heading"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2>{description&&<p>{description}</p>}</div></div>;}
function Metric({label,value,sub}){return <div className="metric"><span>{label}</span><strong>{value}</strong>{sub&&<small>{sub}</small>}</div>;}
function Toggle({value,onChange,label,help,disabled=false}){return <label className="toggle-row"><span><b>{label}</b>{help&&<small>{help}</small>}</span><input aria-label={label} type="checkbox" checked={value} disabled={disabled} onChange={e=>onChange(e.target.checked)}/></label>;}

export default function App({gateway=null}){
  const [poolId,setPoolId]=useState("office");
  const [tab,setTab]=useState("overview");
  const [trackerEnabled,setTrackerEnabled]=useState({office:true,survivor:false});
  const [extraPayments,setExtraPayments]=useState({});
  const [amountDraft,setAmountDraft]=useState({});
  const [rules,setRules]=useState({
    office:{tiebreak:true,deadline:"Weekly cutoff"},
    survivor:{strikes:"1",deadline:"Weekly cutoff"}
  });
  const [messagePreview,setMessagePreview]=useState("");
  const [copyState,setCopyState]=useState("");
  // The demo is the only default. An authenticated gateway must be injected by a
  // reviewed host integration; without it there are no network calls or secrets.
  const [livePools,setLivePools]=useState([]);
  const [liveContexts,setLiveContexts]=useState({});
  const [liveDues,setLiveDues]=useState({});
  const [crmError,setCrmError]=useState("");
  const storeRef=useRef(null);
  useEffect(()=>{
    if(!gateway){storeRef.current=null;setLivePools([]);return;}
    let active=true;
    const store=createCrmSessionStore(gateway);
    storeRef.current=store;
    setLivePools([]);setLiveContexts({});setLiveDues({});setCrmError("");
    store.listPools().then(pools=>{
      if(!active)return;
      setLivePools(pools);setPoolId(pools[0]?.id??"");
    }).catch(e=>{if(active)setCrmError(e.message)});
    return ()=>{active=false;store.clear();if(storeRef.current===store)storeRef.current=null;};
  },[gateway]);
  const pools=gateway?livePools:DEMO_POOLS;
  const selectedPoolId=pools.some(p=>p.id===poolId)?poolId:pools[0]?.id;
  const selectedPool=pools.find(p=>p.id===selectedPoolId);
  useEffect(()=>{
    if(!gateway||!selectedPool||liveContexts[selectedPool.id])return;
    let active=true;
    const store=storeRef.current;
    if(!store)return;
    store.readContext(selectedPool).then(data=>{
      if(active&&storeRef.current===store)setLiveContexts(old=>({...old,[selectedPool.id]:data}));
    }).catch(e=>{if(active&&storeRef.current===store)setCrmError(e.message)});
    return ()=>{active=false};
  },[gateway,selectedPoolId,livePools,liveContexts]);
  useEffect(()=>{
    if(!gateway||!selectedPool?.duesTrackingEnabled||selectedPool.permissions?.record_dues!==true||
       Object.hasOwn(liveDues,selectedPool.id))return;
    let active=true;const store=storeRef.current;
    if(!store)return;
    store.readDues(selectedPool).then(rows=>{
      if(active&&storeRef.current===store)setLiveDues(old=>({...old,[selectedPool.id]:rows}));
    }).catch(e=>{if(active&&storeRef.current===store)setCrmError(e.message)});
    return ()=>{active=false};
  },[gateway,selectedPoolId,livePools,liveDues]);
  const currentContext=liveContexts[selectedPoolId];
  const pool=gateway
    ?(currentContext??{...selectedPool,id:selectedPoolId??"",name:selectedPool?.name??"Loading pool…",
      type:selectedPool?.type??"Pick'em",entries:0,submitted:0,week:"—"})
    :(selectedPool??DEMO_POOLS[0]);
  const trackerActive=gateway?(pool.duesTrackingEnabled===true&&pool.permissions?.record_dues===true):!!trackerEnabled[poolId];
  const entries=gateway
    ?(currentContext?.roster??[]).map(entry=>{
      const dueRecord=(liveDues[selectedPoolId]??[]).find(x=>x.id===entry.id);
      return dueRecord?{...entry,charge:dueRecord.charge,initialPaid:dueRecord.initialPaid,balanceOverride:dueRecord.balanceOverride}:entry;
    })
    :DEMO_ENTRIES.filter(x=>x.pool===selectedPoolId);
  const paid=entries.reduce((sum,x)=>sum+x.initialPaid+(gateway?0:(extraPayments[x.id]??0)),0);
  const balance=entries.reduce((sum,x)=>sum+(Number.isSafeInteger(x.balanceOverride)?x.balanceOverride:x.charge-x.initialPaid-(gateway?0:(extraPayments[x.id]??0))),0);
  const tenantPools=pools.filter(p=>p.tenantId===pool.tenantId);
  const pct=pool.entries?Math.round(pool.submitted/pool.entries*100):0;
  function chooseTab(next){setTab(next);setMessagePreview("");setCopyState("");}
  function choosePool(next){setPoolId(next);setTab("overview");setMessagePreview("");setCrmError("");}
  function openDraft(kind){
    chooseTab("overview");
    setMessagePreview(kind==="reminder"
      ? "Week "+pool.week+" reminder: please submit your picks before the deadline. — "+pool.name
      : "Week "+pool.week+" standings for "+pool.name+" are ready to share.");
  }
  async function copyPreview(){
    try{
      if(!navigator.clipboard?.writeText) throw new Error("Copy is unavailable");
      await navigator.clipboard.writeText(messagePreview);
      setCopyState("Draft copied");
    }catch{setCopyState("Select and copy the text above");}
  }
  function recordDemoPayment(entry){
    if(gateway)return; // A live dues entry requires the reviewed server RPC; demo never sends funds.
    const dollars=Number(amountDraft[entry.id]??"");
    const cents=Math.round(dollars*100);
    const remaining=entry.charge-entry.initialPaid-(extraPayments[entry.id]??0);
    if(!Number.isFinite(dollars)||cents<=0||cents>remaining) return;
    setExtraPayments(old=>({...old,[entry.id]:(old[entry.id]??0)+cents}));
    setAmountDraft(old=>({...old,[entry.id]:""}));
  }
  async function changeLiveDuesEnabled(enabled){
    if(!gateway)return;
    const id=pool.id;
    storeRef.current?.invalidate(id);
    setLivePools(old=>old.map(x=>x.id===id?{...x,duesTrackingEnabled:enabled}:x));
    setLiveContexts(old=>({...old,[id]:{...old[id],duesTrackingEnabled:enabled}}));
    setLiveDues(old=>{const next={...old};delete next[id];return next;});
  }
  async function refreshLiveDues(){
    if(!gateway||!storeRef.current)return;
    const store=storeRef.current;
    store.invalidate(pool.id);
    const rows=await store.readDues({...pool,duesTrackingEnabled:true});
    if(storeRef.current===store)setLiveDues(old=>({...old,[pool.id]:rows}));
  }
  function changeRules(key,value){
    setRules(old=>({...old,[poolId]:{...old[poolId],[key]:value}}));
  }
  if(gateway&&(!selectedPool||!currentContext)){
    return <main className="app-main" role="status">
      <div className="eyebrow">NFL POOL CENTER / COMMISSIONER</div>
      <h1>Commissioner dashboard</h1>
      <section className="panel" style={{marginTop:24}}>
        <h3>{crmError?"Could not load this pool":"Loading your pool…"}</h3>
        <p className="subtle">{crmError||"Your authorized pool details are being retrieved."}</p>
      </section>
    </main>;
  }
  return <div className="app-shell">
    <aside className="side-nav">
      <div className="identity"><span className="logo-mark">N</span><div><strong>NFL POOL CENTER</strong><small>COMMISSIONER</small></div></div>
      <nav aria-label="Commissioner navigation" className="side-menu">
        {TABS.map(([id,label])=><button key={id} type="button" className={tab===id?"nav-button active":"nav-button"} onClick={()=>chooseTab(id)}>{label}</button>)}
      </nav>
      <div className="side-note">Sandbox interface · fictional data</div>
    </aside>
    <main className="app-main">
      <header className="top-line">
        <div><div className="eyebrow">NFL POOL CENTER / COMMISSIONER</div><h1>Manage your pool</h1></div>
        <Chip tone="sandbox">{gateway?"READ ONLY":"SANDBOX"}</Chip>
      </header>
      <div className="pool-toolbar">
        <label htmlFor="pool-picker">Current pool</label>
        <select id="pool-picker" value={poolId} onChange={e=>choosePool(e.target.value)}>
          {pools.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Chip tone="live">Active · Week {pool.week}</Chip>
      </div>
      <div className="sandbox-notice" role="status">{gateway?"Authenticated read-only CRM view. Write actions remain disabled until server acceptance.":"Preview only. Nothing here modifies accounts, sends messages, or records real payments."}</div>
      {gateway&&crmError&&<div className="sandbox-notice" role="alert">Unable to load commissioner data: {crmError}</div>}
      {gateway&&livePools.length===0&&!crmError&&<div className="sandbox-notice" role="status">Loading your pools…</div>}
      <motion.div key={tab+"-"+poolId} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:0.18}}>
        {tab==="overview"&&<div className="page-section">
          <SectionTitle eyebrow="Your pool at a glance" title="Commissioner Home" description="The essentials for this week, without extra administration."/>
          <div className="metric-grid">
            <Metric label="Entries" value={pool.entries} sub="This season"/>
            <Metric label="Missing picks" value={pool.entries-pool.submitted} sub="Need a reminder"/>
            {trackerActive&&<><Metric label="Dues recorded" value={DOLLARS(paid)} sub="Sample participants"/><Metric label="Balance outstanding" value={DOLLARS(balance)} sub="Sample participants"/></>}
          </div>
          <section className="panel">
            <div className="panel-top"><h3>Week {pool.week} status</h3><Chip>{pct}% submitted</Chip></div>
            <div className="progress" role="progressbar" aria-label="Entries submitted" aria-valuenow={pool.submitted} aria-valuemin={0} aria-valuemax={pool.entries}><span style={{width:pct+"%"}} /></div>
            <p className="subtle">{pool.submitted} of {pool.entries} entries submitted</p>
            <div className="mini-alert"><span>{pool.entries-pool.submitted} entries still need picks</span><button type="button" className="text-action" onClick={()=>openDraft("reminder")}>Draft reminder →</button></div>
          </section>
          <section className="panel">
            <h3>Quick actions</h3>
            <div className="action-grid">
              <button type="button" onClick={()=>chooseTab("players")}><span>＋</span>Manage players</button>
              <button type="button" onClick={()=>openDraft("reminder")}><span>◉</span>Draft reminder</button>
              <button type="button" onClick={()=>chooseTab("dues")}><span>＄</span>Track dues</button>
              <button type="button" onClick={()=>openDraft("share")}><span>↗</span>Share standings</button>
            </div>
          </section>
          {messagePreview&&<section className="panel draft-panel"><div className="panel-top"><h3>Message preview</h3><Chip>Not sent</Chip></div><textarea aria-label="Message draft" value={messagePreview} onChange={e=>setMessagePreview(e.target.value)} rows={3}/><button className="primary-button" type="button" onClick={copyPreview}>Copy draft</button>{copyState&&<p className="subtle">{copyState}</p>}</section>}
        </div>}
        {tab==="players"&&<section className="page-section">
          <SectionTitle eyebrow="Roster" title="Players" description="Search, invites and entry management will connect to your existing commissioner permissions."/>
          <div className="panel">
            <div className="panel-top"><h3>Sample entries</h3><Chip>{entries.length} shown</Chip></div>
            <div className="entry-list">{entries.map(e=><div className="entry-row" key={e.id}><div className="avatar">{e.name.slice(0,1)}</div><div className="entry-name"><strong>{e.name}</strong><small>Participant entry</small></div><Chip tone={e.submitted?"live":"pending"}>{e.submitted?"Submitted":"Missing pick"}</Chip></div>)}</div>
            <p className="subtle">Invite generation and real roster changes remain locked until the existing Auth and Neon integration passes review.</p>
          </div>
        </section>}
        {tab==="picks"&&<section className="page-section">
          <SectionTitle eyebrow={"Week "+pool.week} title="Pick status" description="A simple overview of who has submitted. No source-lock or deadline changes."/>
          <div className="panel">
            <div className="panel-top"><h3>Submissions</h3><Chip>{pool.submitted} of {pool.entries}</Chip></div>
            <div className="progress" role="progressbar" aria-label="Weekly submissions" aria-valuenow={pool.submitted} aria-valuemin={0} aria-valuemax={pool.entries}><span style={{width:pct+"%"}} /></div>
            <p className="subtle">When connected, this view will reuse the current authorized submission status and weekly deadlines.</p>
          </div>
        </section>}
        {tab==="settings"&&<div className="page-section">
          <SectionTitle eyebrow="Pool preferences" title="Settings" description="Every option is written for commissioners, not developers."/>
          <section className="panel">
            <h3>Rules for {pool.name}</h3>
            {gateway?<p className="subtle">Your existing pool rules are unchanged. Rule editing in this dashboard will be available after the next review.</p>:
            <>
            {pool.type==="Survivor"
              ?<label className="field"><span>How many losses eliminate an entry?</span><select value={rules[poolId].strikes} onChange={e=>changeRules("strikes",e.target.value)}><option value="1">One loss</option><option value="2">Two losses</option><option value="3">Three losses</option></select><small>Two and three strikes require scoring support before release.</small></label>
              :<Toggle label="Use a weekly tiebreaker" help="Break tied Pick'em scores using total points" value={!!rules[poolId].tiebreak} onChange={v=>changeRules("tiebreak",v)}/>}
            <label className="field"><span>When do picks lock?</span><select value={rules[poolId].deadline} onChange={e=>changeRules("deadline",e.target.value)}><option>Weekly cutoff</option><option>At each game's kickoff</option></select><small>Per-game locking will be enabled only after scoring and deadline testing.</small></label>
            </>}
          </section>
          {(!gateway||pool.permissions?.manage_staff===true)&&
            <StaffManager pool={pool} tenantPools={tenantPools} gateway={gateway} />}
        </div>}
        {tab==="dues"&&<div className="page-section">
          <SectionTitle eyebrow="Optional recordkeeping" title="Dues log" description="A private record of contributions handled completely outside this application."/>
          {gateway?<LiveDuesPanel pool={pool} entries={entries}
            loaded={Object.hasOwn(liveDues,selectedPoolId)} gateway={gateway}
            onEnabledChange={changeLiveDuesEnabled} onRecorded={refreshLiveDues}/>:
          <section className="panel">
            <Toggle label="Enable dues tracking for this pool" help="No checkout, payments, transfer, or processing. You keep all funds outside the app." value={trackerActive} disabled={!!gateway} onChange={v=>setTrackerEnabled(old=>({...old,[poolId]:v}))}/>
            {trackerActive&&<>
              <div className="metric-grid two"><Metric label="Sample dues logged" value={DOLLARS(paid)}/><Metric label="Still outstanding" value={DOLLARS(balance)}/></div>
              <div className="entry-list">{entries.map(e=>{
                const due=Number.isSafeInteger(e.balanceOverride)?e.balanceOverride:e.charge-e.initialPaid-(extraPayments[e.id]??0);
                return <div className="dues-entry" key={e.id}>
                  <div className="dues-head"><strong>{e.name}</strong><Chip tone={due===0?"live":"pending"}>{due===0?"Recorded in full":DOLLARS(due)+" outstanding"}</Chip></div>
                  {due>0&&<div className="dues-controls"><label><span>Record external payment ($)</span><input aria-label={"Amount paid by "+e.name} inputMode="decimal" type="number" min="0.01" max={due/100} step="0.01" value={amountDraft[e.id]??""} disabled={!!gateway} onChange={event=>setAmountDraft(old=>({...old,[e.id]:event.target.value}))}/></label><button type="button" onClick={()=>recordDemoPayment(e)} disabled={!!gateway||!(Number(amountDraft[e.id])>0&&Math.round(Number(amountDraft[e.id])*100)<=due)}>Log in demo</button></div>}
                </div>;
              })}</div>
            </>}
          </section>}
        </div>}
      </motion.div>
      <footer className="app-footer">NFL Pool Center · Commissioner CRM · No payment processing</footer>
    </main>
    <nav className="mobile-nav" aria-label="Mobile commissioner navigation">
      {TABS.filter(([id])=>id!=="dues").map(([id,label])=><button key={id} type="button" className={tab===id?"active":""} onClick={()=>chooseTab(id)}>{label}</button>)}
      <button type="button" className={tab==="dues"?"active":""} onClick={()=>chooseTab("dues")}>Dues</button>
    </nav>
  </div>;
}
