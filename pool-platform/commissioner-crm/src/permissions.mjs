// UI/domain model for commissioner delegation. Never treat browser-side checks as authorization.
// The future API must derive tenant membership and pool IDs from the authenticated server context.
export const CAPABILITIES = Object.freeze([
  ["view_pool", "View dashboard"],
  ["manage_players", "Manage players"],
  ["review_picks", "Review picks"],
  ["edit_rules", "Edit pool rules"],
  ["send_updates", "Send announcements"],
  ["share_cards", "Share graphics"],
  ["record_dues", "Track dues"]
].map(([id,label])=>Object.freeze({id,label})));

export const PRESETS = Object.freeze({
  viewer: Object.freeze(["view_pool","share_cards"]),
  scorekeeper: Object.freeze(["view_pool","review_picks","share_cards"]),
  assistant: Object.freeze(["view_pool","manage_players","review_picks","send_updates","share_cards"]),
  custom: Object.freeze([])
});
const VALID = new Set(CAPABILITIES.map(x=>x.id));

export function validateDelegation({tenantPoolIds,scope,selectedPoolIds=[],capabilities=[]}) {
  if(!Array.isArray(tenantPoolIds)||tenantPoolIds.length===0) throw new Error("No authorized pools");
  if(scope!=="all"&&scope!=="selected") throw new Error("Invalid pool scope");
  if(!Array.isArray(selectedPoolIds)||!Array.isArray(capabilities)) throw new Error("Invalid delegation");
  const pools=new Set(tenantPoolIds);
  const chosen=[...new Set(selectedPoolIds)];
  if(scope==="selected"&&chosen.length===0) throw new Error("Select at least one pool");
  if(chosen.some(id=>!pools.has(id))) throw new Error("A selected pool is outside this organization");
  const grants=[...new Set(capabilities)];
  if(grants.some(id=>!VALID.has(id))) throw new Error("Unsupported capability");
  // Staff delegation, billing, platform roles and owner rights never belong in this model.
  return Object.freeze({
    scope,
    poolIds:Object.freeze(scope==="all"?[]:chosen),
    capabilities:Object.freeze(grants)
  });
}

export function canUseDelegation(delegation,{poolId,capability,tenantPoolIds}) {
  if(!delegation||!Array.isArray(tenantPoolIds)||!tenantPoolIds.includes(poolId)) return false;
  if(!VALID.has(capability)||!delegation.capabilities?.includes(capability)) return false;
  return delegation.scope==="all"||(delegation.scope==="selected"&&delegation.poolIds?.includes(poolId));
}
