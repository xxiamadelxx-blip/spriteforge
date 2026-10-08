-- M10 phase 3 only. Depends on the release-ledger and Android-enqueue migrations.
-- This declares private immutable storage/registry; it performs no artifact transfer.

do $$
declare v_public boolean;
begin
  select public into v_public from storage.buckets where id = 'orremote-release-artifacts';
  if found and v_public then raise exception 'RELEASE_ARTIFACT_BUCKET_MUST_BE_PRIVATE'; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('orremote-release-artifacts', 'orremote-release-artifacts', false, 262144000, array['application/vnd.android.package-archive'])
  on conflict (id) do nothing;
end;
$$;

create table public.orremote_release_artifacts (
  artifact_id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.orremote_release_requests(request_id) on delete restrict,
  release_id uuid not null references public.orremote_releases(release_id) on delete restrict,
  source_sha text not null check (source_sha ~ '^[0-9a-f]{40}$'),
  storage_bucket text not null check (storage_bucket = 'orremote-release-artifacts'),
  object_path text not null unique check (object_path ~ '^android/[0-9a-f]{40}/[0-9a-f]{64}\.apk$'),
  package_name text not null check (length(trim(package_name)) > 0),
  version_name text not null check (length(trim(version_name)) > 0),
  version_code bigint not null check (version_code > 0),
  apk_sha256 text not null unique check (apk_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0),
  signer_fingerprint text not null check (signer_fingerprint ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null default now(),
  verified_by uuid not null references auth.users(id) on delete restrict,
  evidence jsonb not null default '{}'::jsonb
);

create trigger orremote_release_artifact_append_only
before update or delete on public.orremote_release_artifacts
for each row execute function public.orremote_release_deny_mutation();

alter table public.orremote_release_artifacts enable row level security;
revoke all on public.orremote_release_artifacts from anon, authenticated;

create or replace function public.orremote_record_android_artifact(
  p_request_id uuid,
  p_storage_bucket text,
  p_object_path text,
  p_package_name text,
  p_version_name text,
  p_version_code bigint,
  p_apk_sha256 text,
  p_byte_size bigint,
  p_signer_fingerprint text,
  p_evidence jsonb default '{}'::jsonb
)
returns public.orremote_release_artifacts
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor uuid := public.orremote_release_require_operator();
  v_request public.orremote_release_requests;
  v_artifact public.orremote_release_artifacts;
begin
  select * into v_request from public.orremote_release_requests
  where request_id = p_request_id and component = 'android' and lifecycle = 'running' and release_id is not null;
  if not found then raise exception 'RELEASE_REQUEST_NOT_READY'; end if;
  if lower(p_apk_sha256) !~ '^[0-9a-f]{64}$' or lower(p_signer_fingerprint) !~ '^[0-9a-f]{64}$' then raise exception 'RELEASE_ARTIFACT_DIGEST_INVALID'; end if;
  if p_object_path is distinct from ('android/' || v_request.source_sha || '/' || lower(p_apk_sha256) || '.apk') then raise exception 'RELEASE_ARTIFACT_PATH_INVALID'; end if;
  insert into public.orremote_release_artifacts (request_id, release_id, source_sha, storage_bucket, object_path, package_name, version_name, version_code, apk_sha256, byte_size, signer_fingerprint, verified_by, evidence)
  values (v_request.request_id, v_request.release_id, v_request.source_sha, p_storage_bucket, p_object_path, trim(p_package_name), trim(p_version_name), p_version_code, lower(p_apk_sha256), p_byte_size, lower(p_signer_fingerprint), v_actor, coalesce(p_evidence, '{}'::jsonb))
  returning * into v_artifact;
  perform public.orremote_release_append_event(v_request.release_id, 'candidate_verified', 'APK bytes, metadata and pinned signer verified', jsonb_build_object('artifact_id', v_artifact.artifact_id, 'request_id', v_request.request_id));
  return v_artifact;
end;
$$;

revoke all on function public.orremote_record_android_artifact(uuid, text, text, text, text, bigint, text, bigint, text, jsonb) from public;
grant execute on function public.orremote_record_android_artifact(uuid, text, text, text, text, bigint, text, bigint, text, jsonb) to authenticated;
