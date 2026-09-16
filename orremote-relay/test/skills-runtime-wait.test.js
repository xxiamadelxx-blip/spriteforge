import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillRegistry } from '../src/skills/registry.js';
import { createSkillRuntime } from '../src/skills/runtime.js';

test('skills runtime handles bounded WAIT locally without touching Android', async () => {
  const sleeps = [];
  let plannerCalls = 0;
  const skill = {
    id: 'test.wait',
    packages: ['example.pkg'],
    safety: { effect: 'read_only', risk: 'R1' },
    createContext() { return {}; },
    recognize() { return 'READY'; },
    next() {
      plannerCalls += 1;
      if (plannerCalls === 1) return { type: 'WAIT', duration_ms: 250 };
      return { type: 'COMPLETE', output: { done: true } };
    },
  };
  const primitives = [];
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill]),
    invokePrimitive: async (name) => {
      primitives.push(name);
      if (name !== 'screen.observe') throw new Error(`unexpected primitive ${name}`);
      return { structuredContent: { package: 'example.pkg', revision: 1, nodes: [] } };
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });

  const result = await runtime.run({ skillId: 'test.wait' });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(primitives, ['screen.observe', 'screen.observe']);
  assert.equal(result.trace.some((item) => item.directive === 'WAIT'), true);
});

test('skills runtime rejects unbounded WAIT durations', async () => {
  const skill = {
    id: 'test.bad-wait',
    packages: ['example.pkg'],
    safety: { effect: 'read_only', risk: 'R1' },
    recognize() { return 'READY'; },
    next() { return { type: 'WAIT', duration_ms: 60_000 }; },
  };
  const runtime = createSkillRuntime({
    registry: createSkillRegistry([skill]),
    invokePrimitive: async () => ({ structuredContent: { package: 'example.pkg', revision: 1, nodes: [] } }),
    sleep: async () => { throw new Error('must not sleep'); },
  });
  const result = await runtime.run({ skillId: 'test.bad-wait' });
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.error_code, 'SKILL_INVALID_WAIT');
});
