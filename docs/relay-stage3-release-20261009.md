# Ø Remote relay Stage-3 release record

Date: 2026-10-09. Source repo: `xxiamadelxx-blip/-remote`.
Authoritative Android/relay source: `ab01763cb8082f123e7537a8c2a97cee25f089d0`.
Prior production: `6f919a00f82ac73713371e904bd4787c39ac8de6`.
Release payload commit: `7b00b8b1fa1188902632054f8447ba08a1287780`.
Staging mirror `agent-entry-stage3-candidate-20261008`: `c8e86b4ee9978d5022c9e04c84aed51d69b9bc9a`.
Manifest hash: `04f16f75e8980c8f81eb991f26e965bad97cafee0e2ee20107b4e311ae0c431a`.

## Source and integration evidence

The staging mirror contains exactly the canonical relay files and generated
manifest; developer CI root fixtures are **not** in the production relay subtree.
Independent mirror Node CI job `113569252001`: 328 PASS, 0 FAIL, 1 SKIP.
Canonical Node CI job `113568838468`: 328 PASS, 0 FAIL, 1 SKIP.
OAuth concurrency race and production `npm install` lifecycle are covered
by dedicated tests.

Codemagic build for prior Stage-3 Android source:
`6ac7f88259e0a0dce270daaa` (GitHub check `113547862014`, success);
artifact URL, certificate digest and on-device install **not** established.

## Deployment invariant

Render service `srv-dajhnd8ae00c73a19ndg` tracks this branch.
OAuth revocation uses `OREMOTE_OAUTH_REVOCATION_BACKEND=supabase`
and private pre-existing Supabase credentials. Client allowlist is limited
to the stable ChatGPT client metadata ID and exact callback URL.
Do not assume live success merely because this commit exists.

Required runtime confirmation: Render deploy LIVE at the exact production
commit, startup with fail-closed Supabase revocation hydration, public
`/health` supporting durable revoke with matching manifest source identity,
device re-connection, independent MCP client authorization and physical tests.

**Rollback constraint:** after any Stage-3 OAuth grant has been issued, old
production source without durable revocation enforcement is NOT a safe
rollback target. Recover by fixing the current security mechanism or
explicitly revoking/invalidation via a reviewed plan.

The release does not install an APK, alter the phone or establish ChatGPT
plugin connection. Physical status stays NOT VERIFIED.
