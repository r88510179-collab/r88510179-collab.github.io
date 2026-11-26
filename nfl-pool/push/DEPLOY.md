# Pool Alerts — deployment (owner-approved steps only)

Nothing below has been done to production. Each **[APPROVAL]** step changes production and needs your explicit release
authorization. Keep this order: database first (recording starts, nothing is sent), sender second (sending stays off),
phone acceptance third, then turn sending on and merge the app.

Values used below:

| Name | Value |
| --- | --- |
| Personal database | project `flat-cake-85432375` (NFL Pool), branch `br-icy-thunder-auknamhk`, database `nfl_pool`, role `nfl_pool_owner` |
| Function project | `patient-thunder-85353337` (NFL Pool Functions), branch `br-late-hat-b55ygmj4` (where `nflscores2` already runs) |
| Function slug / URL | `poolalerts` → `https://br-late-hat-b55ygmj4-poolalerts.compute.c-7.us-east-2.aws.neon.tech` (confirm in step 5) |

## 0. Preconditions

- The release PR's CI is green (NFL Pool Tests incl. `push-alerts-isolated`, Pool Alerts Browser Acceptance).
- You have the reviewed commit SHA and the bundle SHA-256 from CI (`push-alerts-isolated` job summary).
- A trusted computer with Node.js 22 (and optionally the Neon CLI, or `curl` with a Neon API key).

## 1. Backup **[APPROVAL]**

Neon Console → project **NFL Pool** → Branches → Create branch from `main` named
`backup-before-pool-alerts-YYYYMMDD` (no compute needed). The Free plan allows 10 branches; 7 exist today, so this
fits. Record its id with your release notes.

## 2. Database migration **[APPROVAL: production migration]**

Neon Console → **NFL Pool** → SQL Editor, database `nfl_pool`, role **nfl_pool_owner**:

1. Paste and run the whole of `nfl-pool/migrations/006-pool-alerts.sql`. It refuses any other role and a second run.
2. Run, in the same editor:
   ```sql
   INSERT INTO pool_alerts.environment (name) VALUES ('production');
   ```
3. Verify (expect `1 | 1 | f | 5`):
   ```sql
   SELECT (SELECT count(*) FROM pool_alerts.settings),
          (SELECT count(*) FROM pg_trigger WHERE tgname = 'nfl_pool_alerts_capture'),
          (SELECT sending_enabled FROM pool_alerts.settings),
          (SELECT count(*) FROM pg_tables WHERE schemaname = 'public');
   ```

From now on publications are recorded; nothing is sent (no sender yet, and sending is off).

## 3. Keys and the sender login **[APPROVAL]**

On the trusted computer: `node nfl-pool/push/ops.mjs keys`. It prints a VAPID key pair, the owner token, the status
token (with their SHA-256 digests) and a database password. Save them in your password manager. Then in the SQL Editor
(role nfl_pool_owner):

```sql
ALTER ROLE pool_alerts_sender LOGIN PASSWORD '<database password from ops keys>';
```

## 4. Build the artifact

```sh
git checkout <reviewed commit>
cd nfl-pool/push && npm ci && npm run bundle
```

The printed `dist/poolalerts.zip` SHA-256 must equal the one in the CI summary for that commit.

## 5. Deploy the sender **[APPROVAL]**

Create `secrets.json` outside the repository (`chmod 600`), then deploy with the Neon API (keeps secrets out of shell
history) and delete the file:

