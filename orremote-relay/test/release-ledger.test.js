import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseLedger, ReleaseLedgerError } from '../src/release-ledger.js';

const sha = 'a'.repeat(40);
const ledger = () => new ReleaseLedger({ operatorIds: ['operator'], idFactory: (() => { let n = 0; return (kind) => `${kind}-${++n}`; })() });
const fails = (code, fn) => assert.throws(fn, (error) => error instanceof ReleaseLedgerError && error.code === code);

test('only a release operator may create identities, append events, request work, or move pointers', () => {
  const subject = ledger();
  fails('RELEASE_OPERATOR_REQUIRED', () => subject.createRelease({ actorId: 'device-token', component: 'android', releaseIdentity: 'android:x', sourceSha: sha }));
  const release = subject.createRelease({ actorId: 'operator', component: 'android', releaseIdentity: 'android:x', sourceSha: sha });
  fails('RELEASE_OPERATOR_REQUIRED', () => subject.appendEvent({ actorId: 'device-token', releaseId: release.releaseId, eventType: 'candidate_verified', reason: 'no' }));
});

test('release identities are immutable and rejected or failed releases cannot silently become accepted', () => {
  const subject = ledger();
  const release = subject.createRelease({ actorId: 'operator', component: 'android', releaseIdentity: 'android:immutable', sourceSha: sha });
  assert.equal(subject.createRelease({ actorId: 'operator', component: 'android', releaseIdentity: 'android:immutable', sourceSha: sha }).releaseId, release.releaseId);
  fails('RELEASE_IDENTITY_CONFLICT', () => subject.createRelease({ actorId: 'operator', component: 'relay', releaseIdentity: 'android:immutable', sourceSha: sha }));
  subject.appendEvent({ actorId: 'operator', releaseId: release.releaseId, eventType: 'rejected', reason: 'signer mismatch' });
  fails('RELEASE_TERMINAL', () => subject.appendEvent({ actorId: 'operator', releaseId: release.releaseId, eventType: 'accepted', reason: 'must not revive' }));
});

test('legacy import remains legacy_unverified and cannot advance an accepted pointer', () => {
  const subject = ledger();
  const release = subject.createRelease({ actorId: 'operator', component: 'android', releaseIdentity: 'legacy:android:0.5.0-m5.173' });
  subject.appendEvent({ actorId: 'operator', releaseId: release.releaseId, eventType: 'legacy_observed', reason: 'read-only baseline' });
  const legacy = subject.appendEvent({ actorId: 'operator', releaseId: release.releaseId, eventType: 'legacy_unverified', reason: 'historical acceptance incomplete' });
  fails('RELEASE_POINTER_TARGET_INVALID', () => subject.compareAndSwapPointer({ actorId: 'operator', pointerName: 'accepted_android', releaseId: release.releaseId, eventId: legacy.eventId, expectedRevision: 0, reason: 'must remain unset' }));
  assert.equal(subject.getPointer('accepted_android').revision, 0);
});

test('CAS accepts only a verified matching component event and records the previous revision', () => {
  const subject = ledger();
  const release = subject.createRelease({ actorId: 'operator', component: 'relay', releaseIdentity: 'relay:one', sourceSha: sha });
  subject.appendEvent({ actorId: 'operator', releaseId: release.releaseId, eventType: 'candidate_verified', reason: 'isolated suite' });
  const accepted = subject.appendEvent({ actorId: 'operator', releaseId: release.releaseId, eventType: 'accepted', reason: 'operator acceptance' });
  const pointer = subject.compareAndSwapPointer({ actorId: 'operator', pointerName: 'accepted_relay', releaseId: release.releaseId, eventId: accepted.eventId, expectedRevision: 0, reason: 'promote accepted relay' });
  assert.equal(pointer.revision, 1);
  assert.equal(subject.getPointerEvents()[0].priorRevision, 0);
  fails('RELEASE_POINTER_CONFLICT', () => subject.compareAndSwapPointer({ actorId: 'operator', pointerName: 'accepted_relay', releaseId: release.releaseId, eventId: accepted.eventId, expectedRevision: 0, reason: 'stale retry' }));
});

test('idempotent request retries return one record; a failed attempt needs explicit retry identity and cause', () => {
  const subject = ledger();
  const input = { actorId: 'operator', component: 'android', sourceSha: sha, workflowId: 'android-m1', buildProfile: 'candidate', idempotencyKey: 'request-key-1', attemptId: 'attempt-1' };
  const first = subject.request(input);
  assert.equal(subject.request({ ...input, attemptId: 'ignored-on-idempotent-retry' }).requestId, first.requestId);
  subject.transitionRequest({ actorId: 'operator', requestId: first.requestId, expectedLifecycle: 'recorded', nextLifecycle: 'failed' });
  fails('RETRY_REQUIRES_TERMINAL_PREDECESSOR', () => subject.request({ ...input, idempotencyKey: 'request-key-2', attemptId: 'attempt-2' }));
  const retry = subject.request({ ...input, idempotencyKey: 'request-key-2', attemptId: 'attempt-2', retryOf: first.requestId, retryReason: 'explicit operator retry after recorded failure' });
  assert.notEqual(retry.requestId, first.requestId);
});
