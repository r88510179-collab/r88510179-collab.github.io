// Neon Function entry point (bundled to a single index.mjs by `npm run bundle`). Configuration is read once per
// instance from the deployment's protected environment; a configuration the guards refuse makes every request answer
// 503 "misconfigured" (the reason is logged without any secret value) instead of running half-configured.
import pg from 'pg';
import {loadConfig} from './config.mjs';
import {createPublicReader} from './public-read.mjs';
import {createJwtVerifier} from './auth.mjs';
import {createPushSender} from './webpush.mjs';
import {createApp} from './app.mjs';

let app = null, failure = null;

export function buildFromEnv(env, overrides = {}) {
  const cfg = loadConfig(env);
  // Small pool, short idle timeout: connections close within seconds of a cycle so the Neon compute can scale to zero.
  const pool = overrides.pool || new pg.Pool({connectionString: cfg.databaseUrl, max: 3, idleTimeoutMillis: 2000, connectionTimeoutMillis: 10000});
  pool.on?.('error', () => {});
  return createApp({
    cfg, pool,
    reader: overrides.reader || createPublicReader({authUrl: cfg.authUrl, dataUrl: cfg.dataUrl}),
    send: overrides.send || createPushSender(cfg.vapid),
    verifyPublisher: overrides.verifyPublisher || createJwtVerifier({jwksUrl: cfg.jwksUrl, issuer: cfg.authOrigin, audience: cfg.authOrigin, publisherEmail: cfg.publisherEmail}),
    log: message => console.log(`[pool-alerts] ${message}`),
    ...(overrides.services ? {services: overrides.services} : {}),
    ...(overrides.now ? {now: overrides.now} : {}),
    ...(overrides.sleep ? {sleep: overrides.sleep} : {})
  });
}

export default {
  async fetch(request) {
    if (!app && !failure) {
      try { app = buildFromEnv(process.env); }
      catch (error) { failure = error; console.error(`[pool-alerts] configuration refused: ${error.message}`); }
    }
    if (failure) {
      return new Response(JSON.stringify({error: 'misconfigured'}), {status: 503,
        headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
    }
    return app.fetch(request);
  }
};
