import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseMirrorError, assertMirrorOutputExact, buildRelayMirrorCandidate } from '../src/release-mirror.js';

const sourceSha = 'a'.repeat(40);
const inputs = [
  { path: 'relay/src/index.js', sha: '1'.repeat(40) },
  { path: 'relay/test/relay-smoke.test.js', sha: '2'.repeat(40) },
  { path: 'relay/package.json', sha: '3'.repeat(40) },
  { path: 'relay/package-lock.json', sha: '4'.repeat(40) },
];

test('relay mirror candidate has a sorted hash manifest and identical repeated construction', () => {
  const first = buildRelayMirrorCandidate({ canonicalRepo: 'xxiamadelxx-blip/-remote', sourceSha, inputs });
  const second = buildRelayMirrorCandidate({ canonicalRepo: 'xxiamadelxx-blip/-remote', sourceSha, inputs: [...inputs].reverse() });
  assert.equal(first.manifest.manifest_sha256, second.manifest.manifest_sha256);
  assert.equal(first.treeHash, second.treeHash);
  assert.deepEqual(first.outputs.map((entry) => entry.path), [
    'orremote-relay/package-lock.json', 'orremote-relay/package.json', 'orremote-relay/release-manifest.json', 'orremote-relay/src/index.js', 'orremote-relay/test/relay-smoke.test.js',
  ]);
});

test('relay mirror rejects non-relay inputs and stale output files', () => {
  assert.throws(() => buildRelayMirrorCandidate({ canonicalRepo: 'xxiamadelxx-blip/-remote', sourceSha, inputs: [...inputs, { path: 'README.md', sha: '5'.repeat(40) }] }), (error) => error instanceof ReleaseMirrorError && error.code === 'MIRROR_INPUT_INVALID');
  const candidate = buildRelayMirrorCandidate({ canonicalRepo: 'xxiamadelxx-blip/-remote', sourceSha, inputs });
  assert.throws(() => assertMirrorOutputExact(candidate, [...candidate.outputs.map((entry) => entry.path), 'orremote-relay/stale.js']), (error) => error instanceof ReleaseMirrorError && error.code === 'MIRROR_OUTPUT_NOT_EXACT');
});
