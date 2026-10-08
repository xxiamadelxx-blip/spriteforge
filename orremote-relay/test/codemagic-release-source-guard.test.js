import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const workflow = fileURLToPath(new URL('../../codemagic.yaml', import.meta.url));

test('API-triggered release builds fail closed unless tag, request id, and exact commit agree', async () => {
  const yaml = await readFile(workflow, 'utf8');
  const guard = yaml.split('- name: Verify immutable API release source')[1]?.split('- name: Install relay dependencies')[0];
  assert.ok(guard, 'release source guard precedes project commands');
  for (const variable of ['CM_TRIGGER_SOURCE', 'CM_COMMIT', 'ORREMOTE_EXPECTED_COMMIT', 'ORREMOTE_RELEASE_REQUEST_ID', 'ORREMOTE_RELEASE_TAG', 'CM_TAG']) {
    assert.match(guard, new RegExp(variable));
  }
  assert.match(guard, /git rev-parse HEAD/);
  assert.match(guard, /git rev-parse "\$ORREMOTE_RELEASE_TAG\^\{commit\}"/);
});
