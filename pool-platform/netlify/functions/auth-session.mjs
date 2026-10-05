// The same-origin Neon Auth proxy's session routes on Netlify: GET /api/auth/get-session and POST /api/auth/sign-out,
// and every other path under /api/auth, which the core answers with its own 404 or 405. The two Email OTP routes are
// excluded here and served only by auth-otp.mjs, under its stricter rate limit. All the behaviour is in
// server/auth-proxy-core.mjs; server/netlify-adapter.mjs only adapts the host. Not deployed (docs/HOSTING_ARCHITECTURE.md).
import {createNetlifyHandler} from '../../server/netlify-adapter.mjs';

export default createNetlifyHandler('auth-session',process.env);

// Netlify reads this from the source at build time: plain literals only. /api/auth and everything under it except the
// two OTP routes, with no method restricted, so every method Netlify routes to functions, OPTIONS included, reaches
// the core. The limit counts requests per client IP and domain, Netlify's default aggregation, and is looser than the
// OTP limit because the page asks for the session before every Data API call. A hosting-spike setting.
export const config={
  path:['/api/auth','/api/auth/*'],
  excludedPath:['/api/auth/email-otp/send-verification-otp','/api/auth/sign-in/email-otp'],
  rateLimit:{windowLimit:120,windowSize:60,aggregateBy:['ip','domain']}
};
