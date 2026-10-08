-- M10 phase 1 only: internal release ledger.  This migration creates no build,
-- tag, Render deploy, production pointer, or device action.

create type public.orremote_release_component as enum ('android', 'relay');
create type public.orremote_release_event_type as enum (
  'candidate_verified', 'accepted', 'deployed', 'installed',
  'rejected', 'failed', 'legacy_observed', 'legacy_unverified'
);
create type public.orremote_release_request_state as enum (
  'recorded', 'running', 'succeeded', 'failed', 'rejected'
);

create table public.orremote_release_operators (
  user_id uuid primary key references auth.users(id) on delete restrict,
  scope text not null check (scope = 'release_ledger'),
  granted_at timestamptz not null default now(),
  granted_by text not null,
  revoked_at timestamptz,
  revoked_by text,
  check ((revoked_at is null) = (revoked_by is null))
);

create table public.orremote_releases (
  release_id uuid primary key default gen_random_uuid(),
  component public.orremote_release_component not null,
  release_identity text not null unique check (length(trim(release_identity)) > 0),
  source_repo text,
  source_sha text check (source_sha is null or source_sha ~ '^[0-9a-f]{40}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete restrict,
  check (source_sha is not null or release_identity like 'legacy:%')
);

create table public.orremote_release_events (
  event_id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.orremote_releases(release_id) on delete restrict,
  event_type public.orremote_release_event_type not null,
  reason text not null check (length(trim(reason)) > 0),
  evidence jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (release_id, event_type)
);

create table public.orremote_release_requests (
  request_id uuid primary key default gen_random_uuid(),
  component public.orremote_release_component not null,
  source_sha text not null check (source_sha ~ '^[0-9a-f]{40}$'),
  workflow_id text not null check (length(trim(workflow_id)) > 0),
  build_profile text not null check (length(trim(build_profile)) > 0),
  idempotency_key text not null unique check (length(trim(idempotency_key)) > 0),
  attempt_id uuid not null unique,
  retry_of uuid references public.orremote_release_requests(request_id) on delete restrict,
  retry_reason text,
  lifecycle public.orremote_release_request_state not null default 'recorded',
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((retry_of is null and retry_reason is null) or (retry_of is not null and length(trim(retry_reason)) > 0)),
  unique (component, source_sha, workflow_id, build_profile, attempt_id)
);

create unique index orremote_release_requests_one_active_attempt
  on public.orremote_release_requests (component, source_sha, workflow_id, build_profile)
  where lifecycle in ('recorded', 'running');

create table public.orremote_release_pointers (
  pointer_name text primary key check (pointer_name in ('accepted_android', 'accepted_relay', 'running_relay')),
  component public.orremote_release_component not null,
  release_id uuid references public.orremote_releases(release_id) on delete restrict,
  event_id uuid references public.orremote_release_events(event_id) on delete restrict,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete restrict,
  reason text,
  check ((release_id is null and event_id is null and reason is null) or (release_id is not null and event_id is not null and length(trim(reason)) > 0))
);

create table public.orremote_release_pointer_events (
  pointer_event_id uuid primary key default gen_random_uuid(),
  pointer_name text not null references public.orremote_release_pointers(pointer_name) on delete restrict,
  prior_release_id uuid references public.orremote_releases(release_id) on delete restrict,
  prior_event_id uuid references public.orremote_release_events(event_id) on delete restrict,
  prior_revision bigint not null check (prior_revision >= 0),
  next_release_id uuid not null references public.orremote_releases(release_id) on delete restrict,
  next_event_id uuid not null references public.orremote_release_events(event_id) on delete restrict,
  next_revision bigint not null check (next_revision = prior_revision + 1),
  actor_id uuid not null references auth.users(id) on delete restrict,
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now()
);

insert into public.orremote_release_pointers (pointer_name, component)
values ('accepted_android', 'android'), ('accepted_relay', 'relay'), ('running_relay', 'relay');

create or replace function public.orremote_release_deny_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ORREMOTE_RELEASE_LEDGER_APPEND_ONLY';
end;
$$;

create trigger orremote_release_immutable
before update or delete on public.orremote_releases
for each row execute function public.orremote_release_deny_mutation();

create trigger orremote_release_event_append_only
before update or delete on public.orremote_release_events
for each row execute function public.orremote_release_deny_mutation();

create trigger orremote_release_pointer_event_append_only
before update or delete on public.orremote_release_pointer_events
for each row execute function public.orremote_release_deny_mutation();

create or replace function public.orremote_release_require_operator()
returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not exists (
    select 1 from public.orremote_release_operators
    where user_id = v_actor and scope = 'release_ledger' and revoked_at is null
  ) then
    raise exception 'RELEASE_OPERATOR_REQUIRED' using errcode = '42501';
  end if;
  return v_actor;
end;
$$;

create or replace function public.orremote_release_create(
  p_component public.orremote_release_component,
  p_release_identity text,
  p_source_repo text,
  p_source_sha text,
  p_metadata jsonb default '{}'::jsonb
)
returns public.orremote_releases
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := public.orremote_release_require_operator();
  v_release public.orremote_releases;
begin
  if p_release_identity is null or length(trim(p_release_identity)) = 0 then
    raise exception 'RELEASE_IDENTITY_REQUIRED';
  end if;
  if p_source_sha is not null and p_source_sha !~ '^[0-9a-f]{40}$' then
    raise exception 'SOURCE_SHA_INVALID';
  end if;
  insert into public.orremote_releases (component, release_identity, source_repo, source_sha, metadata, created_by)
  values (p_component, trim(p_release_identity), p_source_repo, lower(p_source_sha), coalesce(p_metadata, '{}'::jsonb), v_actor)
  on conflict (release_identity) do nothing
  returning * into v_release;
  if found then return v_release; end if;
  select * into v_release from public.orremote_releases where release_identity = trim(p_release_identity);
  if v_release.component <> p_component or v_release.source_repo is distinct from p_source_repo or v_release.source_sha is distinct from lower(p_source_sha) then
    raise exception 'RELEASE_IDENTITY_CONFLICT';
  end if;
  return v_release;
end;
$$;

create or replace function public.orremote_release_append_event(
  p_release_id uuid,
  p_event_type public.orremote_release_event_type,
  p_reason text,
  p_evidence jsonb default '{}'::jsonb
)
returns public.orremote_release_events
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := public.orremote_release_require_operator();
  v_release public.orremote_releases;
  v_prior public.orremote_release_events;
  v_event public.orremote_release_events;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'RELEASE_EVENT_REASON_REQUIRED'; end if;
  select * into v_release from public.orremote_releases where release_id = p_release_id;
  if not found then raise exception 'RELEASE_NOT_FOUND'; end if;
  select * into v_prior from public.orremote_release_events where release_id = p_release_id order by created_at desc, event_id desc limit 1;
  if found and v_prior.event_type in ('rejected', 'failed', 'legacy_unverified') then raise exception 'RELEASE_TERMINAL'; end if;
  if not (
    (p_event_type = 'candidate_verified' and v_prior.event_id is null)
    or (p_event_type = 'accepted' and v_prior.event_type = 'candidate_verified')
    or (p_event_type = 'deployed' and v_release.component = 'relay' and v_prior.event_type = 'accepted')
    or (p_event_type = 'installed' and v_release.component = 'android' and v_prior.event_type = 'accepted')
    or (p_event_type = 'legacy_observed' and v_prior.event_id is null and v_release.release_identity like 'legacy:%')
    or (p_event_type = 'legacy_unverified' and v_prior.event_type = 'legacy_observed')
    or (p_event_type in ('rejected', 'failed') and (v_prior.event_id is null or v_prior.event_type = 'candidate_verified'))
  ) then raise exception 'RELEASE_EVENT_TRANSITION_INVALID'; end if;
  insert into public.orremote_release_events (release_id, event_type, reason, evidence, actor_id)
  values (p_release_id, p_event_type, trim(p_reason), coalesce(p_evidence, '{}'::jsonb), v_actor)
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function public.orremote_release_request(
  p_component public.orremote_release_component,
  p_source_sha text,
  p_workflow_id text,
  p_build_profile text,
  p_idempotency_key text,
  p_attempt_id uuid,
  p_retry_of uuid default null,
  p_retry_reason text default null
)
returns public.orremote_release_requests
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := public.orremote_release_require_operator();
  v_existing public.orremote_release_requests;
  v_request public.orremote_release_requests;
begin
  if p_source_sha !~ '^[0-9a-f]{40}$' then raise exception 'SOURCE_SHA_INVALID'; end if;
  if p_workflow_id is null or length(trim(p_workflow_id)) = 0 then raise exception 'WORKFLOW_ID_REQUIRED'; end if;
  if p_build_profile is null or length(trim(p_build_profile)) = 0 then raise exception 'BUILD_PROFILE_REQUIRED'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(concat_ws(':', p_component::text, lower(p_source_sha), trim(p_workflow_id), trim(p_build_profile)), 0));
  select * into v_existing from public.orremote_release_requests where idempotency_key = trim(p_idempotency_key);
  if found then return v_existing; end if;
  select * into v_existing from public.orremote_release_requests
  where component = p_component and source_sha = lower(p_source_sha) and workflow_id = trim(p_workflow_id) and build_profile = trim(p_build_profile)
  order by created_at desc, request_id desc limit 1;
  if found and v_existing.lifecycle not in ('failed', 'rejected') then return v_existing; end if;
  if found and (p_retry_of is distinct from v_existing.request_id or p_retry_reason is null or length(trim(p_retry_reason)) = 0) then
    raise exception 'RETRY_REQUIRES_TERMINAL_PREDECESSOR';
  end if;
  if not found and (p_retry_of is not null or p_retry_reason is not null) then raise exception 'RETRY_PREDECESSOR_NOT_FOUND'; end if;
  insert into public.orremote_release_requests (component, source_sha, workflow_id, build_profile, idempotency_key, attempt_id, retry_of, retry_reason, created_by)
  values (p_component, lower(p_source_sha), trim(p_workflow_id), trim(p_build_profile), trim(p_idempotency_key), p_attempt_id, p_retry_of, nullif(trim(p_retry_reason), ''), v_actor)
  returning * into v_request;
  return v_request;
