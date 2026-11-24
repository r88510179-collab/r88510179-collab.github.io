import React,{useState} from "react";
import {participantInvitationLink,validateInviteRequest} from "./invite.mjs";

// Uses the existing protected create-entry-invite RPC. A link is only shown
// after the database returns it; the secret remains in a fragment, is never
// persisted in app storage, and disappears when this panel unmounts.
export default function InviteManager({pool,entries,gateway}){
  const [entryId,setEntryId]=useState(entries[0]?.id??"");
  const [email,setEmail]=useState("");
  const [link,setLink]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  if(pool.permissions?.manage_players!==true)return null;
  async function create(event){
    event.preventDefault();if(busy)return;
    setError("");setNotice("");setLink("");
    let request;
    try{request=validateInviteRequest({entryId,email});}
    catch(e){setError(e.message);return;}
    setBusy(true);
    try{
      const result=await gateway.createInvite(request);
      if(result?.entry_id!==request.entryId)throw new Error("Invitation did not match the selected entry");
      const url=participantInvitationLink({
        origin:location.origin,poolSlug:pool.slug,token:result.invite_token
      });
      setLink(url);setNotice("Invite ready to share privately. Expires after 7 days.");
    }catch(e){setError(e.message||"Could not create an invitation.");}
    finally{setBusy(false);}
  }
  async function copy(){
    if(!link)return;
    try{await navigator.clipboard.writeText(link);setNotice("Invitation link copied.");}
    catch{setNotice("Select and copy the invitation link.");}
  }
  return <section className="panel">
    <h3>Invite a participant</h3>
    <p className="subtle">Choose an entry to create its invitation link. You can limit it to one email or leave the email blank.</p>
    <form onSubmit={create}>
      <label className="field"><span>Participant entry</span>
        <select value={entryId} onChange={event=>{setEntryId(event.target.value);setLink("");setNotice("")}}>
          {entries.map(e=><option key={e.id} value={e.id}>{e.entryCode||e.name} — {e.name}</option>)}
        </select>
      </label>
      <label className="field"><span>Email restriction (optional)</span>
        <input type="email" autoComplete="off" value={email}
          onChange={event=>{setEmail(event.target.value);setLink("")}} placeholder="player@example.com" />
      </label>
      <button className="primary-button" type="submit" disabled={busy||!entries.length}>
        {busy?"Creating…":"Create invitation"}
      </button>
    </form>
    {link&&<div className="invite-private-result">
      <label className="field"><span>Private invitation link</span>
        <input type="text" value={link} readOnly onFocus={event=>event.target.select()}/>
      </label>
      <button type="button" className="primary-button" onClick={copy}>Copy invite link</button>
    </div>}
    {notice&&<p role="status" className="form-message success-message">{notice}</p>}
    {error&&<p role="alert" className="form-message error-message">{error}</p>}
  </section>;
}
