const DEFAULT_APPROVED_SKILLS = Object.freeze({
  'yandex_pro.planned_slot_orders.read': Object.freeze({
    effect: 'read_only',
    packages: Object.freeze(['ru.yandex.taximeter']),
  }),
  'settings.device_info.read': Object.freeze({
    effect: 'read_only',
    packages: Object.freeze(['com.android.settings']),
  }),
});

export function createDefaultSkillSafetyPolicy({
  approvedSkills = DEFAULT_APPROVED_SKILLS,
  panicSwitch = () => process.env.ORREMOTE_SKILLS_PANIC === '1',
} = {}) {
  return Object.freeze({
    isPanicked() {
      return Boolean(panicSwitch());
    },

    authorizeSkill(skill) {
      const id = String(skill?.id || '');
      const approved = approvedSkills[id] || null;
      const declaredEffect = skill?.safety?.effect ?? approved?.effect ?? null;
      if (declaredEffect !== 'read_only') {
        return {
          ok: false,
          code: 'SKILL_EFFECT_NOT_ALLOWED',
          message: 'Current default runtime allows only explicitly read-only skills.',
        };
      }
      if (!approved) {
        return {
          ok: false,
          code: 'SKILL_PACKAGE_NOT_ALLOWED',
          message: 'Skill is not present in the external approved manifest.',
        };
      }
      const packages = Array.isArray(skill?.packages) ? skill.packages.map(String) : [];
      const approvedPackages = new Set(approved.packages.map(String));
      if (
        packages.length !== approvedPackages.size
        || packages.some((pkg) => !approvedPackages.has(pkg))
      ) {
        return {
          ok: false,
          code: 'SKILL_PACKAGE_NOT_ALLOWED',
          message: 'Skill packages do not exactly match the external approved manifest.',
        };
      }
      return { ok: true };
    },
  });
}