end;
$$;

create or replace function public.orremote_release_set_request_lifecycle(
  p_request_id uuid,
  p_expected public.orremote_release_request_state,
  p_next public.orremote_release_request_state
)
returns public.orremote_release_requests
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := public.orremote_release_require_operator();
  v_request public.orremote_release_requests;
begin
  if not ((p_expected = 'recorded' and p_next in ('running', 'failed', 'rejected')) or (p_expected = 'running' and p_next in ('succeeded', 'failed', 'rejected'))) then
    raise exception 'RELEASE_REQUEST_TRANSITION_INVALID';
  end if;
  update public.orremote_release_requests set lifecycle = p_next, updated_at = now()
  where request_id = p_request_id and lifecycle = p_expected
  returning * into v_request;
  if not found then raise exception 'RELEASE_REQUEST_CONFLICT'; end if;
  return v_request;
end;
$$;

create or replace function public.orremote_release_compare_and_swap_pointer(
  p_pointer_name text,
  p_release_id uuid,
  p_event_id uuid,
  p_expected_revision bigint,
  p_reason text
)
returns public.orremote_release_pointers
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := public.orremote_release_require_operator();
  v_pointer public.orremote_release_pointers;
  v_next public.orremote_release_pointers;
  v_event public.orremote_release_events;
  v_required_event public.orremote_release_event_type;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'RELEASE_POINTER_REASON_REQUIRED'; end if;
  select * into v_pointer from public.orremote_release_pointers where pointer_name = p_pointer_name for update;
  if not found then raise exception 'RELEASE_POINTER_INVALID'; end if;
  if v_pointer.revision <> p_expected_revision then raise exception 'RELEASE_POINTER_CONFLICT'; end if;
  v_required_event := case p_pointer_name when 'running_relay' then 'deployed'::public.orremote_release_event_type else 'accepted'::public.orremote_release_event_type end;
  select e.* into v_event from public.orremote_release_events e join public.orremote_releases r on r.release_id = e.release_id
  where e.event_id = p_event_id and e.release_id = p_release_id and r.component = v_pointer.component and e.event_type = v_required_event;
  if not found then raise exception 'RELEASE_POINTER_TARGET_INVALID'; end if;
  update public.orremote_release_pointers
  set release_id = p_release_id, event_id = p_event_id, revision = revision + 1, updated_at = now(), updated_by = v_actor, reason = trim(p_reason)
  where pointer_name = p_pointer_name and revision = p_expected_revision
  returning * into v_next;
  if not found then raise exception 'RELEASE_POINTER_CONFLICT'; end if;
  insert into public.orremote_release_pointer_events (pointer_name, prior_release_id, prior_event_id, prior_revision, next_release_id, next_event_id, next_revision, actor_id, reason)
  values (p_pointer_name, v_pointer.release_id, v_pointer.event_id, v_pointer.revision, v_next.release_id, v_next.event_id, v_next.revision, v_actor, trim(p_reason));
  return v_next;
