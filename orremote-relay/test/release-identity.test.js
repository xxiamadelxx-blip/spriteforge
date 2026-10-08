import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadReleaseIdentity } from '../src/release-identity.js';

test('release identity is read only from a valid deployed manifest, never an environment value', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orremote-release-manifest-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(loadReleaseIdentity(root), null);
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify({ source_sha: 'a'.repeat(40), manifest_sha256: 'b'.repeat(64) }));
  assert.deepEqual(loadReleaseIdentity(root), { sourceSha: 'a'.repeat(40), manifestHash: 'b'.repeat(64) });
  fs.writeFileSync(path.join(root, 'release-manifest.json'), JSON.stringify({ source_sha: 'bad', manifest_sha256: 'b'.repeat(64) }));
  assert.equal(loadReleaseIdentity(root), null);
});
