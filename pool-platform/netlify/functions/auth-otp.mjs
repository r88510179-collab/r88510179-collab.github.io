// The same-origin Neon Auth proxy's two Email OTP routes on Netlify: POST /api/auth/email-otp/send-verification-otp
// and POST /api/auth/sign-in/email-otp, under the stricter of the two code-based rate limits. All the behaviour is in
// server/auth-proxy-core.mjs; server/netlify-adapter.mjs only adapts the host. Not deployed (docs/HOSTING_ARCHITECTURE.md).
import {createNetlifyHandler} from '../../server/netlify-adapter.mjs';

export default createNetlifyHandler('auth-otp',process.env);

// Netlify reads this from the source at build time: plain literals only. Exactly the core's two OTP routes, with no
// method restricted, so every method Netlify routes to functions, OPTIONS included, reaches the core. The limit
// counts requests per client IP and domain, Netlify's default aggregation. It is a hosting-spike setting, not the
// answer to how Neon limits Email OTP (docs/HOSTING_ARCHITECTURE.md, question I).
export const config={
  path:['/api/auth/email-otp/send-verification-otp','/api/auth/sign-in/email-otp'],
  rateLimit:{windowLimit:10,windowSize:180,aggregateBy:['ip','domain']}
};
