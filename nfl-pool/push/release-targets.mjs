// What a Pool Alerts release may touch, per environment: exact Neon project, branch, endpoint, database and roles for
// the Personal Pool database; the function project, branch and slug of the sender; the sender's public configuration;
// the hourly trigger; the app sites. Nothing secret is here. The release refuses to act when what Neon reports differs.
import {PRODUCTION} from './config.mjs';

export const TARGETS = Object.freeze({
  production: Object.freeze({
    app: 'personal', environment: 'production',
    database: Object.freeze({projectId: 'flat-cake-85432375', projectName: 'NFL Pool', branchId: 'br-icy-thunder-auknamhk', database: 'nfl_pool',
      ownerRole: 'nfl_pool_owner', endpointId: 'ep-muddy-forest-au7eygkw', host: 'ep-muddy-forest-au7eygkw.c-10.us-east-1.aws.neon.tech', publicTables: 5}),
    sender: Object.freeze({projectId: 'patient-thunder-85353337', projectName: 'NFL Pool Functions', branchId: 'br-late-hat-b55ygmj4', slug: 'poolalerts',
      url: 'https://br-late-hat-b55ygmj4-poolalerts.compute.c-7.us-east-2.aws.neon.tech', sameProjectAsDatabase: false}),
    // Sent on every deployment, so production's configuration is exactly what this file says.
    env: Object.freeze({NEON_DATA_URL: PRODUCTION.dataUrl, NEON_AUTH_URL: PRODUCTION.authUrl, APP_ORIGINS: PRODUCTION.origins.join(','),
      PUBLISHER_EMAIL: PRODUCTION.publisherEmail, VAPID_SUBJECT: 'https://picks.smokkeventures.com/nfl-pool/'}),
    trigger: Object.freeze({name: 'pool-alerts-hourly', cron: '17 * * * *', path: '/v1/cron'}),
    apps: Object.freeze(['https://r88510179-collab.github.io/nfl-pool/', 'https://picks.smokkeventures.com/nfl-pool/']),
    backupPrefix: 'backup-before-pool-alerts'
  }),
  staging: Object.freeze({
    app: 'personal', environment: 'staging',
    database: Object.freeze({projectId: 'dry-sea-47243965', projectName: 'pool-alerts-staging-20261126', branchId: 'br-rough-smoke-bccichyp', database: 'nfl_pool',
      ownerRole: 'nfl_pool_owner', endpointId: 'ep-empty-art-bchi4pzb', host: 'ep-empty-art-bchi4pzb.c-16.us-east-1.aws.neon.tech', publicTables: null}),
    sender: Object.freeze({projectId: 'dry-sea-47243965', projectName: 'pool-alerts-staging-20261126', branchId: 'br-rough-smoke-bccichyp', slug: 'poolalerts',
      url: 'https://br-rough-smoke-bccichyp-poolalerts.compute.c-16.us-east-1.aws.neon.tech', sameProjectAsDatabase: true}),
    // Staging keeps the publisher e-mail and VAPID subject it was created with (not sent, so Neon keeps them). The two
    // origins are the owner-only Vercel previews of the release branches (push-client.mjs maps previews to staging).
    env: Object.freeze({NEON_DATA_URL: 'https://ep-empty-art-bchi4pzb.apirest.c-16.us-east-1.aws.neon.tech/nfl_pool/rest/v1',
      NEON_AUTH_URL: 'https://ep-empty-art-bchi4pzb.neonauth.c-16.us-east-1.aws.neon.tech/nfl_pool/auth',
      APP_ORIGINS: ['https://nfl-pool-personal-git-ccr-cdd-4f5bad-r88510179-collabs-projects.vercel.app',
        'https://nfl-pool-personal-git-ccr-161-71e00c-r88510179-collabs-projects.vercel.app'].join(',')}),
    trigger: Object.freeze({name: 'pool-alerts-hourly', cron: '17 * * * *', path: '/v1/cron'}),
    apps: Object.freeze([]),
    backupPrefix: 'backup-before-pool-alerts'
  })
});