end;
$$;

alter table public.orremote_release_operators enable row level security;
alter table public.orremote_releases enable row level security;
alter table public.orremote_release_events enable row level security;
alter table public.orremote_release_requests enable row level security;
alter table public.orremote_release_pointers enable row level security;
alter table public.orremote_release_pointer_events enable row level security;

revoke all on public.orremote_release_operators, public.orremote_releases, public.orremote_release_events, public.orremote_release_requests, public.orremote_release_pointers, public.orremote_release_pointer_events from anon, authenticated;
revoke all on function public.orremote_release_require_operator(), public.orremote_release_create(public.orremote_release_component, text, text, text, jsonb), public.orremote_release_append_event(uuid, public.orremote_release_event_type, text, jsonb), public.orremote_release_request(public.orremote_release_component, text, text, text, text, uuid, uuid, text), public.orremote_release_set_request_lifecycle(uuid, public.orremote_release_request_state, public.orremote_release_request_state), public.orremote_release_compare_and_swap_pointer(text, uuid, uuid, bigint, text) from public, anon;
grant execute on function public.orremote_release_create(public.orremote_release_component, text, text, text, jsonb), public.orremote_release_append_event(uuid, public.orremote_release_event_type, text, jsonb), public.orremote_release_request(public.orremote_release_component, text, text, text, text, uuid, uuid, text), public.orremote_release_set_request_lifecycle(uuid, public.orremote_release_request_state, public.orremote_release_request_state), public.orremote_release_compare_and_swap_pointer(text, uuid, uuid, bigint, text) to authenticated;

