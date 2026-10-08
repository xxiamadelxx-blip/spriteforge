// Opt-in developer regression harness. Never executed by the Android or relay runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RELAY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CORPUS_PATH = fileURLToPath(new URL('../../docs/regressions/core-corpus.json', import.meta.url));
const VALID_FILE = /^test\/[a-z0-9.-]+\.test\.js$/;

export function loadRegressionCorpus() {
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  if (corpus?.schema_version !== 1 || !Array.isArray(corpus.groups) || corpus.groups.length === 0) {
    throw new Error('CORPUS_FORMAT_INVALID');
  }
  const seen = new Set();
  for (const group of corpus.groups) {
    if (!/^[a-z][a-z-]+$/.test(group?.id || '') || seen.has(group.id)) throw new Error('CORPUS_GROUP_INVALID');
    seen.add(group.id);
    if (typeof group.boundary !== 'string' || group.boundary.length < 12
        || group.evidence_class !== 'automated-source-test'
        || group.phone_acceptance !== 'NOT_CLAIMED'
        || !Array.isArray(group.test_files) || group.test_files.length < 1) {
      throw new Error('CORPUS_EVIDENCE_INVALID');
    }
    for (const file of group.test_files) {
      if (!VALID_FILE.test(file) || !fs.statSync(path.join(RELAY_ROOT, file), { throwIfNoEntry: false })?.isFile()) {
        throw new Error('CORPUS_TEST_NOT_FOUND: ' + file);
      }
    }
  }
  return corpus;
}

export function planRegressionRun(corpus, requestedIds = []) {
  if (!Array.isArray(requestedIds)) throw new Error('UNKNOWN_CORPUS_GROUP');
  const wanted = new Set(requestedIds);
  const ids = new Set(corpus.groups.map((group) => group.id));
  for (const id of wanted) if (!ids.has(id)) throw new Error('UNKNOWN_CORPUS_GROUP: ' + id);
  const groups = corpus.groups.filter((group) => wanted.size === 0 || wanted.has(group.id));
  return {
    groups: groups.map((group) => group.id),
    files: [...new Set(groups.flatMap((group) => group.test_files))],
    evidence_class: 'automated-source-test',
    phone_acceptance: 'NOT_CLAIMED',
  };
}

function main(args) {
  const corpus = loadRegressionCorpus();
  if (args.length === 0 || args[0] === '--check') {
    const planned = planRegressionRun(corpus, []);
    console.log('CORPUS OK: ' + planned.groups.length + ' groups, ' + planned.files.length + ' distinct test files; physical PASS NOT CLAIMED');
    return 0;
  }
  if (args[0] === '--list') {
    for (const group of corpus.groups) console.log(group.id + ': ' + group.boundary);
    return 0;
  }
  if (args[0] !== '--run' || args.length !== 2) throw new Error('USAGE: node scripts/regression-corpus.mjs [--check|--list|--run auth,ime|--run all]');
  const requested = args[1] === 'all' ? [] : args[1].split(',');
  const planned = planRegressionRun(corpus, requested);
  console.log('CORE REGRESSION: ' + planned.groups.join(', ') + ' (source tests only)');
  const result = spawnSync(process.execPath,
    ['--import', './test/test-env.js', '--test', ...planned.files],
    { cwd: RELAY_ROOT, env: { ...process.env, OREMOTE_TEST_ISOLATED: '1', RUN_LIVE_EXTERNAL_SMOKE: '0' }, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
