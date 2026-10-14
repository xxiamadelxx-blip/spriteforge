# Ø Remote M8 read-only WSS session rollover release

This non-runtime provenance file is committed using the normal GitHub Contents API to the existing Render-tracked `orremote-relay` branch. It is a documentation-only descendant of independently tested candidate `97ccdbc0d910cc007d65a31191705a638ec0e6f5`.

Canonical fix merged from PR #11 into `xxiamadelxx-blip/-remote:m5/skills-runtime-yandex-pro` commit `29ceab8adc3779bf69b7dac7b955d474218693f9`.

Production candidate source: `orremote-relay/src/supabase-command-bus.js`, Git blob `b823bc0d900f15b8d64db4e6f209e2a16707c939`; new test `orremote-relay/test/supabase-readonly-session-rollover.test.js`, blob `fd72a57f97bd0918a59be63aa225df2121346d65`. No APK, credentials or device pairing changes.

Scope: only one retry of `screen.observe` or `app.list` on `SESSION_SUPERSEDED`. Never replay writing commands, skills, timeouts or ambiguous non-session failures.

Verification on independent Node runner: `npm run check` PASS; full suite 339 total / 338 PASS / 0 FAIL / 1 SKIP; 14 focused tests PASS, repeated 20 iterations (280 PASS). Canonical root test fixtures were injected in isolated runner only. Physical proof before this release: ten real Supabase-owner-to-Android requests, nine completed and one `SESSION_SUPERSEDED`. Post-release physical acceptance remains REQUIRED.

Canonical audit: `docs/audits/M8_OWNER_SUPABASE_REAL_ANDROID_2026-10-15.md`; GitHub issue #7 remains OPEN until physically verified.
