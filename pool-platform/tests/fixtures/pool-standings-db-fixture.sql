\set ON_ERROR_STOP on
-- Ephemeral GitHub Actions PostgreSQL only; NEVER run against Neon staging or production.
CREATE ROLE authenticated;
CREATE TABLE public.pool_platform_tenants(
  id uuid PRIMARY KEY,status text NOT NULL
);
CREATE TABLE public.pool_platform_pools(
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL,slug text, status text NOT NULL,pool_type text NOT NULL
);
CREATE TABLE public.pool_platform_seasons(
  id uuid PRIMARY KEY,pool_id uuid NOT NULL,season integer NOT NULL,status text NOT NULL
);
CREATE TABLE public.pool_platform_weeks(
  id uuid PRIMARY KEY,season_id uuid NOT NULL,week integer NOT NULL,status text NOT NULL,
  deadline_at timestamptz NOT NULL,config jsonb NOT NULL
);
CREATE TABLE public.pool_platform_entries(
  id uuid PRIMARY KEY,season_id uuid NOT NULL,entry_code text NOT NULL,
  display_name text NOT NULL,owner_auth_user_id text,status text NOT NULL
);
CREATE TABLE public.pool_platform_memberships(
  tenant_id uuid NOT NULL,auth_user_id text NOT NULL,role text NOT NULL
);
CREATE TABLE public.pool_platform_submissions(
  id uuid PRIMARY KEY,week_id uuid NOT NULL,entry_id uuid NOT NULL,
  status text NOT NULL,source text NOT NULL,payload jsonb NOT NULL
);
CREATE FUNCTION public.pool_platform_current_user_id()
RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('test.uid',true),'') $$;

INSERT INTO public.pool_platform_tenants VALUES
 ('00000000-0000-0000-0000-000000000001','active'),
 ('00000000-0000-0000-0000-000000000002','active');
INSERT INTO public.pool_platform_pools VALUES
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','alpha','active','pickem'),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','beta','active','survivor');
INSERT INTO public.pool_platform_seasons VALUES
 ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',2026,'active'),
 ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002',2026,'active');
INSERT INTO public.pool_platform_weeks VALUES
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',9,'locked','2020-01-01T00:00:00Z','{"games":[{"id":"g1","away":{"key":"BAL"},"home":{"key":"JAX"}}]}'),
 ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001',10,'open','2100-01-01T00:00:00Z','{"games":[{"id":"g2","away":{"key":"BUF"},"home":{"key":"MIA"}}]}'),
 ('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000002',9,'final','2020-01-01T00:00:00Z','{"games":[{"id":"g3","away":{"key":"DAL"},"home":{"key":"NYG"}}]}');
INSERT INTO public.pool_platform_entries VALUES
 ('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','A','Alice','alice','active'),
 ('40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','B','Bob','bob','active'),
 ('40000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000002','C','Carol','carol','active');
INSERT INTO public.pool_platform_memberships VALUES
 ('00000000-0000-0000-0000-000000000001','commish_alpha','commissioner'),
 ('00000000-0000-0000-0000-000000000002','commish_beta','owner');
INSERT INTO public.pool_platform_submissions VALUES
 ('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','submitted','participant','{"picks":{"g1":"away"},"tiebreak":55,"secret":"not permitted"}'),
 ('50000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000003','submitted','participant','{"team":"DAL","secret":"not permitted"}');

\i migrations/20261106_pool_week_projection_snapshot.sql
SET ROLE authenticated;
DO $test$
DECLARE
  x jsonb;
  err text;
BEGIN
  PERFORM set_config('test.uid','alice',false);
  x := public.pool_platform_week_projection_snapshot('30000000-0000-0000-0000-000000000001');
  IF x->>'visibility'<>'after_deadline' OR jsonb_array_length(x->'entries')<>2
    THEN RAISE EXCEPTION 'owned pool after deadline did not return its two entries'; END IF;
  IF x->'entries'->0->'submission'->'payload' <> '{"picks":{"g1":"away"}}'::jsonb
    THEN RAISE EXCEPTION 'payload not narrowed to picks'; END IF;
  IF x::text LIKE '%secret%' OR x::text LIKE '%owner_auth_user_id%'
    THEN RAISE EXCEPTION 'PII or private payload data leaked'; END IF;
  x := public.pool_platform_week_projection_snapshot('30000000-0000-0000-0000-000000000002');
  IF x->>'visibility'<>'sealed' OR jsonb_array_length(x->'entries')<>0
    THEN RAISE EXCEPTION 'pre-deadline picks leaked'; END IF;
  PERFORM set_config('test.uid','commish_alpha',false);
  x := public.pool_platform_week_projection_snapshot('30000000-0000-0000-0000-000000000001');
  IF jsonb_array_length(x->'entries')<>2
    THEN RAISE EXCEPTION 'authorized commissioner denied'; END IF;
  PERFORM set_config('test.uid','commish_beta',false);
  BEGIN
    PERFORM public.pool_platform_week_projection_snapshot('30000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'wrong tenant commissioner was authorized';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;
  x := public.pool_platform_week_projection_snapshot('30000000-0000-0000-0000-000000000003');
  IF jsonb_array_length(x->'entries')<>1 OR x->'entries'->0->'submission'->'payload' <> '{"team":"DAL"}'::jsonb
    THEN RAISE EXCEPTION 'own tenant survivor snapshot incomplete'; END IF;
  PERFORM set_config('test.uid','outsider',false);
  BEGIN
    PERFORM public.pool_platform_week_projection_snapshot('30000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'outsider gained access';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'week_not_found' THEN RAISE; END IF;
  END;
  PERFORM set_config('test.uid','',false);
  BEGIN
    PERFORM public.pool_platform_week_projection_snapshot('30000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'unauthenticated request gained access';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
    IF err<>'auth_required' THEN RAISE; END IF;
  END;
END;
$test$;
RESET ROLE;
\echo EPHEMERAL_POOL_STANDINGS_AUTHORIZATION_PASS
