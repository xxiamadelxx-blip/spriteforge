import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

test('production npm install does not execute repository-only test fixtures during lifecycle', () => {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  assert.equal(pkg.scripts.postinstall, undefined,
    'production Render npm install must not run npm test: mirror ships only runtime subtree');
  assert.equal(typeof pkg.scripts.check, 'string');
  assert.equal(typeof pkg.scripts.test, 'string');
  assert.equal(typeof pkg.scripts.start, 'string');
});
