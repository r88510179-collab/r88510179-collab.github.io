// Read-model adapter for the EXISTING authenticated PlatformClient.
// Never takes a user ID, JWT, tenant ID, or arbitrary RPC name from an interface control.
// The client instance must be associated with one authenticated session; discard the
// store on sign-out or account change. The server is the sole authority for pool access.
const isUuid=v=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const array=x=>Array.isArray(x)?x:[];
const active=x=>x==="active"||x==="submitted"||x==="locked"||x==="final";

export function normalizePoolList(raw) {
  if(!Array.isArray(raw))throw new Error("Invalid commissioner pool response");
  const seen=new Set();
  return raw.map(x=>{
    if(!x||!isUuid(x.id)||typeof x.slug!=="string"||!x.slug.trim())throw new Error("Invalid pool identity");
    if(seen.has(x.id))throw new Error("Duplicate pool identity");
    seen.add(x.id);
    return Object.freeze({
      id:x.id,
      tenantId:x.tenant_id,
      slug:x.slug,
      name:String(x.display_name||"Pool"),
      type:x.pool_type==="survivor"?"Survivor":"Pick'em",
      status:x.status,
      duesTrackingEnabled:x.dues_tracking_enabled===true,
      permissions:Object.freeze(x.permissions&&typeof x.permissions==="object"?{...x.permissions}:{})
    });
  });
}

export function normalizeCommissionerContext(raw,expectedPool) {
  if(!expectedPool||!isUuid(expectedPool.id))throw new Error("Pool identity required");
  if(raw?.pool?.id!==expectedPool.id||raw.pool.slug!==expectedPool.slug)throw new Error("Pool response did not match request");
  const seasons=array(raw.seasons);
  const season=seasons.find(s=>s.status==="active")??seasons[0];
  const weeks=array(season?.weeks);
  const week=weeks.find(w=>w.status==="open")??weeks[weeks.length-1];
  const entries=array(season?.entries).filter(e=>e.status==="active");
  const count=entries.filter(e=>array(e.submissions).some(sub=>sub.week===week?.week&&active(sub.status))).length;
  return Object.freeze({
    id:expectedPool.id,
    name:expectedPool.name,
    type:expectedPool.type,
    slug:expectedPool.slug,
    tenantId:expectedPool.tenantId,
    permissions:expectedPool.permissions,
    duesTrackingEnabled:expectedPool.duesTrackingEnabled,
    entries:entries.length,
    submitted:count,
    week:week?.week??null,
    season:season?.season??null,
    roster:Object.freeze(entries.map(e=>Object.freeze({
      id:e.id,
      name:String(e.display_name||e.entry_code||"Entry"),
      entryCode:String(e.entry_code||""),
      pool:expectedPool.id,
      submitted:array(e.submissions).some(sub=>sub.week===week?.week&&active(sub.status)),
      charge:0,
      initialPaid:0
    })))
  });
}

export function normalizeDuesRows(raw,expectedPoolId) {
  if(!Array.isArray(raw))throw new Error("Invalid dues response");
  return raw.map(e=>{
    if(!isUuid(e?.id))throw new Error("Invalid dues entry");
    for(const key of ["charged_cents","paid_cents","balance_cents"]){
      if(!Number.isSafeInteger(Number(e[key])))throw new Error("Invalid ledger total");
    }
    return Object.freeze({
      id:e.id,
      name:String(e.display_name||e.entry_code||"Entry"),
      entryCode:String(e.entry_code||""),
      pool:expectedPoolId,
      submitted:false,
      charge:Number(e.charged_cents),
      initialPaid:Number(e.paid_cents),
      balanceOverride:Number(e.balance_cents)
    });
  });
}

export function createCrmGateway(existingPlatformClient) {
  if(!existingPlatformClient||typeof existingPlatformClient.rpc!=="function"||
     typeof existingPlatformClient.commissionerContext!=="function")
    throw new Error("An authenticated PlatformClient is required");
  return Object.freeze({
    listPools:()=>existingPlatformClient.rpc("pool_platform_crm_pools"),
    readContext:pool=>existingPlatformClient.commissionerContext(pool.slug),
    readDues:pool=>existingPlatformClient.rpc("pool_platform_crm_dues_summary",{p_pool_id:pool.id}),
    listAssistants:tenantId=>existingPlatformClient.rpc("pool_platform_crm_assistants",{p_tenant_id:tenantId}),
    addAssistant:request=>existingPlatformClient.rpc("pool_platform_crm_add_assistant",{
      p_tenant_id:request.tenantId,p_email:request.email,p_scope:request.scope,
      p_pool_ids:request.poolIds,p_capabilities:request.capabilities
    }),
    updateAssistant:request=>existingPlatformClient.rpc("pool_platform_crm_update_assistant",{
      p_tenant_id:request.tenantId,p_staff_user_id:request.userId,p_scope:request.scope,
      p_pool_ids:request.poolIds,p_capabilities:request.capabilities
    })
  });
}

// In-memory, per-auth-session cache: switching from pool A -> B -> A does not refetch A.
// Failed reads must not remain cached. Explicit invalidation is required after writes.
// No localStorage, IndexedDB, shared cookie, or persistent user-specific cache.
export function createCrmSessionStore(gateway) {
  if(!gateway||typeof gateway.listPools!=="function"||typeof gateway.readContext!=="function")
    throw new Error("Invalid CRM gateway");
  const contexts=new Map(),dues=new Map();
  let pools=null;
  const once=(map,key,read)=>{
    if(!map.has(key)){
      const promise=Promise.resolve().then(read).catch(e=>{if(map.get(key)===promise)map.delete(key);throw e;});
      map.set(key,promise);
    }
    return map.get(key);
  };
  return Object.freeze({
    listPools(){if(!pools)pools=Promise.resolve().then(()=>gateway.listPools()).then(normalizePoolList).catch(e=>{pools=null;throw e});return pools;},
    readContext(pool){if(!isUuid(pool?.id))throw new Error("Pool required");return once(contexts,pool.id,async()=>normalizeCommissionerContext(await gateway.readContext(pool),pool));},
    readDues(pool){
      if(!isUuid(pool?.id)||pool.permissions?.record_dues!==true||pool.duesTrackingEnabled!==true)
        throw new Error("Dues tracking unavailable");
      if(typeof gateway.readDues!=="function")throw new Error("Ledger endpoint unavailable");
      return once(dues,pool.id,async()=>normalizeDuesRows(await gateway.readDues(pool),pool.id));
    },
    invalidate(poolId){contexts.delete(poolId);dues.delete(poolId);},
    clear(){contexts.clear();dues.clear();pools=null;}
  });
}
