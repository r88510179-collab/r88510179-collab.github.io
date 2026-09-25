WITH s AS (
  SELECT sub.*,e.entry_code,e.status AS entry_status,e.owner_auth_user_id,w.week,w.status AS week_status,w.opens_at,w.deadline_at,w.config,
         p.slug,p.pool_type,p.tenant_id
  FROM public.pool_platform_submissions sub
  JOIN public.pool_platform_entries e ON e.id=sub.entry_id
  JOIN public.pool_platform_weeks w ON w.id=sub.week_id
  JOIN public.pool_platform_seasons se ON se.id=w.season_id AND se.id=e.season_id
  JOIN public.pool_platform_pools p ON p.id=se.pool_id
),
a AS (
  SELECT au.*,row_number() OVER (PARTITION BY au.submission_id ORDER BY au.id) AS n,
         lag(au.next_payload) OVER (PARTITION BY au.submission_id ORDER BY au.id) AS prior_next,
         count(*) OVER (PARTITION BY au.submission_id) AS cnt
  FROM public.pool_platform_submission_audit au
),
checks(check_id,check_name,bad,actual) AS (
  SELECT 'O01','audit rows per submission = revision',
         (SELECT count(*) FROM s WHERE s.revision<>(SELECT count(*) FROM a WHERE a.submission_id=s.id)),
         (SELECT count(*)||' submissions, '||sum(revision)||' total revisions' FROM s)
  UNION ALL SELECT 'O02','first audit row is created with no previous payload; later rows are updated',
         (SELECT count(*) FROM a WHERE (n=1 AND (action<>'created' OR previous_payload IS NOT NULL)) OR (n>1 AND action<>'updated')),NULL
  UNION ALL SELECT 'O03','audit chain: each previous_payload equals the prior next_payload',
         (SELECT count(*) FROM a WHERE n>1 AND previous_payload IS DISTINCT FROM prior_next),NULL
  UNION ALL SELECT 'O04','latest audit next_payload equals the stored payload',
         (SELECT count(*) FROM s JOIN a ON a.submission_id=s.id AND a.n=a.cnt WHERE a.next_payload IS DISTINCT FROM s.payload),NULL
  UNION ALL SELECT 'O05','every audit row carries the submission source',
         (SELECT count(*) FROM a JOIN s ON s.id=a.submission_id WHERE a.source<>s.source),NULL
  UNION ALL SELECT 'O06','latest audit actor = submitted_by',
         (SELECT count(*) FROM s JOIN a ON a.submission_id=s.id AND a.n=a.cnt WHERE a.actor_auth_user_id IS DISTINCT FROM s.submitted_by_auth_user_id),NULL
  UNION ALL SELECT 'O07','participant-source audit actors are the entry owner',
         (SELECT count(*) FROM a JOIN s ON s.id=a.submission_id WHERE s.source='participant' AND a.actor_auth_user_id IS DISTINCT FROM s.owner_auth_user_id),NULL
  UNION ALL SELECT 'O08','commissioner-source audit actors are commissioners of that tenant',
         (SELECT count(*) FROM a JOIN s ON s.id=a.submission_id WHERE s.source<>'participant'
            AND NOT EXISTS (SELECT 1 FROM public.pool_platform_memberships m WHERE m.tenant_id=s.tenant_id AND m.auth_user_id=a.actor_auth_user_id)),NULL
  UNION ALL SELECT 'O09','audit ids gapless (no sequence use outside successful writes)',
         (SELECT CASE WHEN count(*)=0 OR (min(id)=1 AND max(id)=count(*)) THEN 0 ELSE 1 END FROM public.pool_platform_submission_audit),
         (SELECT 'count='||count(*)||' min='||COALESCE(min(id),0)||' max='||COALESCE(max(id),0) FROM public.pool_platform_submission_audit)
  UNION ALL SELECT 'O10','no audit rows without a submission; total audit = total revisions',
         (SELECT CASE WHEN (SELECT count(*) FROM public.pool_platform_submission_audit)=(SELECT COALESCE(sum(revision),0) FROM s) THEN 0 ELSE 1 END),NULL
  UNION ALL SELECT 'O11','no submission for a non-active entry',
         (SELECT count(*) FROM s WHERE entry_status<>'active'),NULL
  UNION ALL SELECT 'O12','no submission in a draft/locked week or before opens_at',
         (SELECT count(*) FROM s WHERE week_status IN ('draft','locked') OR (opens_at IS NOT NULL AND submitted_at<opens_at)),NULL
  UNION ALL SELECT 'O13','every submission and edit happened before its deadline',
         (SELECT count(*) FROM s WHERE submitted_at>=deadline_at OR updated_at>=deadline_at),NULL
  UNION ALL SELECT 'O14','Survivor: no team used twice by one entry',
         (SELECT count(*) FROM (SELECT entry_id,payload->>'team' FROM s WHERE pool_type='survivor' GROUP BY 1,2 HAVING count(*)>1) d),NULL
  UNION ALL SELECT 'O15','Survivor rows hold a JSON-string team only; Pick''em rows never hold a team',
         (SELECT count(*) FROM s WHERE (pool_type='survivor' AND (jsonb_typeof(payload->'team') IS DISTINCT FROM 'string' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>1))
                                   OR (pool_type='pickem' AND payload ? 'team')),NULL
  UNION ALL SELECT 'O16','every stored payload still passes the reviewed validator',
         (SELECT count(*) FROM s WHERE NOT public.pool_platform_payload_valid(pool_type,config,entry_id,week_id,payload)),NULL
  UNION ALL SELECT 'O17','participant rows were submitted by the entry owner',
         (SELECT count(*) FROM s WHERE source='participant' AND submitted_by_auth_user_id IS DISTINCT FROM owner_auth_user_id),NULL
  UNION ALL SELECT 'O18','outsider F and unverified G own nothing; PK-G01, PK-INV-EXP, PK-INV-REV unowned',
         (SELECT count(*) FROM public.pool_platform_entries e JOIN neon_auth."user" u ON u.id::text=e.owner_auth_user_id
            WHERE lower(u.email) IN ('pp-cv1-r1-f.outsider@example.com','pp-cv1-r1-g.unverified@example.com'))
         +(SELECT count(*) FROM public.pool_platform_entries WHERE entry_code IN ('PK-G01','PK-INV-EXP','PK-INV-REV') AND owner_auth_user_id IS NOT NULL),NULL
  UNION ALL SELECT 'O19','claimed invites: claimer = entry owner; G, expired and revoked invites unclaimed',
         (SELECT count(*) FROM public.pool_platform_entry_invites i JOIN public.pool_platform_entries e ON e.id=i.entry_id
            WHERE (i.claimed_by_auth_user_id IS NOT NULL AND i.claimed_by_auth_user_id IS DISTINCT FROM e.owner_auth_user_id)
               OR (e.entry_code IN ('PK-G01','PK-INV-EXP','PK-INV-REV') AND i.claimed_at IS NOT NULL)),
         (SELECT count(*)||' invites, '||count(claimed_at)||' claimed, '||count(revoked_at)||' revoked, '||count(*) FILTER (WHERE expires_at<now())||' expired' FROM public.pool_platform_entry_invites)
  UNION ALL SELECT 'O20','dual-invite entry: exactly one of its two invites claimed',
         (SELECT CASE WHEN count(*)=2 AND count(claimed_at)=1 THEN 0 ELSE 1 END FROM public.pool_platform_entry_invites i JOIN public.pool_platform_entries e ON e.id=i.entry_id WHERE e.entry_code='PK-INV-DUAL'),NULL
  UNION ALL SELECT 'O21','memberships exactly as designed (A commissioner + B co_commissioner in Tenant A; C commissioner in Tenant B)',
         (SELECT CASE WHEN count(*)=3 AND count(*) FILTER (WHERE t.slug='local-demo-group')=2 THEN 0 ELSE 1 END FROM public.pool_platform_memberships m JOIN public.pool_platform_tenants t ON t.id=m.tenant_id),
         (SELECT string_agg(t.slug||':'||m.role,', ' ORDER BY t.slug,m.role) FROM public.pool_platform_memberships m JOIN public.pool_platform_tenants t ON t.id=m.tenant_id)
  UNION ALL SELECT 'O22','source-race pairs: one row and one created audit each',
         (SELECT count(*) FROM s WHERE entry_code LIKE 'PK-RACE0_' AND (revision<>1 OR (SELECT count(*) FROM a WHERE a.submission_id=s.id)<>1)),
         (SELECT count(*)||' race rows: '||count(*) FILTER (WHERE source='participant')||' participant, '||count(*) FILTER (WHERE source='commissioner_import')||' commissioner_import' FROM s WHERE entry_code LIKE 'PK-RACE0_')
  UNION ALL SELECT 'O23','locked rows stayed locked at revision 1',
         (SELECT count(*) FROM s WHERE entry_code IN ('PK-LOCK-P','PK-LOCK-C') AND week=7 AND (status<>'locked' OR revision<>1)),NULL
)
SELECT check_id,check_name,(bad=0) AS ok,bad,actual FROM checks
UNION ALL SELECT 'O99','verdict',bool_and(bad=0),sum(bad),CASE WHEN bool_and(bad=0) THEN 'PASS' ELSE 'FINDINGS: '||string_agg(check_id,', ') FILTER (WHERE bad<>0) END FROM checks
ORDER BY 1;
