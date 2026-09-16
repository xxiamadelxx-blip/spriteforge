const PROFILES = Object.freeze([
  Object.freeze({ id: 'codemagic', domains: Object.freeze(['codemagic.io']), start_url: 'https://codemagic.io/apps' }),
  Object.freeze({ id: 'gitlab', domains: Object.freeze(['gitlab.com']), start_url: 'https://gitlab.com/dashboard/projects' }),
  Object.freeze({ id: 'github', domains: Object.freeze(['github.com']), start_url: 'https://github.com/' }),
  Object.freeze({ id: 'render', domains: Object.freeze(['render.com']), start_url: 'https://dashboard.render.com/' }),
  Object.freeze({ id: 'supabase', domains: Object.freeze(['supabase.com']), start_url: 'https://supabase.com/dashboard/projects' }),
  Object.freeze({ id: 'circleci', domains: Object.freeze(['circleci.com']), start_url: 'https://app.circleci.com/' }),
  Object.freeze({ id: 'railway', domains: Object.freeze(['railway.app']), start_url: 'https://railway.app/dashboard' }),
  Object.freeze({ id: 'vercel', domains: Object.freeze(['vercel.com']), start_url: 'https://vercel.com/dashboard' }),
]);

const BY_ID = new Map(PROFILES.map((profile) => [profile.id, profile]));

function normalizeHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.replace(/^www\./, '').split('/')[0];
  }
}

function hostMatchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function publicProfile(profile) {
  return profile ? { id: profile.id, domains: [...profile.domains], start_url: profile.start_url } : null;
}

export function browserAdminProfileById(id) {
  return publicProfile(BY_ID.get(String(id || '').trim().toLowerCase()) || null);
}

export function browserAdminProfileAllowsHost(id, value) {
  const profile = BY_ID.get(String(id || '').trim().toLowerCase()) || null;
  const host = normalizeHost(value);
  return Boolean(profile && host && profile.domains.some((domain) => hostMatchesDomain(host, domain)));
}

export function browserAdminProfileForHost(value) {
  const host = normalizeHost(value);
  if (!host) return null;
  const profile = PROFILES.find((candidate) => (
    candidate.domains.some((domain) => hostMatchesDomain(host, domain))
  ));
  return publicProfile(profile || null);
}
