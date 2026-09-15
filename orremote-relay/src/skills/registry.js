export function createSkillRegistry(definitions = []) {
  const byId = new Map();
  for (const definition of definitions) {
    if (!definition || typeof definition.id !== 'string' || !definition.id.trim()) {
      throw new Error('SKILL_ID_REQUIRED');
    }
    if (byId.has(definition.id)) throw new Error(`DUPLICATE_SKILL:${definition.id}`);
    byId.set(definition.id, definition);
  }

  return Object.freeze({
    get(skillId) {
      return byId.get(String(skillId || '')) || null;
    },
    list() {
      return [...byId.values()];
    },
  });
}