-- Read-only baseline: records observed legacy identities only. It deliberately
-- leaves accepted/running pointers at revision 0 and creates no physical PASS.
insert into public.orremote_releases (component, release_identity, source_repo, source_sha, metadata)
values
  ('android', 'legacy:android:0.5.0-m5.173', null, null, '{"installed_version":"0.5.0-m5.173","status":"legacy_unverified","evidence":"docs/audits/M5_SAMOKAT_CENTER_TAP_PRODUCTIONIZATION_2026-09-23.md"}'::jsonb),
  ('relay', 'legacy:relay:9d80d4fdaaffe415a50f59da11258e5dc257a6a2', 'xxiamadelxx-blip/spriteforge', '9d80d4fdaaffe415a50f59da11258e5dc257a6a2', '{"canonical_source_sha":"bafb61f82a47baf4475c058c08bef4144b4c1a66","render_deploy_id":"dep-dappe90473hc73bqbql0","status":"legacy_unverified","evidence":"docs/audits/M5_SAMOKAT_CENTER_TAP_PRODUCTIONIZATION_2026-09-23.md"}'::jsonb)
on conflict (release_identity) do nothing;

insert into public.orremote_release_events (release_id, event_type, reason, evidence)
select release_id, 'legacy_observed', 'read-only M10 baseline import', metadata
from public.orremote_releases where release_identity like 'legacy:%'
on conflict (release_id, event_type) do nothing;

insert into public.orremote_release_events (release_id, event_type, reason, evidence)
select release_id, 'legacy_unverified', 'historical evidence imported without synthesising acceptance', metadata
from public.orremote_releases where release_identity like 'legacy:%'
on conflict (release_id, event_type) do nothing;
