export function normalizeEmail(value){
  return String(value??'').trim().toLowerCase();
}

export function validEmail(value){
  const email=normalizeEmail(value);
  return email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validOtp(value){
  return /^\d{4,10}$/.test(String(value??'').trim());
}

export function normalizeInviteToken(value){
  const token=String(value??'').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(token)?token:null;
}

// An invite link carries its bearer token only in the URL fragment. A browser never sends a fragment in an HTTP
// request, so no host, proxy, request log or observability tool sees the token. The pool slug is not secret and
// stays in the query string. Any query or fragment already on pageUrl is replaced.
export function participantInviteUrl(pageUrl,poolSlug,token){
  const url=new URL(pageUrl);
  url.search='';url.searchParams.set('pool',poolSlug);
  url.hash=new URLSearchParams({invite:token}).toString();
  return url.href;
}

// Reads the invite from a participant page URL. Only a single invite in the fragment is a token. An invite in the
// query string is the retired link format: its token reached the host before any script ran, so it is never used,
// whatever else the link holds. The fragment invite given twice is refused rather than guessed at. cleanUrl is the
// page's path and query with every invite removed, for history.replaceState: the query loses only its invite
// parameter, and a fragment that held an invite is dropped whole.
export function readInviteFromUrl(href){
  const url=new URL(href),fragment=new URLSearchParams(url.hash.slice(1));
  const queried=url.searchParams.has('invite'),values=fragment.getAll('invite');
  if(queried)url.searchParams.delete('invite');
  if(values.length)url.hash='';
  const read={found:queried||values.length>0,cleanUrl:url.pathname+url.search+url.hash};
  if(queried)return{...read,token:'',error:values.length?'invite_link_ambiguous':'invite_link_retired'};
  if(values.length>1)return{...read,token:'',error:'invite_link_ambiguous'};
  return{...read,token:values[0]??'',error:''};
}

// Compact JWS: three non-empty base64url segments. The Data API only accepts a Neon Auth JWT, so an opaque
// session token is never sent to it as a bearer credential.
const JWT_SHAPE=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function extractAccessToken(sessionResult){
  const data=sessionResult&&typeof sessionResult==='object'&&'data' in sessionResult?sessionResult.data:sessionResult;
  const session=data&&typeof data==='object'&&'session' in data?data.session:data;
  if(!session||typeof session!=='object')return null;
  // @neondatabase/neon-js 0.7.0-beta (Better Auth adapter) copies the set-auth-jwt header into session.token;
  // the Supabase-compatible adapter exposes the same JWT as access_token.
  for(const token of [session.token,session.access_token,session.accessToken]){
    if(typeof token==='string'&&token.length>20&&JWT_SHAPE.test(token))return token;
  }
  return null;
}

export function authErrorMessage(code){
  const raw=String(code??'');
  if(raw.includes('invite_email_mismatch'))return'This invitation was issued to a different email address.';
  if(raw.includes('invite_email_unverified'))return'This invitation requires a verified email address. Verify your email, then open the invitation again.';
  if(raw.includes('team_already_used'))return'That team has already been used by this entry.';
  if(raw.includes('entry_not_active'))return'This entry is not active, so picks cannot be submitted for it.';
  if(raw.includes('invite_unavailable'))return'This invitation is expired, already used, or no longer available.';
  if(raw.includes('invite_link_retired'))return'This invitation link uses a retired format and can no longer be used. Ask your commissioner for a new invitation link.';
  if(raw.includes('invite_link_ambiguous'))return'This invitation link is not valid. Ask your commissioner for a new invitation link.';
  if(raw.includes('entry_already_claimed'))return'This pool entry has already been claimed.';
  if(raw.includes('source_conflict:participant'))return'This entry was already submitted directly by the participant.';
  if(raw.includes('source_conflict:commissioner_'))return'This entry was already submitted through the commissioner channel.';
  if(raw.includes('deadline_passed'))return'The submission deadline has passed.';
  if(raw.includes('submission_locked'))return'This submission is locked.';
  if(raw.includes('week_not_open'))return'This week is not open for submissions.';
  if(raw.includes('entry_not_owned'))return'You do not own this pool entry.';
  if(raw.includes('commissioner_required'))return'Commissioner access is required.';
  if(raw.includes('invalid_payload'))return'These picks do not match the configured games or Survivor rules.';
  if(raw.includes('invalid_entry_week'))return'This entry does not belong to the selected week.';
  return raw||'The request could not be completed.';
}
