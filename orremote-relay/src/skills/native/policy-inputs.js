export function normalizeNativePolicyInputs(inputs = {}) {
  const steps = Array.isArray(inputs.steps) ? inputs.steps : [];
  return {
    ...inputs,
    steps: steps.map((step) => (
      step?.type === 'CAPTURE_VISIBLE_UI'
        ? { type: 'ASSERT_EXACT_TEXT', text: '__orremote_safe_visible_ui_capture__' }
        : { ...step }
    )),
  };
}
