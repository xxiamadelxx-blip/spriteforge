import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthRevocationStore } from '../src/oauth-revocations.js';

const ID='A'.repeat(22);
const OTHER='B'.repeat(22);

test('remote revocation journal is fail-closed before successful hydration and survives restart', async () => {
  const database=new Map();
  const backend={
    async load() { return [...database].map(([id,expires_at])=>({id,expires_at})); },
    async revoke(id,expires_at) { database.set(id,expires_at); return true; },
  };
  const first=createOAuthRevocationStore('',backend);
  assert.equal(first.durable,true);
  assert.equal(first.ready,false);
  assert.equal(first.isRevoked(ID),true);
  await first.initialize();
  assert.equal(first.ready,true);
  assert.equal(first.isRevoked(ID),false);
  assert.equal(await first.revoke(ID,86400000),true);
  assert.equal(first.isRevoked(ID),true);
  const restarted=createOAuthRevocationStore('',backend);
  assert.equal(restarted.isRevoked(ID),true);
  await restarted.initialize();
  assert.equal(restarted.isRevoked(ID),true);
  assert.equal(restarted.isRevoked(OTHER),false);
});

test('remote journal may not report success until durable RPC confirms and never mutates on failure', async () => {
  let reject=true;
  const backend={
    async load() { return []; },
    async revoke() { if(reject) throw new Error('BACKEND_FAILED'); return true; },
  };
  const store=createOAuthRevocationStore('',backend);
  await store.initialize();
  await assert.rejects(store.revoke(ID,86400000),/BACKEND_FAILED/);
  assert.equal(store.isRevoked(ID),false);
  reject=false;
  assert.equal(await store.revoke(ID,86400000),true);
  assert.equal(store.isRevoked(ID),true);
});

test('corrupt or unavailable RPC hydration never releases token access', async () => {
  for(const payload of [[{id:'broken',expires_at:Date.now()+60000}],null,{},[{id:ID,expires_at:'tomorrow'}]]) {
    const store=createOAuthRevocationStore('',{async load(){return payload;},async revoke(){return true;}});
    await assert.rejects(store.initialize(),/REVOCATION_STORE_INVALID/);
    assert.equal(store.ready,false);
    assert.equal(store.isRevoked(ID),true);
  }
  const unavailable=createOAuthRevocationStore('',{async load(){throw new Error('OFFLINE');},async revoke(){return true;}});
  await assert.rejects(unavailable.initialize(),/OFFLINE/);
  assert.equal(unavailable.isRevoked(ID),true);
});

test('remote revocation store rejects simultaneous local file and RPC backends', () => {
  assert.throws(()=>createOAuthRevocationStore('/tmp/unused-revocations.json',{async load(){return [];},async revoke(){return true;}}),/REVOCATION_STORE_CONFLICT/);
});


test('parallel remote revocations cannot resurrect an earlier grant after both RPC writes succeed', async () => {
  const pending = [];
  const store = createOAuthRevocationStore('', {
    async load() { return []; },
    revoke(id, expires_at) {
      return new Promise((resolve) => pending.push({ id, expires_at, resolve }));
    },
  });
  await store.initialize();
  const first = store.revoke(ID, 86_400_000);
  const second = store.revoke(OTHER, 86_400_000);
  assert.equal(pending.length, 2);
  pending[0].resolve(true);
  assert.equal(await first, true);
  pending[1].resolve(true);
  assert.equal(await second, true);
  assert.equal(store.isRevoked(ID), true, 'first confirmed revocation must remain effective');
  assert.equal(store.isRevoked(OTHER), true, 'second confirmed revocation must also remain effective');
});
