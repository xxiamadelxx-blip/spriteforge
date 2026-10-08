import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRegressionCorpus, planRegressionRun } from '../scripts/regression-corpus.mjs';

const REQUIRED = ['auth', 'display', 'ime', 'stale-state', 'postconditions', 'relay', 'skills'];

test('regression corpus maps every core risk to owned existing repository tests', () => {
  const corpus = loadRegressionCorpus();
  assert.equal(corpus.schema_version, 1);
  assert.deepEqual(corpus.groups.map((group) => group.id), REQUIRED);
  for (const group of corpus.groups) {
    assert.ok(group.test_files.length >= 2, group.id);
    assert.ok(group.boundary.length > 12, group.id);
    assert.equal(group.evidence_class, 'automated-source-test');
    assert.equal(group.phone_acceptance, 'NOT_CLAIMED');
  }
});

test('regression selector is deterministic, focused and rejects unknown groups', () => {
  const corpus = loadRegressionCorpus();
  const run = planRegressionRun(corpus, ['ime', 'auth', 'ime']);
  assert.deepEqual(run.groups, ['auth', 'ime']);
  assert.ok(run.files.every((file) => file.startsWith('test/') && file.endsWith('.test.js')));
  assert.equal(run.files.length, new Set(run.files).size);
  assert.ok(run.files.some((file) => file.includes('oauth')));
  assert.ok(run.files.some((file) => file.includes('editor-action')));
  assert.throws(() => planRegressionRun(corpus, ['unverified-external-skill']), /UNKNOWN_CORPUS_GROUP/);
});

test('regression manifest entries must stay backed by tracked files and never require external tools', () => {
  const corpus = loadRegressionCorpus();
  const planned = planRegressionRun(corpus, []);
  assert.deepEqual(planned.groups, REQUIRED);
  assert.ok(planned.files.length >= 12);
  assert.ok(!JSON.stringify(corpus).match(/waza|skillspector|desktop commander|agent-browser/i));
});

test('opt-in CLI validates the real catalog and executes a focused auth run', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const env = { ...process.env, OREMOTE_TEST_ISOLATED: '1', RUN_LIVE_EXTERNAL_SMOKE: '0' };
  const check = spawnSync(process.execPath, ['scripts/regression-corpus.mjs', '--check'],
    { cwd, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /CORPUS OK: 7 groups, 22 distinct test files/);
  const run = spawnSync(process.execPath, ['scripts/regression-corpus.mjs', '--run', 'auth'],
    { cwd, env, encoding: 'utf8', timeout: 90000 });
  assert.equal(run.status, 0, [run.stdout, run.stderr].join('\n'));
  assert.match(run.stdout, /CORE REGRESSION: auth/);
  // Child tests use stdio: 'inherit'; success is the child process exit code,
  // not output captured by spawnSync (only the parent's banner is captured).
});
