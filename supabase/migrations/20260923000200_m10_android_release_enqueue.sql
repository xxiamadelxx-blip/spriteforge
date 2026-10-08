-- M10 phase 2 only. Depends on 20260923000100_m10_release_ledger.sql.
-- This creates a reviewable queue contract; it does not call GitHub or Codemagic.

alter table public.orremote_release_requests
  add column source_repo text,
  add column release_id uuid references public.orremote_releases(release_id) on delete restrict,
  add column tag_ref text,
  add column request_reason text,
  add column claim_token uuid,
  add column claimed_at timestamptz,
  add column build_id text,
  add column failure jsonb;

alter table public.orremote_release_requests
  add constraint orremote_release_requests_tag_ref_format
    check (tag_ref is null or tag_ref ~ '^refs/tags/orremote/android/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  add constraint orremote_release_requests_claim_shape
    check ((claim_token is null and claimed_at is null) or (claim_token is not null and claimed_at is not null));

create unique index orremote_release_requests_unique_tag_ref
  on public.orremote_release_requests (tag_ref) where tag_ref is not null;

create or replace function public.orremote_enqueue_android_build(
  p_source_sha text,
  p_idempotency_key text,
  p_attempt_id uuid,
  p_reason text,
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
  v_request public.orremote_release_requests;
  v_release public.orremote_releases;
  v_source_sha text := lower(coalesce(p_source_sha, ''));
  v_repo constant text := 'xxiamadelxx-blip/-remote';
begin
  if v_source_sha !~ '^[0-9a-f]{40}$' then raise exception 'SOURCE_SHA_INVALID'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'RELEASE_REQUEST_REASON_REQUIRED'; end if;

  v_request := public.orremote_release_request(
    'android', v_source_sha, 'android-m1', 'candidate', p_idempotency_key, p_attempt_id, p_retry_of, p_retry_reason
  );

  if v_request.source_repo is not null then
    if v_request.source_repo is distinct from v_repo
      or v_request.tag_ref is distinct from 'refs/tags/orremote/android/' || v_request.request_id::text
      or v_request.release_id is null
      or v_request.request_reason is null then
      raise exception 'RELEASE_REQUEST_IDENTITY_CONFLICT';
    end if;
    return v_request;
  end if;

  select * into v_release from public.orremote_release_create(
    'android', 'android:' || v_source_sha || ':' || v_request.attempt_id::text, v_repo, v_source_sha,
    jsonb_build_object('request_id', v_request.request_id, 'request_reason', trim(p_reason))
  );

  update public.orremote_release_requests
  set source_repo = v_repo,
      release_id = v_release.release_id,
      tag_ref = 'refs/tags/orremote/android/' || v_request.request_id::text,
      request_reason = trim(p_reason),
      updated_at = now()
  where request_id = v_request.request_id and source_repo is null
  returning * into v_request;
  if not found then raise exception 'RELEASE_REQUEST_CONFLICT'; end if;
  return v_request;
end;
$$;

create or replace function public.orremote_claim_release_build_request(p_bus_secret text)
returns table (
  request_id uuid,
  source_repo text,
  source_sha text,
  tag_ref text,
  workflow_id text
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.orremote_secret_ok(p_bus_secret) then
    raise exception 'BUS_SECRET_INVALID' using errcode = '42501';
  end if;
  return query
  with next_request as (
    select r.request_id
    from public.orremote_release_requests r
    where r.component = 'android'
      and r.lifecycle = 'recorded'
      and r.claim_token is null
      and r.source_repo = 'xxiamadelxx-blip/-remote'
      and r.tag_ref is not null
      and r.release_id is not null
    order by r.created_at, r.request_id
    for update skip locked
    limit 1
  ), claimed as (
    update public.orremote_release_requests r
    set claim_token = gen_random_uuid(), claimed_at = now(), updated_at = now()
    from next_request n
    where r.request_id = n.request_id
    returning r.request_id, r.source_repo, r.source_sha, r.tag_ref, r.workflow_id
  )
  select * from claimed;
end;
$$;

create or replace function public.orremote_start_release_build_request(
  p_bus_secret text,
  p_request_id uuid,
  p_build_id text,
  p_source_sha text,
  p_tag_ref text
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.orremote_secret_ok(p_bus_secret) then
    raise exception 'BUS_SECRET_INVALID' using errcode = '42501';
  end if;
  if p_build_id is null or length(trim(p_build_id)) = 0 then raise exception 'CODEMAGIC_BUILD_ID_MISSING'; end if;
  update public.orremote_release_requests
  set lifecycle = 'running', build_id = trim(p_build_id), updated_at = now()
  where request_id = p_request_id
    and lifecycle = 'recorded'
    and claim_token is not null
    and source_sha = lower(p_source_sha)
    and tag_ref = p_tag_ref;
  if not found then raise exception 'RELEASE_REQUEST_CONFLICT'; end if;
  return true;
end;
$$;

create or replace function public.orremote_fail_release_build_request(
  p_bus_secret text,
  p_request_id uuid,
  p_error jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public.orremote_secret_ok(p_bus_secret) then
    raise exception 'BUS_SECRET_INVALID' using errcode = '42501';
  end if;
  update public.orremote_release_requests
  set lifecycle = 'failed', failure = coalesce(p_error, '{}'::jsonb), updated_at = now()
  where request_id = p_request_id and lifecycle = 'recorded' and claim_token is not null;
  if not found then raise exception 'RELEASE_REQUEST_CONFLICT'; end if;
  return true;
end;
$$;

revoke all on function public.orremote_enqueue_android_build(text, text, uuid, text, uuid, text), public.orremote_claim_release_build_request(text), public.orremote_start_release_build_request(text, uuid, text, text, text), public.orremote_fail_release_build_request(text, uuid, jsonb) from public;
grant execute on function public.orremote_enqueue_android_build(text, text, uuid, text, uuid, text) to authenticated;
grant execute on function public.orremote_claim_release_build_request(text), public.orremote_start_release_build_request(text, uuid, text, text, text), public.orremote_fail_release_build_request(text, uuid, jsonb) to anon, authenticated;
