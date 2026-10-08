import crypto from 'node:crypto';

const RELAY_INPUT = /^(relay\/(?:package(?:-lock)?\.json|src\/.+|test\/.+))$/;
const MIRROR_ROOT = 'orremote-relay/';

export class ReleaseMirrorError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function validSha(value) { return /^[a-f0-9]{40}$/i.test(String(value || '')); }
function validBlob(value) { return /^[a-f0-9]{40}$/i.test(String(value || '')); }

export function buildRelayMirrorCandidate({ canonicalRepo, sourceSha, inputs, transformationVersion = 'm10-relay-mirror-v1' }) {
  if (typeof canonicalRepo !== 'string' || !canonicalRepo.includes('/')) throw new ReleaseMirrorError('MIRROR_CANONICAL_REPO_INVALID');
  if (!validSha(sourceSha)) throw new ReleaseMirrorError('MIRROR_SOURCE_SHA_INVALID');
  if (!Array.isArray(inputs) || inputs.length === 0) throw new ReleaseMirrorError('MIRROR_INPUTS_REQUIRED');
  const seen = new Set();
  const normalized = inputs.map(({ path, sha }) => {
    if (!RELAY_INPUT.test(path || '') || !validBlob(sha) || seen.has(path)) throw new ReleaseMirrorError('MIRROR_INPUT_INVALID');
    seen.add(path);
    return { canonical_path: path, mirror_path: `${MIRROR_ROOT}${path.slice('relay/'.length)}`, blob_sha: String(sha).toLowerCase() };
  }).sort((a, b) => a.canonical_path.localeCompare(b.canonical_path));
  const manifest = {
    schema_version: 1,
    transformation_version: transformationVersion,
    canonical_repo: canonicalRepo,
    source_sha: String(sourceSha).toLowerCase(),
    inputs: normalized,
  };
  const manifestHash = digest(canonical(manifest));
  const manifestPath = `${MIRROR_ROOT}release-manifest.json`;
  const manifestText = `${canonical({ ...manifest, manifest_sha256: manifestHash })}\n`;
  const outputs = [...normalized.map(({ mirror_path, blob_sha }) => ({ path: mirror_path, blob_sha })), { path: manifestPath, content_sha256: digest(manifestText), content: manifestText }]
    .sort((a, b) => a.path.localeCompare(b.path));
  const treeHash = digest(outputs.map((entry) => `${entry.path}\0${entry.blob_sha || entry.content_sha256}`).join('\n'));
  return Object.freeze({ manifest: Object.freeze({ ...manifest, manifest_sha256: manifestHash }), manifestText, manifestPath, outputs: Object.freeze(outputs), treeHash });
}

export function assertMirrorOutputExact(candidate, outputPaths) {
  const expected = candidate.outputs.map((entry) => entry.path).sort();
  const actual = [...outputPaths].sort();
  if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) throw new ReleaseMirrorError('MIRROR_OUTPUT_NOT_EXACT');
  return true;
}
