-- Commercial V1 pre-registration hardening - live Neon Auth IDENTITY AUDIT (read-only, aggregates only).
-- Run on the commercial database, connected as the role that owns the migrations, at each point the controlled
-- rollout in docs/PRE_REGISTRATION_HARDENING.md names. It is one SELECT over neon_auth."user", neon_auth.account,
-- neon_auth.session and the commercial membership and entry tables. It returns counts only, never an id, email,
-- token, IP address or user agent. It writes nothing, and can be wrapped in BEGIN READ ONLY; ... ROLLBACK;.
--
-- What it looks for (docs/PRE_REGISTRATION_HARDENING.md, Race A and Race B):
--   - an unverified Neon Auth user that holds a password or OAuth account: the shape a pre-registration leaves;
--   - a live session (expiresAt still ahead) held by an unverified user, or by a user with any account row.
--     require_email_verification (N0) refuses only new password sign-ins, so a session minted before N0 survives
--     it. Race B needs exactly such a session, and migration 004 cannot tell its JWT apart from the owner's.
--
-- required = true  -> a gate: ok must be true.
-- required = false -> informational: record actual in the rollout record.
-- I99 is the verdict. Before N0 a failing I99 is a finding to remediate inside the rollout window. From the audit
-- after N0 on, anything but PASS is a STOP. An error while running this file (for example, the role cannot read a
-- neon_auth table) is also a STOP.
WITH
users AS (
  SELECT u.id::text AS id,u."emailVerified" AS verified,COALESCE(u.banned,false) AS banned,
         lower(btrim(u.email)) LIKE 'pp-cv1-%@example.com' AS synthetic,
         EXISTS (SELECT 1 FROM neon_auth.account a WHERE a."userId"=u.id) AS has_account
  FROM neon_auth."user" u
),
-- Sessions Better Auth would still accept: it refuses a session once expiresAt has passed.
live AS (
  SELECT s."userId"::text AS user_id,s."impersonatedBy" IS NOT NULL AS impersonated
  FROM neon_auth.session s
  WHERE s."expiresAt">now()
),
providers AS (
  SELECT a."providerId" AS provider,count(DISTINCT a."userId") AS holders
  FROM neon_auth.account a
  GROUP BY a."providerId"
),
-- 004 refuses every user with an account row, so whatever such a user holds in V1 becomes inert.
refused AS (SELECT id FROM users WHERE has_account),
checks(check_id,check_name,required,expected,actual,ok) AS (
  SELECT 'I01','Neon Auth users',false,'report',
         'total='||count(*)||'; verified='||count(*) FILTER (WHERE verified)||'; unverified='||count(*) FILTER (WHERE NOT verified)
           ||'; banned='||count(*) FILTER (WHERE banned),
         NULL::boolean
  FROM users
  UNION ALL
  SELECT 'I02','users with a password or OAuth account, by provider',false,'report',
         COALESCE((SELECT string_agg(provider||'='||holders,'; ' ORDER BY provider) FROM providers),'none'),
         NULL
  UNION ALL
  SELECT 'I03','unverified users with a password or OAuth account (the pre-registration shape)',false,
         'report: each is classified in the rollout record; the synthetic live-harness identities cannot receive mail',
         count(*)||' (synthetic pp-cv1-*@example.com: '||count(*) FILTER (WHERE synthetic)||'; other: '||count(*) FILTER (WHERE NOT synthetic)||')',
         NULL
  FROM users WHERE NOT verified AND has_account
  UNION ALL
  SELECT 'I04','verified users with a password or OAuth account (contested: 004 refuses them)',false,
         'report: each one with V1 standing (I08) needs the contested-identity recovery',
         count(*)::text,
         NULL
  FROM users WHERE verified AND has_account
  UNION ALL
  SELECT 'I05','live sessions of unverified users',true,
         '0: revoke them (after N0) and run this file again',
         count(*)||' sessions of '||count(DISTINCT l.user_id)||' users',
         count(*)=0
  FROM live l JOIN users u ON u.id=l.user_id WHERE NOT u.verified
  UNION ALL
  SELECT 'I06','live sessions of users with a password or OAuth account',true,
         '0: revoke them (after N0) and run this file again',
         count(*)||' sessions of '||count(DISTINCT l.user_id)||' users',
         count(*)=0
  FROM live l JOIN users u ON u.id=l.user_id WHERE u.has_account
  UNION ALL
  SELECT 'I07','live sessions',false,'report',
         'total='||count(*)||'; of verified users with no account='||count(*) FILTER (WHERE u.verified AND NOT u.has_account)
           ||'; impersonated='||count(*) FILTER (WHERE l.impersonated),
         NULL
  FROM live l LEFT JOIN users u ON u.id=l.user_id
  UNION ALL
  SELECT 'I08','V1 standing held by users with an account row (inert once 004 is applied)',false,'report',
         'memberships='||(SELECT count(*) FROM public.pool_platform_memberships m WHERE m.auth_user_id IN (SELECT id FROM refused))
           ||'; entries owned='||(SELECT count(*) FROM public.pool_platform_entries e WHERE e.owner_auth_user_id IN (SELECT id FROM refused)),
         NULL
)
SELECT check_id,check_name,required,expected,actual,ok FROM checks
UNION ALL
SELECT 'I99','verdict',true,'every required row has ok = true',
       CASE WHEN bool_and(COALESCE(ok,false)) FILTER (WHERE required) THEN 'PASS'
            ELSE 'STOP: '||string_agg(DISTINCT check_id,', ' ORDER BY check_id) FILTER (WHERE required AND ok IS NOT TRUE) END,
       COALESCE(bool_and(COALESCE(ok,false)) FILTER (WHERE required),false)
FROM checks
ORDER BY check_id,check_name;
