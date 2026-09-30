// Sandbox configuration for the unbuilt source tree. Never put a live URL here: a live build writes its own
// platform-config.js into dist/ from POOL_PLATFORM_* environment variables (scripts/build.mjs). Neon Auth is never
// named here: the browser reaches it only through the same-origin proxy at /api/auth.
export const PLATFORM_CONFIG=Object.freeze({
  mode:'sandbox',
  dataUrl:'',
  defaultPoolSlug:'demo-football-pool'
});
