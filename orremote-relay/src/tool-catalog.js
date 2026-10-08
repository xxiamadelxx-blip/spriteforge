import * as z from 'zod/v4';

const selectorKind = z.enum(['TEXT', 'CONTENT_DESCRIPTION', 'RESOURCE_ID', 'CLASS_NAME', 'HANDLE']);
const expectedRevision = z.number().int();
const integer = z.number().int();
const noArgs = z.object({}).strict();
const revisionOnly = z.object({ expected_revision: expectedRevision }).strict();

function annotations(readOnly) {
  return {
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}

function tool({ name, title, description, inputSchema, risk, permissionScope, timeoutMs, readOnly, scope }) {
  return {
    name,
    title,
    description,
    inputSchema,
    risk,
    permissionScope,
    timeoutMs,
    scope,
    annotations: annotations(readOnly),
  };
}

export const ANDROID_TOOLS = Object.freeze([
  tool({
    name: 'screen.observe',
    title: 'Observe current Android screen',
    description: 'Return the compact Accessibility snapshot for the foreground screen, including revision, package/activity, fingerprint and semantic nodes.',
    inputSchema: noArgs,
    risk: 'R0',
    permissionScope: 'screen.observe',
    timeoutMs: 2_500,
    readOnly: true,
    scope: 'android.observe',
  }),
  tool({
    name: 'ui.click',
    title: 'Semantic UI click',
    description: "Click a semantic Accessibility target only if the caller's expected_revision still matches current state, then verify the observed post-action state.",
    inputSchema: z.object({
      expected_revision: expectedRevision,
      selector_kind: selectorKind,
      selector_value: z.string(),
      exact: z.boolean().optional(),
    }).strict(),
    risk: 'R1',
    permissionScope: 'ui.control',
    timeoutMs: 5_000,
    readOnly: false,
    scope: 'android.control',
  }),
  tool({
    name: 'ui.set_text',
    title: 'Set text in editable UI node',
    description: 'Set text through Accessibility ACTION_SET_TEXT after stale-state validation and verify the requested value on the same snapshot-scoped target.',
    inputSchema: z.object({
      expected_revision: expectedRevision,
      selector_kind: selectorKind,
      selector_value: z.string(),
      exact: z.boolean().optional(),
      value: z.string(),
    }).strict(),
    risk: 'R1',
    permissionScope: 'ui.control',
    timeoutMs: 5_000,
    readOnly: false,
    scope: 'android.control',
  }),
  tool({
    name: 'ui.editor_action',
    title: 'Submit semantic editor action',
    description: 'Request the focused editor’s native IME action on one exact editable Accessibility target after revision validation. This never sends a global Enter key or coordinate tap; business success must be verified separately.',
    inputSchema: z.object({
      expected_revision: expectedRevision,
      selector_kind: selectorKind,
      selector_value: z.string().min(1),
    }).strict(),
    risk: 'R1',
    permissionScope: 'ui.control',
    timeoutMs: 5_000,
    readOnly: false,
    scope: 'android.control',
  }),
  tool({
    name: 'touch.tap',
    title: 'Coordinate tap fallback',
    description: 'Fallback tap by absolute display coordinates. Requires expected_revision and still verifies the resulting state.',
    inputSchema: z.object({
      expected_revision: expectedRevision,
      x: integer,
      y: integer,
    }).strict(),
    risk: 'R1',
    permissionScope: 'touch.control',
    timeoutMs: 5_000,
    readOnly: false,
    scope: 'android.control',
  }),
  tool({
    name: 'touch.swipe',
    title: 'Swipe gesture',
    description: 'Dispatch a swipe gesture after expected_revision validation and verify either a changed fingerprint or TYPE_VIEW_SCROLLED event.',
    inputSchema: z.object({
      expected_revision: expectedRevision,
      start_x: integer,
      start_y: integer,
      end_x: integer,
      end_y: integer,
      duration_ms: integer.optional(),
    }).strict(),
    risk: 'R1',
    permissionScope: 'touch.control',
    timeoutMs: 5_000,
    readOnly: false,
    scope: 'android.control',
  }),
  tool({
    name: 'system.back',
    title: 'Android system Back',
    description: 'Perform GLOBAL_ACTION_BACK after expected_revision validation and verify the resulting screen state.',
    inputSchema: revisionOnly,
    risk: 'R1',
    permissionScope: 'system.navigation',
    timeoutMs: 5_000,
    readOnly: false,
    scope: 'android.control',
  }),
  tool({
    name: 'system.home',
    title: 'Android system Home',
    description: 'Perform GLOBAL_ACTION_HOME after expected_revision validation and verify the resulting screen state.',
    inputSchema: revisionOnly,
    risk: 'R1',
    permissionScope: 'system.navigation',
    timeoutMs: 5_000,
    readOnly: false,
    scope: 'android.control',
  }),
  tool({
    name: 'screen.screenshot',
    title: 'Accessibility screenshot',
    description: 'Capture a point-in-time screenshot through AccessibilityService. FLAG_SECURE content is never bypassed.',
    inputSchema: noArgs,
    risk: 'R0',
    permissionScope: 'screen.screenshot',
    timeoutMs: 5_000,
    readOnly: true,
    scope: 'android.observe',
  }),
  tool({
    name: 'app.list',
    title: 'List launchable apps',
    description: 'List launchable applications with package name, label, version name and version code visible to Ø Remote.',
    inputSchema: noArgs,
    risk: 'R0',
    permissionScope: 'app.discovery',
    timeoutMs: 2_500,
    readOnly: true,
    scope: 'android.observe',
  }),
  tool({
    name: 'app.launch',
    title: 'Launch Android application',
    description: 'Launch a package with its launcher intent and verify that the requested package becomes foreground.',
    inputSchema: z.object({ package: z.string() }).strict(),
    risk: 'R1',
    permissionScope: 'app.launch',
    timeoutMs: 5_000,
    readOnly: false,
    scope: 'android.control',
  }),
]);

const SKILL_RUN_TOOL = tool({
  name: 'skill.run',
  title: 'Run an approved Android skill',
  description: 'Run a bounded relay-hosted app-specific state machine over the verified Android primitive tools.',
  inputSchema: z.object({
    skill_id: z.string().min(1),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  risk: 'R1',
  permissionScope: 'skills.execute',
  timeoutMs: 120_000,
  readOnly: false,
  scope: 'android.control',
});

// Stable, agent-facing aliases. The existing primitive and skill.run contracts remain intact.
const AGENT_FRONT_DOOR_TOOLS = Object.freeze([
  tool({
    name: 'orremote.status',
    title: 'Ø Remote connection status',
    description: 'Check this authenticated phone connection and available operations before attempting any phone action. No re-pair or Android command is initiated.',
    inputSchema: noArgs,
    risk: 'R0', permissionScope: 'agent.status', timeoutMs: 1_500,
    readOnly: true, scope: 'android.observe',
  }),
  tool({
    name: 'orremote.observe',
    title: 'Observe the paired phone',
    description: 'Read the fresh, privacy-filtered Android semantic observation. Internally uses the existing screen.observe primitive.',
    inputSchema: noArgs,
    risk: 'R0', permissionScope: 'screen.observe', timeoutMs: 2_500,
    readOnly: true, scope: 'android.observe',
  }),
  tool({
    name: 'orremote.list_skills',
    title: 'Discover approved Ø Remote skills',
    description: 'List registered high-level skills, input schemas, providers and availability. If online, performs one read-only Android app.list lookup; never controls the phone.',
    inputSchema: noArgs,
    risk: 'R0', permissionScope: 'skills.discover', timeoutMs: 1_500,
    readOnly: true, scope: 'android.observe',
  }),
  tool({
    name: 'orremote.run_skill',
    title: 'Run a bounded Ø Remote skill',
    description: 'Execute a registered skill through the existing verified relay runtime and its user-only authorization, revision, postcondition and no-blind-replay protections.',
    inputSchema: SKILL_RUN_TOOL.inputSchema,
    risk: 'R1', permissionScope: 'skills.execute', timeoutMs: 120_000,
    readOnly: false, scope: 'android.control',
  }),
  Object.freeze({
    ...tool({
      name: 'orremote.disconnect',
      title: 'Disconnect this Ø Remote agent',
      description: 'Only when the user explicitly requests to disconnect this agent: revoke the current OAuth connection (not the phone pairing). Requires confirm=true. This cannot be undone without user OAuth reauthorization.',
      inputSchema: z.object({ confirm: z.literal(true) }).strict(),
      risk: 'R2', permissionScope: 'agent.disconnect', timeoutMs: 5_000,
      readOnly: false, scope: 'android.observe',
    }),
    annotations: {
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
    },
  }),
  tool({
    name: 'orremote.app_list',
    title: 'List phone apps',
    description: 'Read the installed launchable apps of the paired phone through the existing app.list primitive.',
    inputSchema: noArgs,
    risk: 'R0', permissionScope: 'app.discovery', timeoutMs: 2_500,
    readOnly: true, scope: 'android.observe',
  }),
]);

export const TOOLS = Object.freeze([...ANDROID_TOOLS, SKILL_RUN_TOOL, ...AGENT_FRONT_DOOR_TOOLS]);

const BY_NAME = new Map(TOOLS.map((entry) => [entry.name, entry]));

export function toolByName(name) {
  return BY_NAME.get(name) || null;
}
