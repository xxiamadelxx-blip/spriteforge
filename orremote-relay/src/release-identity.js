import fs from 'node:fs';
import path from 'node:path';

export function loadReleaseIdentity(root = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
    const sourceSha = String(raw?.source_sha || '').toLowerCase();
    const manifestHash = String(raw?.manifest_sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-f0-9]{64}$/.test(manifestHash)) return null;
    return Object.freeze({ sourceSha, manifestHash });
  } catch { return null; }
}
