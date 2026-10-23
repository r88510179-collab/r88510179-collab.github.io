import React, {useState} from "react";
import {motion} from "motion/react";
import {CAPABILITIES,PRESETS,canUseDelegation,validateDelegation} from "./permissions.mjs";

const POOLS=[
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
function Toggle({value,onChange,label,help}){return <label className="toggle-row"><span><b>{label}</b>{help&&<small>{help}</small>}</span><input aria-label={label} type="checkbox" checked={value} onChange={e=>onChange(e.target.checked)}/></label>;}

export default function App(){
  const [poolId,setPoolId]=useState("office");
  const [tab,setTab]=useState("overview");
  const [scope,setScope]=useState("selected");
  const [selectedPoolIds,setSelectedPoolIds]=useState(["office"]);
  const [preset,setPreset]=useState("assistant");
  const [capabilities,setCapabilities]=useState([...PRESETS.assistant]);
  const [trackerEnabled,setTrackerEnabled]=useState({office:true,survivor:false});
  const [extraPayments,setExtraPayments]=useState({});
  const [amountDraft,setAmountDraft]=useState({});
  const [rules,setRules]=useState({
    office:{tiebreak:true,deadline:"Weekly cutoff"},
    survivor:{strikes:"1",deadline:"Weekly cutoff"}
  });
  const [messagePreview,setMessagePreview]=useState("");
  const [copyState,setCopyState]=useState("");
  const pool=POOLS.find(x=>x.id===poolId)??POOLS[0];
  const entries=DEMO_ENTRIES.filter(x=>x.pool===poolId);
  const paid=entries.reduce((sum,x)=>sum+x.initialPaid+(extraPayments[x.id]??0),0);
  const balance=entries.reduce((sum,x)=>sum+x.charge-x.initialPaid-(extraPayments[x.id]??0),0);
  const pct=Math.round(pool.submitted/pool.entries*100);
  let delegation;
  try {
    delegation=validateDelegation({
      tenantPoolIds:POOLS.map(x=>x.id),scope,selectedPoolIds,capabilities
    });
  } catch {
    delegation=null;
  }
  const delegatedHere=delegation&&canUseDelegation(delegation,{
    tenantPoolIds:POOLS.map(x=>x.id),poolId,capability:"view_pool"
  });
  function chooseTab(next){setTab(next);setMessagePreview("");setCopyState("");}
  function choosePool(next){setPoolId(next);setTab("overview");setMessagePreview("");}
  function togglePool(id,enabled){setSelectedPoolIds(old=>enabled?[...new Set([...old,id])]:old.filter(x=>x!==id));}
  function toggleCapability(id,enabled){
    setPreset("custom");
    setCapabilities(old=>enabled?[...new Set([...old,id])]:old.filter(x=>x!==id));
  }
  function choosePreset(name){
    setPreset(name);
    setCapabilities([...PRESETS[name]]);
  }
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
    const dollars=Number(amountDraft[entry.id]??"");
    const cents=Math.round(dollars*100);
    const remaining=entry.charge-entry.initialPaid-(extraPayments[entry.id]??0);
    if(!Number.isFinite(dollars)||cents<=0||cents>remaining) return;
    setExtraPayments(old=>({...old,[entry.id]:(old[entry.id]??0)+cents}));
    setAmountDraft(old=>({...old,[entry.id]:""}));
  }
  function changeRules(key,value){
    setRules(old=>({...old,[poolId]:{...old[poolId],[key]:value}}));
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
        <Chip tone="sandbox">SANDBOX</Chip>
      </header>
      <div className="pool-toolbar">
        <label htmlFor="pool-picker">Current pool</label>
        <select id="pool-picker" value={poolId} onChange={e=>choosePool(e.target.value)}>
          {POOLS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Chip tone="live">Active · Week {pool.week}</Chip>
      </div>
      <div className="sandbox-notice" role="status">Preview only. Nothing here modifies accounts, sends messages, or records real payments.</div>
      <motion.div key={tab+"-"+poolId} initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} transition={{duration:0.18}}>
        {tab==="overview"&&<div className="page-section">
          <SectionTitle eyebrow="Your pool at a glance" title="Commissioner Home" description="The essentials for this week, without extra administration."/>
          <div className="metric-grid">
            <Metric label="Entries" value={pool.entries} sub="This season"/>
            <Metric label="Missing picks" value={pool.entries-pool.submitted} sub="Need a reminder"/>
            {trackerEnabled[poolId]&&<><Metric label="Dues recorded" value={DOLLARS(paid)} sub="Sample participants"/><Metric label="Balance outstanding" value={DOLLARS(balance)} sub="Sample participants"/></>}
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
          <SectionTitle eyebrow="Week "+pool.week title="Pick status" description="A simple overview of who has submitted. No source-lock or deadline changes."/>
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
            {pool.type==="Survivor"
              ?<label className="field"><span>How many losses eliminate an entry?</span><select value={rules[poolId].strikes} onChange={e=>changeRules("strikes",e.target.value)}><option value="1">One loss</option><option value="2">Two losses</option><option value="3">Three losses</option></select><small>Two and three strikes require scoring support before release.</small></label>
              :<Toggle label="Use a weekly tiebreaker" help="Break tied Pick'em scores using total points" value={!!rules[poolId].tiebreak} onChange={v=>changeRules("tiebreak",v)}/>}
            <label className="field"><span>When do picks lock?</span><select value={rules[poolId].deadline} onChange={e=>changeRules("deadline",e.target.value)}><option>Weekly cutoff</option><option>At each game's kickoff</option></select><small>Per-game locking will be enabled only after scoring and deadline testing.</small></label>
          </section>
          <section className="panel">
            <h3>Assistant commissioner access</h3>
            <p className="subtle">Choose what an assistant can access. Only a pool owner can delegate roles.</p>
            <label className="field"><span>Which pools can they access?</span><select value={scope} onChange={e=>setScope(e.target.value)}><option value="selected">Only selected pools</option><option value="all">All of my pools</option></select></label>
            {scope==="selected"&&<div className="check-list">{POOLS.map(p=><label key={p.id}><input type="checkbox" checked={selectedPoolIds.includes(p.id)} onChange={e=>togglePool(p.id,e.target.checked)}/>{p.name}</label>)}</div>}
            <label className="field"><span>Starting permissions</span><select value={preset} onChange={e=>choosePreset(e.target.value)}><option value="viewer">Viewer</option><option value="scorekeeper">Pick reviewer</option><option value="assistant">Assistant commissioner</option><option value="custom">Custom</option></select></label>
            <div className="check-list">{CAPABILITIES.map(item=><label key={item.id}><input type="checkbox" checked={capabilities.includes(item.id)} onChange={e=>toggleCapability(item.id,e.target.checked)}/>{item.label}</label>)}</div>
            <div className="mini-alert"><span>{delegation?(delegatedHere?"Assistant can view this pool":"Assistant cannot view this pool"):"Select at least one pool"}</span><Chip tone={delegatedHere?"live":"pending"}>Preview</Chip></div>
            <p className="subtle">These are draft settings in your browser only. Server-enforced staff access is not activated yet.</p>
          </section>
        </div>}
        {tab==="dues"&&<div className="page-section">
          <SectionTitle eyebrow="Optional recordkeeping" title="Dues log" description="A private record of contributions handled completely outside this application."/>
          <section className="panel">
            <Toggle label="Enable dues tracking for this pool" help="No checkout, payments, transfer, or processing. You keep all funds outside the app." value={!!trackerEnabled[poolId]} onChange={v=>setTrackerEnabled(old=>({...old,[poolId]:v}))}/>
            {trackerEnabled[poolId]&&<>
              <div className="metric-grid two"><Metric label="Sample dues logged" value={DOLLARS(paid)}/><Metric label="Still outstanding" value={DOLLARS(balance)}/></div>
              <div className="entry-list">{entries.map(e=>{
                const due=e.charge-e.initialPaid-(extraPayments[e.id]??0);
                return <div className="dues-entry" key={e.id}>
                  <div className="dues-head"><strong>{e.name}</strong><Chip tone={due===0?"live":"pending"}>{due===0?"Recorded in full":DOLLARS(due)+" outstanding"}</Chip></div>
                  {due>0&&<div className="dues-controls"><label><span>Record external payment ($)</span><input aria-label={"Amount paid by "+e.name} inputMode="decimal" type="number" min="0.01" max={due/100} step="0.01" value={amountDraft[e.id]??""} onChange={event=>setAmountDraft(old=>({...old,[e.id]:event.target.value}))}/></label><button type="button" onClick={()=>recordDemoPayment(e)} disabled={!(Number(amountDraft[e.id])>0&&Math.round(Number(amountDraft[e.id])*100)<=due)}>Log in demo</button></div>}
                </div>;
              })}</div>
            </>}
          </section>
        </div>}
      </motion.div>
      <footer className="app-footer">NFL Pool Center · Commissioner CRM sandbox · No live data or payment processing</footer>
    </main>
    <nav className="mobile-nav" aria-label="Mobile commissioner navigation">
      {TABS.filter(([id])=>id!=="dues").map(([id,label])=><button key={id} type="button" className={tab===id?"active":""} onClick={()=>chooseTab(id)}>{label}</button>)}
      <button type="button" className={tab==="dues"?"active":""} onClick={()=>chooseTab("dues")}>Dues</button>
    </nav>
  </div>;
}
