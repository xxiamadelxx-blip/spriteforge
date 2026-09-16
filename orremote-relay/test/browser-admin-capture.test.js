// Render verification trigger for browser admin wait/capture.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserAdminRunPlanSkill } from '../src/skills/browser/admin-run-plan.js';

function snapshot(nodes = []) {
  return {
    package: 'com.opera.browser',
    revision: 42,
    nodes,
  };
}

function node({ handle, resource_id, text = '', sensitive = false }) {
  return {
    handle,
    resource_id,
    text,
    sensitive,
    enabled: true,
    bounds: { left: 0, top: 0, right: 100, bottom: 50 },
    depth: 1,
  };
}

test('browser admin plan can wait for an exact selector and capture non-sensitive result text', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'codemagic.io',
      steps: [
        {
          type: 'WAIT_FOR_EXACT_SELECTOR',
          selector: { kind: 'RESOURCE_ID', value: 'build-status' },
          max_attempts: 3,
          poll_ms: 100,
        },
        {
          type: 'CAPTURE_EXACT_SELECTOR_TEXT',
          selector: { kind: 'RESOURCE_ID', value: 'build-status' },
          key: 'build_status',
        },
      ],
    },
  });

  const missing = snapshot([]);
  assert.deepEqual(
    await skill.next({ state: 'BROWSER', snapshot: missing, context }),
    { type: 'WAIT', duration_ms: 100, step_index: 0 },
  );

  const ready = snapshot([
    node({ handle: 'h-status', resource_id: 'build-status', text: 'Success' }),
  ]);
  assert.deepEqual(
    await skill.next({ state: 'BROWSER', snapshot: ready, context }),
    { type: 'OBSERVE' },
  );
  assert.equal(context.index, 1);

  assert.deepEqual(
    await skill.next({ state: 'BROWSER', snapshot: ready, context }),
    { type: 'OBSERVE' },
  );
  assert.equal(context.captures.build_status, 'Success');

  const completed = await skill.next({ state: 'BROWSER', snapshot: ready, context });
  assert.equal(completed.type, 'COMPLETE');
  assert.equal(completed.output.captures.build_status, 'Success');
});

test('browser admin capture refuses sensitive result nodes', async () => {
  const skill = createBrowserAdminRunPlanSkill();
  const context = skill.createContext({
    inputs: {
      domain: 'gitlab.com',
      steps: [
        {
          type: 'CAPTURE_EXACT_SELECTOR_TEXT',
          selector: { kind: 'RESOURCE_ID', value: 'api-token' },
          key: 'token',
        },
      ],
    },
  });

  const result = await skill.next({
    state: 'BROWSER',
    snapshot: snapshot([
      node({ handle: 'h-secret', resource_id: 'api-token', text: 'glpat-secret', sensitive: true }),
    ]),
    context,
  });

  assert.equal(result.type, 'STOP');
  assert.equal(result.error_code, 'USER_AUTH_REQUIRED');
});
