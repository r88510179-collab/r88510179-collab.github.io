import {validateDelegation} from "./permissions.mjs";

const validId=x=>typeof x==="string"&&x.length>0&&x.length<=256;
const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function normalizeAssistants(raw,tenantPoolIds) {
  if(!Array.isArray(raw)||!Array.isArray(tenantPoolIds))throw new Error("Invalid assistant list");
  const known=new Set(tenantPoolIds),seen=new Set();
  return Object.freeze(raw.map(person=>{
    if(!validId(person?.id)||seen.has(person.id))throw new Error("Invalid assistant identity");
    if(person.scope!=="all"&&person.scope!=="selected")throw new Error("Invalid assistant scope");
    if(!Array.isArray(person.pool_ids)||!Array.isArray(person.capabilities))throw new Error("Invalid assistant grants");
    if(person.pool_ids.some(id=>!known.has(id)))throw new Error("Assistant has an unknown pool");
    seen.add(person.id);
    return Object.freeze({
      id:person.id,
      email:String(person.email??""),
      name:String(person.name??"Existing assistant"),
      scope:person.scope,
      poolIds:Object.freeze([...new Set(person.pool_ids)]),
      capabilities:Object.freeze([...new Set(person.capabilities)])
    });
  }));
}

export function prepareAssistantRequest({tenantId,email=null,userId=null,scope,poolIds,capabilities,tenantPoolIds}) {
  if(typeof tenantId!=="string"||!uuid.test(tenantId))throw new Error("Invalid organization");
  const delegation=validateDelegation({tenantPoolIds,scope,selectedPoolIds:poolIds,capabilities});
  if(!delegation.capabilities.includes("view_pool") && delegation.capabilities.length>0)
    throw new Error("Enable 'View dashboard' for assistants with other permissions");
  if(userId!==null){
    if(!validId(userId))throw new Error("Choose a valid assistant");
    return Object.freeze({kind:"update",tenantId,userId,scope:delegation.scope,
      poolIds:delegation.poolIds,capabilities:delegation.capabilities});
  }
  const normalized=String(email??"").trim().toLowerCase();
  if(normalized.length>254||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized))
    throw new Error("Enter the verified email address of your assistant");
  return Object.freeze({kind:"add",tenantId,email:normalized,scope:delegation.scope,
    poolIds:delegation.poolIds,capabilities:delegation.capabilities});
}
