# AUD-002 production activation

The session implementation is code-complete but disabled until this runbook is
explicitly authorized.

1. Record backups, session/token counts, and current index shapes.
2. Apply and verify the Session/outbox migration before enabling issuance.
3. Phase 1: enable the model, new issuance and refresh honoring with
   `REQUIRE_EXP_TOKENS=false`.
4. Monitor login success, refresh 401/409/403, outbox lag/dead letters and
   forced re-auth. Abort on unexplained theft or a material login regression.
5. Drain the approved legacy window; confirm all five entry points issue only
   typed, expiring credentials.
6. Phase 2: set `REQUIRE_EXP_TOKENS=true`; prove no-exp tokens fail on protect,
   attachUser and loginStatus.
7. Record the sunset timestamp and security/product sign-off.

Rollback uses the accepted drain posture. If refresh itself is defective, use
emergency re-auth and the bounded-exp HttpOnly fallback cookie. Never restore a
localStorage bearer or a no-exp token.
