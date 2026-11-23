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

// INV-SSO-01 / SSO-CONT-01. A protected Netlify edge-access renewal may
// lose the query portion of requested_path before browser JS can run.
// Newly issued links therefore carry only non-secret pool/entry identifiers
// in the PATH: /join/<pool>/<entry-uuid>. No bearer secret is ever exposed.
// Netlify rewrites this path internally to participant.html *after* perimeter
// protection; the browser URL remains /join/... until application JS scrubs it.
// Recipient authorization remains solely in the verified-email RPC.
const ENTRY_UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const POOL_SLUG=/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export function participantInviteUrl(pageUrl,poolSlug,entryId){
  if(!POOL_SLUG.test(String(poolSlug??'')))throw new Error('Invalid pool slug.');
  if(!ENTRY_UUID.test(String(entryId??'')))throw new Error('Invalid entry ID.');
  const url=new URL(pageUrl);
  // Entire path is a non-secret routing hint. Never place an invite token
  // into the URL, even in a fragment. The origin comes from the trusted app.
  url.pathname='/join/'+poolSlug+'/'+String(entryId).toLowerCase();
  url.search='';
  url.hash='';
  return url.href;
}

// Accept both path-based new invitations and previously issued token-free
// ?pool=...&entry=<uuid> links; reject every retired bearer-token format.
// A new link's clean URL is the canonical participant.html?pool=... page.
// No secret or target identifier is stored in a cookie, storage, or network log.
export function readInviteFromUrl(href){
  const url=new URL(href);
  const isJoinRoute=url.pathname.startsWith('/join/');
  const queryEntries=url.searchParams.getAll('entry');
  const queryPools=url.searchParams.getAll('pool');
  const legacyQuery=url.searchParams.has('invite');
  const legacyFragment=new URLSearchParams(url.hash.slice(1)).has('invite');
  const found=isJoinRoute||legacyQuery||legacyFragment||queryEntries.length>0;

  // Path carries both values so they survive an SSO return even if its query
  // is lost. A second target in the query or a conflicting pool is ambiguous.
  if(isJoinRoute){
    const segments=url.pathname.split('/');
    const pool=segments.length===4?segments[2]:'';
    const entryId=segments.length===4?segments[3]:'';
    const valid=POOL_SLUG.test(pool)&&ENTRY_UUID.test(entryId);
    const cleanUrl='/participant.html'+(POOL_SLUG.test(pool)?'?pool='+encodeURIComponent(pool):'');
    const ambiguous=!valid||queryEntries.length>0||queryPools.length>1||
      (queryPools.length===1&&queryPools[0]!==pool)||url.hash!=='';
    if(legacyQuery||legacyFragment)return {found:true,entryId:'',cleanUrl,error:'invite_link_retired'};
    if(ambiguous)return {found:true,entryId:'',cleanUrl,error:'invite_link_ambiguous'};
    return {found:true,entryId:entryId.toLowerCase(),cleanUrl,error:''};
  }

  url.searchParams.delete('invite');
  url.searchParams.delete('entry');
  if(found)url.hash='';
  const cleanUrl=url.pathname+url.search+url.hash;
  if(legacyQuery||legacyFragment)
    return {found:true,entryId:'',cleanUrl,error:'invite_link_retired'};
  if(queryEntries.length!==1||!ENTRY_UUID.test(queryEntries[0]??''))
    return {found,entryId:'',cleanUrl,error:found?'invite_link_ambiguous':''};
  return {found:true,entryId:queryEntries[0].toLowerCase(),cleanUrl,error:''};
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
  if(raw.includes('invalid_pool_name'))return'Enter a pool name between 3 and 120 characters.';
  if(raw.includes('invalid_pool_type'))return'Choose Pick’em or Survivor.';
  if(raw.includes('invalid_season_year'))return'Enter an NFL season year between 2020 and 2100.';
  if(raw.includes('duplicate_season'))return'This season already exists in your pool.';
  if(raw.includes('schedule_source_not_synced'))return'No validated NFL schedule has been loaded for this week yet. Try again after the source sync.';
  if(raw.includes('schedule_source_stale'))return'The NFL schedule source needs a fresh sync before this week can open.';
  if(raw.includes('schedule_changed_reload'))return'The NFL schedule changed since your review. Reload the games and review the updated schedule.';
  if(raw.includes('invalid_verified_schedule'))return'The imported NFL schedule failed validation. No picks were opened.';
  if(raw.includes('regular_season_only'))return'Automatic schedule import currently supports regular-season weeks 1–18.';
  if(raw.includes('opening_confirmation_required'))return'Review the week and confirm opening before participants can make picks.';
  if(raw.includes('invalid_draft_schedule'))return'One or more games are incomplete or invalid. Check the teams and kickoff times.';
  if(raw.includes('kickoff_before_deadline'))return'A kickoff occurs before the weekly deadline. Set the deadline earlier.';
  if(raw.includes('week_not_draft'))return'Only draft weeks can have their schedule edited.';
  if(raw.includes('week_has_submissions'))return'This week already has saved picks. Its schedule cannot be changed.';
  if(raw.includes('duplicate_week_number'))return'This week already exists in the selected season.';
  if(raw.includes('invalid_week_number'))return'Enter a week number between 1 and 25.';
  if(raw.includes('invalid_week_deadline'))return'Choose a deadline more than five minutes ahead, within 18 months.';
  if(raw.includes('invalid_week_opening'))return'Opening time must be earlier than the deadline.';
  if(raw.includes('duplicate_entry_code'))return'That participant entry code is already in use for this season.';
  if(raw.includes('invalid_entry_code'))return'Use 2–24 letters, numbers, dashes or underscores for the entry code.';
  if(raw.includes('invalid_entry_name'))return'Enter a participant name of 1–120 characters.';
  if(raw.includes('team_already_used'))return'That team has already been used by this entry.';
  if(raw.includes('entry_not_active'))return'This entry is not active, so picks cannot be submitted for it.';
  if(raw.includes('invite_unavailable'))return'This invitation is expired, already used, or no longer available.';
  if(raw.includes('invite_link_retired'))return'This invitation link uses a retired format and can no longer be used. Ask your commissioner for a new invitation link.';
  if(raw.includes('invite_link_ambiguous'))return'This invitation link is not valid. Ask your commissioner for a new invitation link.';
  if(raw.includes('entry_already_claimed'))return'This pool entry has already been claimed.';
  if(raw.includes('source_conflict:participant'))return'This person already submitted their pick. Their selection was not changed.';
  if(raw.includes('source_conflict:commissioner_'))return'The commissioner already entered a pick for this week. Your selection was not changed.';
  if(raw.includes('deadline_passed'))return'The submission deadline has passed.';
  if(raw.includes('submission_locked'))return'This submission is locked.';
  if(raw.includes('week_not_open'))return'This week is not open for submissions.';
  if(raw.includes('entry_not_owned'))return'You do not own this pool entry.';
  if(raw.includes('commissioner_required'))return'You do not have access to manage this pool. Check the pool code or contact the pool organizer.';
  if(raw.includes('pool_not_found'))return'No pool entry is available for this account. Check your invitation or contact the pool organizer.';
  if(raw.includes('unknown_team'))return'That team is not part of this week’s schedule.';
  if(raw.includes('auth_required'))return'Please sign in again to continue.';
  if(raw.includes('invite_unauthorized')||raw.includes('invite_forbidden'))return'You cannot create an invitation for that entry.';
  if(raw.includes('invalid_payload'))return'These picks do not match the configured games or Survivor rules.';
  if(raw.includes('invalid_entry_week'))return'This entry does not belong to the selected week.';
  return 'The request could not be completed. Please try again or contact the pool organizer.';
}
