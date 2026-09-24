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

export function extractAccessToken(sessionResult){
  const data=sessionResult?.data??sessionResult??null;
  const session=data?.session??data;
  const token=session?.access_token??session?.accessToken??null;
  return typeof token==='string'&&token.length>20?token:null;
}

export function authErrorMessage(code){
  const raw=String(code??'');
  if(raw.includes('invite_email_mismatch'))return'This invitation was issued to a different email address.';
  if(raw.includes('invite_unavailable'))return'This invitation is expired, already used, or no longer available.';
  if(raw.includes('entry_already_claimed'))return'This pool entry has already been claimed.';
  if(raw.includes('source_conflict:participant'))return'This entry was already submitted directly by the participant.';
  if(raw.includes('source_conflict:commissioner_'))return'This entry was already submitted through the commissioner channel.';
  if(raw.includes('deadline_passed'))return'The submission deadline has passed.';
  if(raw.includes('submission_locked'))return'This submission is locked.';
  if(raw.includes('week_not_open'))return'This week is not open for submissions.';
  if(raw.includes('entry_not_owned'))return'You do not own this pool entry.';
  if(raw.includes('commissioner_required'))return'Commissioner access is required.';
  return raw||'The request could not be completed.';
}