```json
{
  "POOL_ALERTS_ENV": "production",
  "POOL_ALERTS_DATABASE_URL": "postgresql://pool_alerts_sender:<password>@ep-muddy-forest-au7eygkw.c-10.us-east-1.aws.neon.tech/nfl_pool?sslmode=require",
  "NEON_DATA_URL": "https://ep-muddy-forest-au7eygkw.apirest.c-10.us-east-1.aws.neon.tech/nfl_pool/rest/v1",
  "NEON_AUTH_URL": "https://ep-muddy-forest-au7eygkw.neonauth.c-10.us-east-1.aws.neon.tech/nfl_pool/auth",
  "APP_ORIGINS": "https://r88510179-collab.github.io,https://picks.smokkeventures.com",
  "PUBLISHER_EMAIL": "<the authorized publisher e-mail used by Admin>",
  "VAPID_PUBLIC_KEY": "<from ops keys>",
  "VAPID_PRIVATE_KEY": "<from ops keys>",
  "VAPID_SUBJECT": "https://picks.smokkeventures.com/nfl-pool/",
  "OWNER_TOKEN_SHA256": "<from ops keys>",
  "STATUS_TOKEN_SHA256": "<from ops keys>",
  "POOL_ALERTS_SENDING": "enabled",
  "POOL_ALERTS_VERSION": "<reviewed commit SHA>"
}
```

```sh
curl -sS -X POST "https://console.neon.tech/api/v2/projects/patient-thunder-85353337/branches/br-late-hat-b55ygmj4/functions/poolalerts/deployments" \
  -H "Authorization: Bearer $NEON_API_KEY" -F "zip=@dist/poolalerts.zip" -F "runtime=nodejs24" -F "environment=<secrets.json"
rm secrets.json
```

(`POOL_ALERTS_SENDING=enabled` only allows sending; the database switch from step 2 is still **off**.)

Check it: `node nfl-pool/push/ops.mjs health` must show `"environment": "production"`. Confirm the function's
invocation URL in the Neon Console equals `PRODUCTION_ALERT_API` in `nfl-pool/push-client.mjs` (and `PRODUCTION_URL` in
`ops.mjs`); if Neon shows a different host, update those two constants (and their tests) before merging the app.

## 6. Baseline and the hourly trigger **[APPROVAL]**

```sh
export POOL_ALERTS_OWNER_TOKEN=<owner token>
node nfl-pool/push/ops.mjs notify   # first cycle: records the baseline; nothing historical is ever announced
node nfl-pool/push/ops.mjs status   # "Planned through event #…", sending database OFF
```

Neon Console → NFL Pool Functions → Functions → `poolalerts` → ⋮ → Manage Triggers → Create trigger: name
`pool-alerts-hourly`, function path `/v1/cron`, cron `17 * * * *` (hourly, UTC). Or:
`neon triggers create --project-id patient-thunder-85353337 --branch br-late-hat-b55ygmj4 --function-slug poolalerts --name pool-alerts-hourly --cron '17 * * * *' --function-path /v1/cron`

## 7. Owner tooling

- GitHub → repository → Settings → Secrets and variables → Actions: secret `POOL_ALERTS_OWNER_TOKEN` (owner token);
  optional variable `POOL_ALERTS_URL` only if the function URL differs from the default.
- Vercel project `smokke-dashboard` → server-only env vars `POOL_ALERTS_STATUS_URL` (`<function URL>/v1/status`) and
  `POOL_ALERTS_STATUS_TOKEN` (status token); redeploy.

## 8. Merge the app **[APPROVAL: merge to main]**

Merge the reviewed release PR (exact head SHA). GitHub Pages and the Vercel production deployment of
`picks.smokkeventures.com` pick it up. Open Pool Center: the Pool Alerts card shows *Turn on alerts*.

## 9. Phone acceptance, then sending on

Follow [ACCEPTANCE.md](ACCEPTANCE.md) with sending still off for enrollment, then `node ops.mjs resume` (or Admin →
Resume sending) and run the delivery checks. Sending stays on from then on.

## Staging (isolated, needs approval to create cloud resources)

A separate free Neon project `pool-alerts-staging` (us-east-1) with database `nfl_pool` and owner role
`nfl_pool_owner`, Neon Auth (anonymous tokens allowed) and the Data API, the public `nfl_pool_weeks` table and policies
as in `nfl-pool/sql-tests/neon-shape.sql`, the full-field guard and migration 006, environment `staging`, a staging
VAPID pair, and the same function deployed there with `POOL_ALERTS_ENV=staging` and the staging URLs. The sender refuses
production URLs in staging. Add the staging site origin and function URL to `ALERT_APIS` only on a staging branch.
