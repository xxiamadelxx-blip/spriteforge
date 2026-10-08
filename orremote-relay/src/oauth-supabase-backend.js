// Durable OAuth revocations through the existing private Ø Remote Supabase RPC gate.
// Public publishable API key is not a database secret; the independently configured
// ORREMOTE_BUS_SECRET remains server-only and is checked by PostgreSQL on each RPC.
export function createSupabaseOAuthRevocationBackend(config, fetchImpl = fetch) {
  const url = String(config?.supabaseUrl || '').replace(/[/]+$/, '');
  const key = String(config?.supabasePublishableKey || '');
  const secret = String(config?.orremoteBusSecret || '');
  if (!/^https:\/\//.test(url) || !key || !secret) throw new Error('OAUTH_REVOCATION_SUPABASE_NOT_CONFIGURED');
  async function rpc(name, params) {
    const response = await fetchImpl(url + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: {
        apikey: key, authorization: 'Bearer ' + key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_bus_secret: secret, ...params }),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error('OAUTH_REVOCATION_SUPABASE_RPC_FAILED');
    try { return await response.json(); }
    catch { throw new Error('REVOCATION_STORE_INVALID'); }
  }
  return Object.freeze({
    async load() {
      const response = await rpc('orremote_oauth_revocations_load', {});
      if (!Array.isArray(response)) throw new Error('REVOCATION_STORE_INVALID');
      return response;
    },
    async revoke(id, expiresAt) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(id || '') || !Number.isSafeInteger(expiresAt)) throw new Error('REVOCATION_STORE_INVALID');
      const response = await rpc('orremote_oauth_revoke', {
        p_grant_id: id,
        p_expires_at: new Date(expiresAt).toISOString(),
      });
      if (response !== true) throw new Error('OAUTH_REVOCATION_SUPABASE_RPC_FAILED');
      return true;
    },
  });
}
