import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const migration = fileURLToPath(new URL('../../supabase/migrations/20260923000300_m10_android_artifact_registry.sql', import.meta.url));

test('artifact registry keeps the APK bucket private, immutable and operator-recorded', async () => {
  const sql = await readFile(migration, 'utf8');
  assert.match(sql, /'orremote-release-artifacts'.*false/s);
  assert.match(sql, /orremote_release_artifact_append_only/);
  assert.match(sql, /alter table public\.orremote_release_artifacts enable row level security/i);
  assert.match(sql, /public\.orremote_release_require_operator\(\)/);
  assert.match(sql, /candidate_verified/);
  assert.doesNotMatch(sql, /create policy[\s\S]*anon/i);
});
