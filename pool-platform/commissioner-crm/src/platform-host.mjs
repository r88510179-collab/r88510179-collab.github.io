import {createCrmGateway} from "./crm-data.mjs";

// Host integration is OFF in the current sandbox. A future approved deployment
// may invoke this bridge; it relies on the existing live PlatformClient and
// same-origin Neon Auth proxy, NOT a second login stack or browser-held API key.
// The CRM React build never publishes platform-config.js or PlatformClient.
export async function loadExistingPlatformClient({
  origin = globalThis.location?.origin,
  importer = specifier=>import(/* @vite-ignore */ specifier)
}={}) {
  if(typeof origin!=="string"||!/^https:\/\//.test(origin))throw new Error("A secure app origin is required");
  if(globalThis.location?.origin&&origin!==globalThis.location.origin)throw new Error("CRM origin mismatch");
  const configUrl=new URL("/platform-config.js",origin).href;
  const clientUrl=new URL("/platform-client.js",origin).href;
  const [{PLATFORM_CONFIG},{PlatformClient}]=await Promise.all([
    importer(configUrl),importer(clientUrl)
  ]);
  if(PLATFORM_CONFIG?.mode!=="live"||!PLATFORM_CONFIG?.dataUrl)throw new Error("Live app configuration is unavailable");
  if(typeof PlatformClient!=="function")throw new Error("Existing authenticated client is unavailable");
  const client=await new PlatformClient(PLATFORM_CONFIG).init();
  return client;
}

// Preserves the existing fail-closed bridge for callers that already have a session.
export async function connectExistingPlatform(options={}) {
  const client=await loadExistingPlatformClient(options);
  const session=await client.getSession();
  if(!session?.user||!session?.session)
    throw new Error("Sign in with your NFL Pool Center account to continue.");
  return createCrmGateway(client);
}
