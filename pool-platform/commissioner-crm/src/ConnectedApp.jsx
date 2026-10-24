import React,{useCallback,useEffect,useRef,useState} from "react";
import App from "./App.jsx";
import {loadExistingPlatformClient} from "./platform-host.mjs";
import {createCrmGateway} from "./crm-data.mjs";

// A separate release-locked entrypoint. It never renders demo records if
// config, Auth or connectivity fails. Reuses the original PlatformClient API
// and its same-origin Auth proxy; no OAuth credentials or tokens in app props.
export default function ConnectedApp({clientLoader=loadExistingPlatformClient}) {
  const [client,setClient]=useState(null);
  const [session,setSession]=useState(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [email,setEmail]=useState("");
  const [code,setCode]=useState("");
  const [pendingEmail,setPendingEmail]=useState("");
  const [otpSent,setOtpSent]=useState(false);
  const generation=useRef(0);
  // A gateway owns an assistant-directory cache. Recreate it on every identity
  // change (and on sign-out), not merely when the long-lived Auth client changes.
  const accountId=session?.user?.id??null;
  const gateway=React.useMemo(()=>client&&accountId?createCrmGateway(client):null,[client,accountId]);

  useEffect(()=>{
    let active=true;
    const gen=++generation.current;
    setLoading(true);
    Promise.resolve().then(()=>clientLoader()).then(async loaded=>{
      if(!loaded||typeof loaded.getSession!=="function"||typeof loaded.signOut!=="function"
        ||typeof loaded.sendOtp!=="function"||typeof loaded.verifyOtp!=="function")
        throw new Error("The existing sign-in service is unavailable.");
      const found=await loaded.getSession();
      if(active&&generation.current===gen){
        setClient(loaded);
        setSession(found?.user&&found?.session?found:null);
      }
    }).catch(e=>{if(active&&generation.current===gen)setError(e.message||"Could not connect to your account.");})
      .finally(()=>{if(active&&generation.current===gen)setLoading(false)});
    return()=>{active=false;++generation.current};
  },[clientLoader]);

  const checkSession=useCallback(async()=>{
    if(!client)return;
    const gen=generation.current;
    try{
      const next=await client.getSession();
      if(gen!==generation.current)return;
      setSession(previous=>{
        if(!next?.user||!next?.session)return null;
        // Same account needs no remount; a different account always discards
        // cached pool and ledger data by remounting a new App instance.
        return previous?.user?.id===next.user.id?previous:next;
      });
    }catch{
      // Do not retain old account information after Auth becomes uncertain.
      if(gen===generation.current){setSession(null);setError("Sign-in could not be confirmed. Please sign in again.");}
    }
  },[client]);

  useEffect(()=>{
    if(!client)return;
    const onFocus=()=>{checkSession()};
    const onVisible=()=>{if(document.visibilityState==="visible")checkSession()};
    window.addEventListener("focus",onFocus);
    document.addEventListener("visibilitychange",onVisible);
    return()=>{window.removeEventListener("focus",onFocus);document.removeEventListener("visibilitychange",onVisible)};
  },[client,checkSession]);

  async function sendCode(event) {
    event.preventDefault();if(!client||busy)return;
    setBusy(true);setError("");
    try{
      const normalized=await client.sendOtp(email);
      setPendingEmail(normalized);setOtpSent(true);setCode("");
    }catch(e){setError(e.message||"Could not send code.");}
    finally{setBusy(false);}
  }
  async function verifyCode(event){
    event.preventDefault();if(!client||busy)return;
    setBusy(true);setError("");
    try{
      const verified=await client.verifyOtp(pendingEmail,code);
      if(!verified?.user||!verified?.session)throw new Error("Sign-in could not be confirmed.");
      // Do not reuse any cached data from the previous person.
      ++generation.current;
      setSession(verified);setCode("");setOtpSent(false);setPendingEmail("");
    }catch(e){setError(e.message||"Sign-in failed.");}
    finally{setBusy(false);}
  }
  async function signOut() {
    if(!client||busy)return;
    setBusy(true);setError("");
    ++generation.current;
    // React unmounts App immediately, clearing its in-memory account caches.
    setSession(null);setOtpSent(false);setCode("");setEmail("");setPendingEmail("");
    try{await client.signOut();}
    catch(e){setError(e.message||"Sign-out could not be confirmed. Please try again.");}
    finally{setBusy(false);}
  }

  if(loading) return <main className="app-main auth-shell"><h1>NFL Pool Center</h1><p role="status">Checking your sign-in…</p></main>;
  if(!client)return <main className="app-main auth-shell"><h1>NFL Pool Center</h1>
    <div role="alert" className="form-message error-message">{error||"The commissioner dashboard is unavailable."}</div>
    <p>Return to the existing commissioner page to manage your pool.</p></main>;

  if(session?.user?.id&&session?.session){
    return <div>
      <div className="crm-session-bar">
        <span>Commissioner account</span>
        <button type="button" onClick={signOut} disabled={busy}>{busy?"Signing out…":"Sign out"}</button>
      </div>
      <App key={session.user.id} gateway={gateway}/>
      {error&&<p role="alert" className="form-message error-message">{error}</p>}
    </div>;
  }
  return <main className="app-main auth-shell">
    <div className="eyebrow">NFL POOL CENTER / COMMISSIONER</div>
    <h1>Sign in to manage your pools</h1>
    <p className="subtle">Use the email linked to your NFL Pool Center account. Your access is checked for each pool.</p>
    {error&&<div className="form-message error-message" role="alert">{error}</div>}
    {!otpSent
      ?<form onSubmit={sendCode} className="panel">
        <label className="field"><span>Email address</span>
          <input type="email" value={email} autoComplete="email" required
            onChange={e=>setEmail(e.target.value)}/></label>
        <button type="submit" className="primary-button" disabled={busy}>{busy?"Sending…":"Send sign-in code"}</button>
      </form>
      :<form onSubmit={verifyCode} className="panel">
        <p className="subtle">Enter the code sent to {pendingEmail}.</p>
        <label className="field"><span>Sign-in code</span>
          <input type="text" inputMode="numeric" autoComplete="one-time-code"
            value={code} required onChange={e=>setCode(e.target.value)}/></label>
        <button type="submit" className="primary-button" disabled={busy}>{busy?"Verifying…":"Verify and continue"}</button>
        <button type="button" className="text-action" disabled={busy} onClick={()=>{setOtpSent(false);setCode("");setError("")}}>Use a different email</button>
      </form>}
  </main>;
}
