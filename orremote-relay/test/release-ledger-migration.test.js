import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const migration = fileURLToPath(new URL('../../supabase/migrations/20260923000100_m10_release_ledger.sql', import.meta.url));

test('M10 ledger migration keeps operator writes private, append-only, and CAS-bound', async () => {
  const sql = await readFile(migration, 'utf8');
  for (const table of [
    'orremote_release_operators', 'orremote_releases', 'orremote_release_events',
    'orremote_release_requests', 'orremote_release_pointers', 'orremote_release_pointer_events',
  ]) assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  assert.match(sql, /revoke all on public\.orremote_release_operators,[\s\S]* from anon, authenticated;/i);
  assert.match(sql, /create trigger orremote_release_event_append_only/i);
  assert.match(sql, /create or replace function public\.orremote_release_compare_and_swap_pointer/i);
  assert.match(sql, /where pointer_name = p_pointer_name and revision = p_expected_revision/i);
  assert.match(sql, /create unique index orremote_release_requests_one_active_attempt/i);
  assert.match(sql, /RETRY_REQUIRES_TERMINAL_PREDECESSOR/);
});

test('M10 baseline migration imports only legacy_unverified observations and leaves pointers unset', async () => {
  const sql = await readFile(migration, 'utf8');
  const baseline = sql.split('-- Read-only baseline:')[1];
  assert.ok(baseline, 'baseline section is present');
  assert.match(sql, /legacy:android:0\.5\.0-m5\.173/);
  assert.match(sql, /legacy:relay:9d80d4fdaaffe415a50f59da11258e5dc257a6a2/);
  assert.match(baseline, /'legacy_unverified'/);
  assert.doesNotMatch(baseline, /update public\.orremote_release_pointers/i);
  assert.doesNotMatch(baseline, /accepted_android/i);
});
