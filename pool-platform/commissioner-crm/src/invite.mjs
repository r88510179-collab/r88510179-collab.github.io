// Secure participant invitation links keep the invite secret in the URL fragment,
// never the request query or pathname. This matches existing auth-core.js routing.
const UUID=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function validateInviteRequest({entryId,email=""}){
  if(typeof entryId!=="string"||!UUID.test(entryId))throw new Error("Choose a valid participant entry");
  const normalized=String(email??"").trim().toLowerCase();
  if(normalized&&(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)||normalized.length>254))
    throw new Error("Enter a valid email or leave it blank");
  return Object.freeze({entryId,email:normalized||null,expiresHours:168});
}
export function participantInvitationLink({origin,poolSlug,token}){
  if(typeof origin!=="string"||!origin.startsWith("https://"))throw new Error("Secure origin required");
  const base=new URL(origin);
  if(base.origin!==origin.replace(/\/$/,"")||base.username||base.password)throw new Error("Invalid origin");
  if(typeof poolSlug!=="string"||!poolSlug.trim()||poolSlug.length>180)throw new Error("Invalid pool");
  if(typeof token!=="string"||!/^[\da-f]{64}$/i.test(token))throw new Error("Invalid invite token");
  const link=new URL("/participant.html",base);
  link.searchParams.set("pool",poolSlug);
  link.hash=new URLSearchParams({invite:token}).toString();
  return link.href;
}
