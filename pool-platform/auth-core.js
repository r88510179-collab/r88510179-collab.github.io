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
