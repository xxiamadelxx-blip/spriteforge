import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const migration = fileURLToPath(new URL('../../supabase/migrations/20260923000200_m10_android_release_enqueue.sql', import.meta.url));

test('release enqueue migration is operator-only while the internal worker still uses the existing bus-secret verifier', async () => {
  const sql = await readFile(migration, 'utf8');
  assert.match(sql, /create or replace function public\.orremote_enqueue_android_build/i);
  assert.match(sql, /public\.orremote_release_require_operator\(\)/);
  assert.match(sql, /public\.orremote_secret_ok\(p_bus_secret\)/);
  assert.match(sql, /refs\/tags\/orremote\/android\//);
  assert.match(sql, /grant execute on function public\.orremote_enqueue_android_build[\s\S]* to authenticated;/i);
  assert.match(sql, /revoke all on function[\s\S]* from public;/i);
});

test('release enqueue migration pins a source/tag identity and has no production side-effect endpoint', async () => {
  const sql = await readFile(migration, 'utf8');
  assert.match(sql, /source_sha = lower\(p_source_sha\)/);
  assert.match(sql, /tag_ref = p_tag_ref/);
  assert.match(sql, /CODEMAGIC_BUILD_ID_MISSING/);
  assert.doesNotMatch(sql, /https?:\/\//i);
  assert.doesNotMatch(sql, /render/i);
});
