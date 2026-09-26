// Sandbox configuration for the unbuilt source tree. Never put a live URL here: a live build writes its own
// platform-config.js into dist/ from POOL_PLATFORM_* environment variables (scripts/build.mjs).
export const PLATFORM_CONFIG=Object.freeze({
  mode:'sandbox',
  authUrl:'',
  dataUrl:'',
  defaultPoolSlug:'demo-football-pool'
});
