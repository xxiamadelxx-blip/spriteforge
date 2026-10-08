import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseOAuthRevocationBackend } from '../src/oauth-supabase-backend.js';

function config() {
  return {
    supabaseUrl:'https://orremote-test.supabase.co/',
    supabasePublishableKey:'test-publishable-only',
    orremoteBusSecret:'test-secret-value-not-user-facing',
  };
}

test('Supabase revocation adapter uses existing guarded read and write RPCs, never direct public tables',async()=>{
  const calls=[];
  const fetchStub=async(url,opts)=>{
    calls.push({url,opts});
    return {ok:true,async json(){
      return String(url).endsWith('_load')?[]:true;
    }};
  };
  const backend=createSupabaseOAuthRevocationBackend(config(),fetchStub);
  assert.deepEqual(await backend.load(),[]);
  assert.equal(await backend.revoke('A'.repeat(22),Date.now()+86400000),true);
  assert.equal(calls.length,2);
  assert.ok(calls[0].url.endsWith('/rest/v1/rpc/orremote_oauth_revocations_load'));
  assert.ok(calls[1].url.endsWith('/rest/v1/rpc/orremote_oauth_revoke'));
  for(const call of calls){
    assert.equal(call.opts.method,'POST');
    assert.equal(call.opts.headers.apikey,'test-publishable-only');
    assert.equal(JSON.parse(call.opts.body).p_bus_secret,config().orremoteBusSecret);
    assert.doesNotMatch(call.url,/grant|token|device/);
  }
});

test('Supabase remote backend rejects missing server credentials and malformed responses',async()=>{
  assert.throws(()=>createSupabaseOAuthRevocationBackend({
    ...config(),orremoteBusSecret:'',
  }),/NOT_CONFIGURED/);
  const badFetch=async()=>({ok:true,async json(){return {error:'fake success'};}});
  const backend=createSupabaseOAuthRevocationBackend(config(),badFetch);
  await assert.rejects(backend.load(),/REVOCATION_STORE_INVALID/);
  await assert.rejects(backend.revoke('A'.repeat(22),Date.now()+86400000),/RPC_FAILED/);
});

test('Supabase RPC transport fails closed on service/network rejection',async()=>{
  const unavailable=createSupabaseOAuthRevocationBackend(config(),async()=>({ok:false,status:401}));
  await assert.rejects(unavailable.load(),/RPC_FAILED/);
  await assert.rejects(unavailable.revoke('A'.repeat(22),Date.now()+86400000),/RPC_FAILED/);
});
