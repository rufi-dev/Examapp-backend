# ADR: Authentication session lifecycle (AUD-002)

- **Status:** **Accepted (Gate 1, 2026-07-25).** The decision bundle in §1.1 is approved and frozen; the design is not reopened. Implementation proceeds per §14 behind `SESSION_MODEL_ENABLED` (default off); AUD-002 is closed only after Gate 5 Phase 2 (see the closure contract `CODEX_FIX_REVIEW.md`).
- **Date:** 2026-07-25
- **Related:** AUDIT_REPORT `AUD-002`; Codex reviews `CR-001`, `CR-003`, `CR-005`, `CR-007…CR-014`, Gate 0–5 closure contract; ADR review items `ADR-001…ADR-018` (all dispositioned in §15); REPAIR_PLAN §1.2; overlaps `AUD-008` (identity hardening) and `AUD-019` (security headers/CSP).
- **Supersedes:** the implicit "cookie lifetime == session lifetime, bearer token is timeless" model.
- **Reading order:** §1 Context → §2 Decision (+ §2.0 summary table) → §3 Rollout/rollback → §4 Consequences → §5 Open questions → §6 Already-implemented (this working tree) → §7 Schema → §8 API → §9 Threat model → §10 Test plan → §11 Observability → §12 Migration → §13 Non-goals → §14 Task breakdown → §15 Review history.

## 1.1 Accepted decision bundle (Gate 1 — frozen)

Every AUD-002 knob is now a concrete accepted value; there is **no open implementation choice**. The `_(proposed)_` markers elsewhere in this document are historical.

| Decision | **Accepted value** |
| --- | --- |
| Access token | JWT, **15 minutes**, claims `{ id, sv, sid, iat, exp }`, `type:"access"` |
| Refresh lifetime | **30-day sliding, 90-day absolute**, both enforced in the rotation CAS |
| Benign retry grace | **10 s**, strict `409`, no rotation (rotating leeway rejected) |
| Replay ring | **10** authenticated ancestors (bounded window; older ⇒ `401`, never revoke) |
| Refresh cookie | `__Secure-exq_rt`, host-only (`Domain` omitted), `Path=/api/users/refresh`, `Secure; HttpOnly; SameSite=Lax` |
| Rollback cookie | `__Host-exq_sess`, host-only, `Path=/`, `Secure; HttpOnly; SameSite=Lax`, bounded **7-day** JWT, cookie-only |
| Access storage | **memory only**; never `localStorage` |
| Single-device access revocation | **stateless** — an already-issued access token may live at most **15 min** (documented residual; no cross-instance cache added) |
| Reset / logout-all / theft | **immediate account epoch fence** (`sessionVersion` bump), crash-recoverable |
| Change password | keep the caller signed in when rebind succeeds; otherwise **force re-login** (never roll the epoch back) |
| CSRF | **strict `Origin`/`Referer` allow-list** on cookie-authenticated state-changing routes (refresh, logout, logout-all, cookie-auth password mutation) |
| Existing routes | retain `/api/users/*`; add only `POST /refresh` + `POST /logoutAll`; `GET /logout` alias retired after clients drain |
| Legacy sunset | **hard cutoff 30 days after Phase 1**; alert if no-`exp` traffic > 0.1% on any of the preceding 7 days |

**Accepted residual:** stateless single-device revocation leaves a bounded ≤15-minute window in which an already-issued access token for a logged-out device still validates (refresh is stopped immediately). This is accepted to avoid a cross-instance revoked-`sid` cache in AUD-002; immediate single-device revocation, if ever required, is separate follow-up work.

## 1. Context

Current authentication (as of the remediation branch):

- `generateToken(id, sessionVersion)` signs a JWT `{ id, sv }` with **no `exp`**.
- The same JWT is returned in a **cross-origin, same-site** `HttpOnly` cookie **and** in JSON; the SPA stores the JSON copy in `localStorage` and sends it as `Authorization: Bearer` on every request. ("Cross-origin" because `examopia.com` → `api.examopia.com` is a different origin; "same-site" because they share the registrable domain — see the §1 correction below and §2.3.)
- The bearer path was introduced because the cookie was **observed** to be unreliable on Safari/iOS/privacy browsers (the symptom). The exact cause is **not yet confirmed** — the current `SameSite=None` configuration is the leading suspect, but that is a hypothesis to be settled by the browser matrix (§5.2), not an established root cause. **Correction (Codex review):** `examopia.com` and `api.examopia.com` are **different origins but the SAME registrable domain / site** (eTLD+1 = `examopia.com`). Requests between them are therefore **same-site**, not third-party, and a cookie set by the API host is not subject to ITP third-party blocking. Same-site is a property of the shared registrable domain — it does **not** require widening the cookie with `Domain=.examopia.com`; a **host-only** cookie on `api.examopia.com` is same-site and narrower. The `SameSite=None` workaround is the thing to drop, not something to replace with parent-domain scope (see §2.3 for the four separate properties involved).
- **Already implemented in this remediation (partial foundation):** a `User.sessionVersion` token-version. A shared validator (`resolveSessionUser`) enforces `sv` on `protect`, `attachUser`, and `loginStatus`. `resetPassword` increments `sessionVersion`, revoking previously-issued `sv`-bearing tokens (durable one-time reset token per AUD-008/CR-005).

Residual risk this ADR must close:

- **No expiry (CR-003):** a copied token is valid forever.
- **Legacy tokens (CR-003):** tokens issued before `sv` have no `sv` claim and are grandfathered indefinitely; a reset cannot revoke them.
- **`localStorage` storage:** any XSS reads the bearer token.
- **No refresh/rotation/reuse-detection, no "sign out all devices", no per-device sessions.**

Constraints:

- Must not force a mass logout of active users on deploy (staged, flagged rollout).
- Must preserve the cross-domain reliability that the bearer path was introduced to fix.
- Must not weaken `attemptId` idempotency, result-first finalization, or server-authoritative exam timing (auth changes are orthogonal but the rollout must not disrupt in-progress exams).

## 2. Decision (proposed)

### 2.0 Decision summary (every knob in one place)

Two columns matter: **Decided** (a design invariant this ADR commits to — changing it re-opens a closed review item) vs **Proposed** (a value/UX that needs product/security sign-off in §5). Nothing here is implemented yet.

| # | Parameter | Value | Status | Where |
| --- | --- | --- | --- | --- |
| D1 | Access token | short-lived JWT, claims `{ id, sv, sid, iat, exp }`, **must carry `exp`** | Decided (shape) / Proposed (15 min TTL) | §2.1 |
| D2 | Refresh token | structured `<sid>.<gen>.<secret>`, only `secret` hashed at rest | Decided | §2.1 |
| D3 | Refresh lifetime | 30-day sliding + 90-day absolute, **both enforced in the CAS predicate** | Decided (enforced) / Proposed (values) | §2.1–2.2 |
| D4 | Rotation | single-document aggregation-pipeline compare-and-swap; no transaction | Decided | §2.2 |
| D5 | Grace-state contract | **strict `409`, no rotation** (rotating "leeway" rejected — leapfrog) | **Decided** | §2.2 case 7 |
| D6 | Grace window | 10 s (below = benign `409`; above = theft) | Proposed | §2.2, §5.3 |
| D7 | Replay-detection window | bounded ring `N = 10`; beyond `N` ⇒ invalid/re-auth, **never** revoke | Decided (bounded, fail-safe) / Proposed (`N`) | §2.2 cases 8–9 |
| D8 | Theft handling | revoke offending `Session` + `sv`-bump (all-sibling fence, D21); retryable parts drained by the durable `pendingSecurityActions` outbox (§12) | Decided | §2.2 |
| D9 | Client single-flight | required (Web Locks / BroadcastChannel leader) | Decided | §2.2 |
| D10 | Cookie scope | **host-only** (`Domain` omitted), `HttpOnly; Secure; SameSite=Lax; Path=/api/users/refresh` | Decided (host-only) / Proposed (`SameSite` after browser matrix) | §2.3 |
| D11 | Access-token storage | JS memory only; **never `localStorage`** | Decided | §2.3 |
| D12 | Access-path revocation immediacy | stateless (≤15-min exposure) vs Session-status check (immediate) | Proposed | §2.4, §5.6 |
| D13 | Reset / change | reset revokes all + `sv`++; change revokes others + re-issues caller | Decided (reset implemented in this working tree) / Proposed (change UX) | §2.5 |
| D14 | Legacy sunset | Phase 2 rejects **any token without a valid `exp`**; gated by metric | Decided (rule) / Proposed (date T, threshold) | §2.6 |
| D15 | Rollback new-login credential | **bounded-`exp` HttpOnly host-only cookie** (never `localStorage`, never no-`exp`) | Decided (shape) / Proposed (`exp`) | §3, §5.7 |
| D16 | Rollback flags | `issue_new_model` / `honor_existing_refresh` / `emergency_reauth`; Drain vs Emergency by defect location | Decided | §3 |
| D17 | CSRF mechanism | **choose one:** double-submit CSRF token **or** strict `Origin`/`Referer` allow-list on state-changing POSTs (CORS alone does **not** stop a cross-origin request being *sent*) | **Proposed — must pick** | §2.3, §5.9 |
| D18 | Auth-epoch fence | immutable `Session.authVersion`; rotation requires `authVersion == User.sessionVersion`; access token signed with the captured epoch; `sv`-bump is the durable fence (reset/logout-all/theft) | **Decided** | §2.1–2.2, §2.5 |
| D19 | Two cookies | refresh (`__Secure-exq_rt`, host-only, `Path=/api/users/refresh`, opaque) vs rollback (`__Host-exq_sess`, host-only, `Path=/`, JWT, no `sid`); distinct names/extractors; `Max-Age ≤ exp`; both cleared on logout/mode-change | **Decided (Gate 0)** — `__Host-` requires `Path=/`, so the narrow-path refresh cookie must use `__Secure-` | §2.3 |
| D20 | Failed-CAS precedence | 11-step ordered classification; `403` = confirmed theft **only**; revoked/expired/superseded/unknown = `401`; infra = `5xx` | **Decided** | §2.2 |
| D21 | Theft = logout-all | a detected stolen refresh token fences **all** sibling families (account-compromise default) | **Decided** | §2.2 |

### 2.1 Token model

- **Access token** — short-lived JWT, **15 minutes** _(proposed)_. Claims: `{ id: userId, sv, sid, iat, exp }`. **Claim compatibility:** the existing code and validator use `id` (`verified.id`), so new tokens keep `id` (not the JWT-standard `sub`) to avoid a needless migration; if `sub` is later preferred, the shared validator must read `verified.id ?? verified.sub` during the transition. `sid` is the server-side session id. Verified statelessly per request (signature + `exp` + `sv` vs `User.sessionVersion`), plus the existing user load.
  - **`sv` is the Session's captured `authVersion`, not a fresh user read (ADR-014).** When a rotation mints a new access token, its `sv` claim is set to `Session.authVersion` (the epoch the family was born in), **not** a re-read of `User.sessionVersion` at rotation time. Combined with the rotation predicate requiring `Session.authVersion == User.sessionVersion` (§2.2), this closes the reset/logout-all race: a family from a superseded epoch fails the predicate and can never mint a token stamped with the *new* epoch. A token minted this way still satisfies the per-request `sv` check precisely because the predicate proved the epochs equal at rotation time.
- **Refresh token** — a structured, non-JWT string `<sid>.<gen>.<secret>` where `secret` is a high-entropy random value and `gen` is the integer rotation generation this token was issued at. Only the `secret` is stored (as a SHA-256 hash) on the `Session` record; `sid`/`gen` are plaintext locators. Presented only to `POST /auth/refresh`. Lifetime: **30-day sliding inactivity window, 90-day absolute cap** _(proposed)_ — and, unlike the first draft, both bounds are **enforced in the rotation predicate** (§2.2), not merely stated.
  - The embedded `gen` lets the server *recognize* that a presented token claims an older generation. It can only *authenticate* that claim while the token's secret hash is still in the bounded ring (§2.2). So this is a **bounded authenticated replay-detection window** (depth `N`), **not** full-chain detection: within the window a replay is proven and treated as theft; beyond it the token can no longer be authenticated and is rejected as unknown/invalid (never used to revoke a live session — see ADR-001/§2.2 case 9). The security/observability trade-off of `N` is a first-class decision, not just an open question.

### 2.2 Session records + rotation + reuse detection

- New `Session` collection — **one document per device/login (the family IS the session doc)**. Full schema in §7:
  `{ _id (=sid), userId, authVersion, refreshHash, refreshGen, usedRefreshHashes, userAgent, ip, createdAt, lastUsedAt, lastRotatedAt, refreshExpiresAt, absoluteExpiresAt, revokedAt }`.
  - `authVersion` — **immutable** auth epoch captured at creation (`= User.sessionVersion` then). The reset/logout-all fence (ADR-014); see the rotation predicate and §2.5.
  - `refreshGen` — integer, current rotation generation (starts at 0, increments per rotation).
  - `usedRefreshHashes` — a **bounded** array (ring buffer, keep last `N` = 10 _(proposed)_) of `{ gen, hash }` for recently superseded secrets. This is the "bounded used-token hash history" that lets ancestor replays be **authenticated** before they are treated as theft.
  - `refreshExpiresAt` — the **sliding** inactivity deadline (advanced each rotation).
  - `absoluteExpiresAt` — the hard cap.
  - Indexes (four — see §7): unique `refreshHash`, TTL `absoluteExpiresAt`, compound `{ userId, revokedAt }`, sparse `theftFenceTarget` (CR-009).

- **Happy-path rotation is a single-document compare-and-swap** — no second document, so **no transaction is needed**. `/auth/refresh` first reads `User.sessionVersion` (`userSv`) so the **epoch fence** (ADR-014) is in the predicate: the family only rotates while its immutable `authVersion` still equals the user's current epoch. Both the sliding and absolute deadlines are in the predicate too (closes ADR-002). It is written as an **aggregation-pipeline update** (array form) so `$min` against the immutable `absoluteExpiresAt` and the ring `$slice` are computed atomically inside the one write — `min(now + 30d, absoluteExpiresAt)` is an expression, **not** a literal usable in a classic update document (ADR-008). `now`, `now + 30d`, and `userSv` are precomputed constants the app passes in; `$absoluteExpiresAt` is read inside the pipeline:
  ```
  Session.findOneAndUpdate(
    { _id: sid, refreshGen: gen, refreshHash: hash(secret),
      authVersion: userSv,                                     // EPOCH FENCE (ADR-014): family must be current-epoch
      revokedAt: null, refreshExpiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } },
    [ { $set: {
        refreshHash:     hash(newSecret),
        refreshGen:      { $add: ["$refreshGen", 1] },
        lastUsedAt:      now,
        lastRotatedAt:   now,
        refreshExpiresAt:{ $min: [ nowPlus30d, "$absoluteExpiresAt" ] },          // sliding, capped at the absolute
        usedRefreshHashes:{ $slice: [ { $concatArrays: [ "$usedRefreshHashes",
                                          [ { gen: "$refreshGen", hash: "$refreshHash" } ] ] }, -10 ] } // ring, keep last N=10
      } } ],
    { new: true }
  )
  ```
  On a match the new access token is signed with **`sv = userSv` (= the matched `authVersion`)**, never a later re-read (§2.1). Concurrency is serialized on the one document. `refreshExpiresAt` never exceeds `absoluteExpiresAt`, so an idle session dies at 30 days and no session outlives 90. (Because `absoluteExpiresAt` is immutable, the classic two-step "pre-read the absolute, then `$set` a precomputed `min`" is an equivalent safe alternative.)
  - **Why the fence closes the reset/logout-all race (ADR-014):** reset/logout-all bump `User.sessionVersion` as the **durable first write** (§2.5). After that bump, three things are simultaneously true for any stale family: (a) its `authVersion` no longer equals `userSv`, so this CAS **cannot match** — it will not rotate; (b) even in the razor-thin window where a refresh read `userSv` *before* the bump and the CAS matched, the token it mints carries `sv = old`, which the per-request access check rejects against the bumped `User.sessionVersion` — so a raced token is **born dead**; (c) Session revocation is therefore no longer the fence, only cleanup, and may lag/retry freely. A CAS miss caused *specifically* by an epoch mismatch (`authVersion ≠ userSv` while gen/hash are otherwise current) is classified as **superseded → `401`, re-auth** (§ classification below), not theft.

- **Classifying a `/auth/refresh` request — full precedence (ADR-017).** Evaluate **top to bottom**; the first match wins. Only one outcome is confirmed theft; a stale cookie from an ordinary logout/reset must never be counted or paged as theft.
  0. **Parse failure** — the cookie is missing, malformed, or the `sid`/`gen` do not parse → **`401`**, no mutation.
  1. **Unknown / missing Session** — no `Session` for `sid` → **`401`**, no mutation. (Never mint or revoke on a `sid` guess — DoS guard.)
  2. **Expired Session** — `refreshExpiresAt <= now` or `absoluteExpiresAt <= now` → **`401`**, no mutation (TTL will sweep it).
  3. **Revoked Session** — `revokedAt != null` → **`401` (non-theft revoked)**, no mutation. This is the normal stale-cookie case after logout/reset/prior-theft; it is a distinct outcome from theft and must **not** page.
  4. **Epoch-superseded** — the Session exists and is live, gen/hash are current, but `authVersion != User.sessionVersion` (a reset/logout-all fenced it, ADR-014) → **`401` superseded**, no mutation; the client re-authenticates.
  5. **Deleted / suspended user** → **`401`** (mirrors `resolveSessionUser`), no mutation.
  6. **Happy-path CAS matched** — the epoch-fenced pipeline above matched → rotate, `200`. (Two clients presenting the *same current* token race here: exactly one matches; the loser now presents `gen-1` and falls to case 7.)
  7. **Immediately-previous generation within grace (strict Contract A)** — `gen == currentGen - 1`, `hash(secret)` matches the ring entry for that gen, and `now - lastRotatedAt <= graceWindow` (_proposed 10 s_). Two indistinguishable real-world causes — a concurrent second tab, or a retry after a lost winning response — so the server applies **one deterministic contract**:
     - **Strict `409 refresh_in_progress`, no rotation, no new token.** The previous generation never mints anything; session state is untouched.
       - *Concurrent tabs:* the loser was parked behind the client single-flight lock (§ below); the leader broadcasts the new in-memory access token to peers and the browser already swapped the `HttpOnly` cookie, so the loser adopts both without presenting the old token. `409` is only reached if a tab races the lock; it then waits for the leader's result.
       - *Lost response:* the client holds nothing newer, so on `409` it **re-authenticates** — the accepted cost of the strict contract.
     - **Rejected alternative — rotating "leeway re-issue":** letting the immediately-previous secret rotate forward once more is **unsafe** and rejected — each such rotation resets `lastRotatedAt` and advances the generation, so a legitimate holder and an attacker can **alternate** and leapfrog `R1 → R2 → R3 …`, and neither branch is ever an ancestor, so theft detection never fires. The only safe relaxation is a **true idempotent-response cache** (replay the recorded result keyed by the *consumed* token hash, **without** advancing the generation) — a larger, sensitive design not adopted here; client single-flight already removes almost all lost-response cases.
  8. **Authenticated ancestor replay (theft)** — `hash(secret)` matches a ring entry with `gen < currentGen` **outside** the grace window (or any `gen ≤ currentGen - 2`) → **`403` confirmed theft**: revoke the session + `sessionVersion` bump (below) + security event. Keying on `gen` + ring membership catches any ancestor **still in the bounded ring** (depth `N`), closing the first draft's single-`prevRefreshHash` gap; the strict contract's no-leapfrog invariant is what keeps this sound.
  9. **Beyond the ring / unauthenticated** — `gen` older than the retained window, or `hash(secret)` matches nothing → **`401`, re-auth**, NOT theft. This is the deliberate boundary of the **bounded** detection window (ADR-007): a replay older than `N` gens can no longer be authenticated, so it is treated as invalid — fail-safe, at the cost of no theft alarm for very old ancestors. Raising `N` widens coverage at a bounded storage cost (§5.3 sign-off).
  10. **Infrastructure error** — the DB op throws rather than returning "no match" → **`5xx`**, surfaced as an infrastructure error, **not** an auth classification (never silently downgraded to `401`/`403`).

  **Status-code contract:** `200` rotate · `409` grace (cases 7) · `403` confirmed theft (case 8 only) · `401` everything else that is an auth outcome (cases 0–5, 9) · `5xx` infrastructure (case 10). Observability (§11) must label case 3 as a benign `revoked` outcome and reserve the theft counter/page for case 8.

- **Auth-epoch ordering across reset / logout-all / theft / change (ADR-014).** `User.sessionVersion` is the **durable fence**; the epoch fence (above) plus signing with the captured `authVersion` make the *ordering* — not a transaction — the correctness mechanism:
  - **Reset / logout-all:** bump `User.sessionVersion` **first** (single-document, durable). If that write fails, **abort** with an error and change nothing else — there is no partial state, the client retries. Once bumped, every stale family fails the epoch-fenced CAS and every already-minted access token fails the per-request `sv` check, so revoking the `Session` records is now **cleanup** (retryable; any failures go to the outbox below), not the fence.
  - **Theft (detected at refresh, case 8):** revoke the offending `Session` immediately for targeted containment **and** bump `sessionVersion`; if the bump cannot apply synchronously, enqueue it (outbox) while the specific stolen session is already revoked. **Decision:** theft's `sv` bump **intentionally has logout-all semantics** — a detected stolen refresh token is treated as account compromise, so fencing every sibling family and forcing re-auth on all devices is the safe default, not an accident. (If per-device survivability is ever wanted, siblings would have to be explicitly rebound to the new epoch; not done here.)
  - **Change-password:** the caller must *survive*, so this is the one flow that **rebinds** an epoch — see §2.5 (revoke others, bump `sv`, atomically rebind + re-issue the caller's own Session to the new epoch), including its failure behavior.
  - **Durable retry / outbox (ADR-009, ADR-018):** the retryable writes above (cleanup revokes, a theft-path `sv` bump that could not apply synchronously) are enqueued in a dedicated **`pendingSecurityActions`** collection and drained by a worker. Its formal schema, index, lease, backoff, dead-letter, and enqueue-failure alerting are specified in §12; the idempotency key (`<action>:<sid>:<targetVersion>`) plus a monotonic `$lt` guard on re-application make retries and duplicates no-ops. Even if the worker lags, exposure is bounded by the durable `sv` fence plus the ≤15-min access-token TTL — no transaction required.

- **Client single-flight (required):** the SPA must serialize refreshes across tabs (a Web Locks `navigator.locks.request('auth-refresh', …)` or a `BroadcastChannel` leader) so only one `/auth/refresh` is in flight per browser, and the leader broadcasts the resulting in-memory access token to peer tabs. This is what makes the strict contract viable — peers get the winner's token without ever presenting the old one, so normal multi-tab use never reaches the `409`/theft paths. The strict `409` (no rotation) is only the backstop for a genuinely lost coordination or response, which then costs a re-login.

### 2.3 Storage + CSRF/XSS tradeoffs

Four **distinct** properties are often conflated; the decision must set each one deliberately (this is the ADR-004 correction — `Domain=.examopia.com` is **not** what makes the cookie same-site):

| Property | Governed by | Decision |
| --- | --- | --- |
| **Same-site classification** | scheme + registrable domain of the request target vs the top-level site | `examopia.com` ↔ `api.examopia.com` are already **same-site** (shared eTLD+1 `examopia.com`). Nothing needs to be configured to earn this; it is a fact of the domains. |
| **Cookie host scope** | the `Domain` attribute | **Omit `Domain`** → the refresh cookie is **host-only to `api.examopia.com`** (narrower). Do NOT set `Domain=.examopia.com`; that needlessly shares the credential with every current and future subdomain and buys nothing here (the refresh endpoint lives only on the API host). |
| **Cross-origin credential delivery** | CORS | The SPA's `fetch('https://api.examopia.com/api/users/refresh', { credentials: 'include' })` is cross-**origin** (different subdomain), so the API must return `Access-Control-Allow-Origin: https://examopia.com` (exact, not `*`) + `Access-Control-Allow-Credentials: true`. A host-only cookie is still sent to its own host on such a request. |
| **SameSite delivery policy** | the `SameSite` attribute | Target `SameSite=Lax` (a same-site subresource request delivers a Lax cookie), pending a real browser matrix on the production flow. `SameSite=None` should **not** be used as a "make it work" reflex: it does not make a request cross-site, it merely *permits* sending on genuinely cross-site requests and thereby *weakens* the restriction — unnecessary here since the flow is same-site. |

- **Recommended:** refresh token in a cookie `Path=/api/users/refresh; Secure; HttpOnly; SameSite=Lax` (**no `Domain`** → host-only on `api.examopia.com`). The access token is held in **JS memory only** (never `localStorage`) and re-obtained via `/api/users/refresh`. XSS can no longer exfiltrate a durable credential; CSRF is mitigated by `SameSite=Lax` plus a CSRF token (or a strict `Origin`/`Referer` check) on state-changing POSTs. **No reverse-proxy is required.** Coordinate CSP/HSTS with AUD-019.
- If a host-only cookie proves unworkable under the browser matrix, the fallback is a short-lived in-memory bearer access token + the same refresh cookie; either way, **stop persisting any long-lived token in `localStorage`.** Parent-domain (`Domain=.examopia.com`) scope is a last resort requiring a concrete justification, not the default.

**Two distinct cookies — never one name at two paths (ADR-015).** The refresh credential and the rollback credential are different things with different jobs, so they get different names, paths, claims, and extractors. Reusing one name at both `/api/users/refresh` and `/` would send duplicate same-name cookies and make server parsing order-dependent; reusing `Path=/api/users/refresh` for the rollback JWT would make it unreachable by ordinary protected routes.

| | **Refresh cookie** (normal model) | **Rollback session cookie** (fallback only) |
| --- | --- | --- |
| Cookie name | `__Secure-exq_rt` _(Gate 0; `__Host-` invalid with a narrow Path)_ | `__Host-exq_sess` _(Gate 0)_ |
| `Path` | `/api/users/refresh` (only the refresh endpoint) | `/` (must authenticate `/api/users/*`, `/api/quiz/*`, …) |
| Contents | opaque `<sid>.<gen>.<secret>` (not a JWT) | a **JWT**, `type: "rollback"`, claims `{ id, sv, exp, iat }`, **no `sid`** (no Session record) |
| Read by | **only** `POST /api/users/refresh` | **only** the access-path extractor `getToken`/`protect` |
| Purpose | rotate → mint access tokens | directly authenticate requests during rollback |
| Attributes | `HttpOnly; Secure; SameSite=Lax` | `HttpOnly; Secure; SameSite=Lax` |
| `Max-Age`/`Expires` | ≤ `absoluteExpiresAt` | **≤ the JWT `exp`** (never longer than the credential it carries) |
| D12 behavior | Session-status check applies (has `sid`) | **no `sid`** ⇒ no per-request Session check possible; single-device revocation during rollback is **cookie-clear + the bounded `exp`**; reset/logout-all still bite via the **`sv`** claim |

- **Extractor discipline:** `getToken`/`protect` read **only** an access JWT (`Authorization: Bearer` in memory) **or** the rollback session JWT — never the refresh cookie. `/auth/refresh` reads **only** the refresh cookie. The `type` claim (`"access"` vs `"rollback"`) is checked so a rollback token cannot be presented where an access token is expected and vice-versa.
- **Clearing:** logout, mode transitions (normal↔rollback), and emergency rollback must **clear both** cookie names, so a stale credential from the other mode cannot linger.
- The rollback JWT still carries `sv`, so reset/logout-all (which bump `User.sessionVersion`) invalidate rollback-mode credentials exactly as they do access tokens — the epoch fence is not bypassed by rollback.

### 2.4 Sign-out

**The strength of "revocation" depends on one unresolved choice (ADR-009): does the per-request access check consult Session status, or stay stateless (signature + `exp` + `sv` + user load only)?** The two branches give materially different guarantees, so the ADR states both rather than asserting "immediate":

- **With Session-status checking** (the access check also verifies `sid` is not revoked — _proposed: a short-TTL cache of revoked `sid`s to bound per-request cost_): revoking a `Session` is **immediate** for both refresh and the existing access token. **Caveat (ADR-018):** the app runs on multiple instances, so a **process-local** cache cannot deliver "immediate" — a revoke on instance A would stay invisible to instance B until its TTL lapsed. To actually be immediate the cache must be **shared** (e.g. Redis) or **synchronously invalidated** across instances (pub/sub), or the check must hit the DB directly; a per-process cache only bounds cost, not staleness. This cost is exactly why D12 is a sign-off decision rather than an automatic yes.
- **Without it** (access token validated statelessly): revoking a `Session` **immediately stops refresh** (no new access tokens can be minted for that `sid`), but the **already-issued access token remains valid until its ≤15-min `exp`**. Exposure is bounded by that TTL, not zero.

Applied to the two flows:

- **Sign out (this device):** revoke the current `Session` (`revokedAt`), clear the refresh cookie. Effect is immediate *with* Session-status checking; otherwise the current access token lives out its ≤15-min TTL while refresh is already dead.
- **Sign out all devices:** revoke all the user's `Session`s **and** bump `User.sessionVersion`. The `sv` bump invalidates **every** access token on the next request regardless of the choice above (the `sv` check is already in `resolveSessionUser`), so logout-all is immediate either way. Expose in Profile.

The same conditional applies to the confirmed-theft path in §2.2: session revocation stops rotation immediately in both branches; whether it also kills the in-flight access token before its TTL depends on this decision (which is why the `sessionVersion` amplification exists). See open question §5.6.

### 2.5 Password reset / change behavior

- **Reset (unauthenticated flow):** bump `sessionVersion` **first** (durable fence, §2.2), then revoke ALL `Session` records (cleanup, outbox on failure). The user re-logs in. — *`sv` bump implemented in this working tree; session-record revocation added with this ADR.*
- **Change (authenticated) — the one flow that rebinds the caller's epoch:** the acting device must stay signed in, so:
  1. bump `User.sessionVersion` to `n+1` (durable fence — this alone would log the caller out too, since its Session is still at epoch `n`);
  2. **atomically rebind + re-issue the caller's own Session:** in one `Session.findOneAndUpdate` on the caller's `sid`, set `authVersion = n+1`, rotate the refresh secret (`refreshGen++`, ring the old hash), and return the doc; mint a new access token signed with `sv = n+1`. `authVersion` is immutable *except* here — this is the sole sanctioned mutation, and it is what keeps the caller alive across the bump;
  3. revoke all **other** sessions (cleanup, outbox) — they are already fenced by the bump.
  - **Failure behavior:** if step 2 (the caller rebind/re-issue) fails *after* the step-1 bump, do **not** paper over it — the caller's old Session is now epoch-stale and its access token is already dead, so the correct outcome is **the caller is logged out and must re-authenticate** (fail-safe). Return an error that tells the frontend to send the user to login; never leave the caller on a stale-epoch credential. This is strictly safe: a failed change-password simply degrades to "password changed, re-login required," never to "old sessions survive."
  - Requires the frontend to swap tokens on the change-password success response (the reason change-password does not bump `sv` today — see FIX_RESULTS AUD-002).

### 2.6 Legacy `sv`-less / non-expiring token sunset

- **Phase 0 (implemented in this working tree, not yet deployed):** new tokens carry `sv`; tokens without `sv` are grandfathered. Note these Phase-0 `sv` tokens still have **no `exp`** — so `sv` alone does NOT bound their lifetime.
- **Phase 1:** deploy the expiring access-token + refresh model; all NEW logins get short-lived `exp` tokens. Emit a metric counting requests still presented with a **non-expiring token (no `exp` claim)** — this set is BOTH the pre-`sv` legacy tokens AND the Phase-0 `sv`-bearing-but-non-expiring tokens.
- **Phase 2 (sunset date T, _proposed T = Phase-1 + 30 days_):** `resolveSessionUser` **rejects any token without a valid `exp`** (correction: the earlier "lacking both `sv` and `exp`" rule would have left the Phase-0 `sv`/no-`exp` tokens valid forever). Requiring `exp` forces both legacy and Phase-0 tokens to re-authenticate, closing CR-003 entirely. Active users re-auth well within 30 days; the metric confirms the tail before the cutoff.
- **Rollout gate:** advance Phase 1→2 only when the non-expiring-token metric is below an agreed threshold.

## 3. Rollout & migration

1. Add the `Session` model + indexes via a migration (dry-run counts; no backfill — sessions are created lazily on login).
2. Ship `/auth/refresh`, `/auth/logout`, `/auth/logout-all` behind a **feature flag**; issue the new pair on login while STILL accepting legacy bearer tokens (compatibility window).
3. Frontend: store access token in memory, call `/auth/refresh` on 401/expiry, swap tokens on password-change. Behind the same flag.
4. Turn on reuse-detection alerts.
5. Advance the sunset per §2.6 gate.

**Rollback — two distinct contexts (they do not conflict):**

| When | What to do | Session records |
| --- | --- | --- |
| **Migration rollback** — step 1 reverted *before any session exists* | Drop the (empty) `Session` collection + indexes | None to preserve |
| **Feature rollback** — steps 2–5 reverted *after logins have created sessions* | Use the **component-level flags** below — new logins fall back to a **bounded-expiry `HttpOnly`, same-site session cookie** (reload-safe *and* `exp`-bounded; never the `localStorage` bearer and never a no-`exp` token), and existing-session refresh is kept or cut **depending on where the defect is** (see continuity note) | **KEEP** live `Session` records — do NOT drop them (dropping would log everyone out mid-rollback); they stay refreshable during drain and reusable if the flag is re-enabled |

**Feature-rollback continuity (closes ADR-005 and ADR-010):** rollback is **not** one kill-switch, and it must never resurrect a long-lived `localStorage` bearer. Two independent concerns need **separate component-level flags**, because "keep refresh alive to avoid logouts" is *unsafe if the defect being rolled back is in the refresh path itself*:

- `issue_new_model` — whether **new logins** mint the new pair.
- `honor_existing_refresh` — whether `/auth/refresh` keeps serving **already-created** sessions.
- `emergency_reauth` — a hard kill-switch that revokes/forces re-auth for everyone.

**What a new login receives while `issue_new_model = off`** (must be defined — this is the ADR-010 gap, and it cannot be a mechanism that silently drops auth *or* one that reopens CR-003): a **server-set session cookie carrying a bounded-`exp` JWT** — `HttpOnly`, `Secure`, **same-site host-only** on the API host (§2.3), with an explicit `exp` set to a **concrete, chosen duration** — _proposed **7 days** absolute_. It must be a fixed value, **not** "the pre-migration session length": the current login paths do not share one consistent cookie lifetime, so inheriting "whatever the old flow did" is undefined. It reuses the pre-migration cookie **transport**, but the credential inside **must carry an `exp`** — it is **not** the current no-`exp` JWT. This matters for two reasons the review flagged:

- **It must not reopen CR-003.** The whole point of this ADR is that a copied credential cannot live forever. A rollback that re-issued the existing no-`exp` cookie JWT would silently undo that. The bounded `exp` keeps a copied rollback cookie time-limited.
- **It must survive the Phase-2 sunset (§2.6).** Phase 2 makes `resolveSessionUser` **reject any token without a valid `exp`**. A no-`exp` rollback cookie would start failing the moment the sunset lands (or would force the sunset to carve out an exception, weakening it). An `exp`-bearing rollback cookie passes the sunset check unchanged.

This is **reload-safe** within its `exp` (the browser persists the cookie, so a refresh keeps the user signed in) and needs no mid-session interactive re-login until the bounded `exp` elapses, at which point the user re-authenticates — an acceptable, *bounded* cost. Rollback simply stops emitting the new access+refresh pair and the `localStorage` copy; the one thing it **permanently refuses** to restore is the durable, XSS-readable **`localStorage` bearer**. Being `HttpOnly` *and* `exp`-bounded, this fallback is strictly better than the pre-remediation status quo on both the XSS and the lifetime axes.

- *Explicitly rejected new-login options* (each fails the reload-safe / no-silent-logout bar, so none is the default): a **short-lived in-memory access token with no refresh** — lost on reload and forces interactive re-login every ~15 min (this was the earlier draft's error); an **in-memory legacy non-expiring bearer** — also lost on reload; **"no login until rollback ends"** — a needless outage. Any of these could be a *conscious* opt-in for a specific incident, never the silent default.

Rollback postures, by where the defect is — the ADR **recommends Drain** when refresh is healthy and **Emergency** when it is not:

1. **Drain (recommended when the defect is NOT in refresh — e.g. issuance/frontend):** `issue_new_model = off`, `honor_existing_refresh = on`. Migrated clients keep rotating and drain naturally as sessions hit the absolute cap or log out; new load stops. Flip `honor_existing_refresh` off only once the active-session metric reaches ~0.
2. **Dual-support:** keep both models fully live until telemetry shows the new-model population has drained, then remove.
3. **Emergency / forced re-auth (required when the defect IS in refresh, or as last resort):** set `honor_existing_refresh = off` (and `emergency_reauth = on` if the bug is actively dangerous) — this **does** log migrated users out, which is the correct trade when continuing to run the buggy refresh path is the greater risk. A conscious decision, never the silent default.

Never re-expose `localStorage` tokens once removed. The rows above plus this continuity note are the only rollback actions; earlier wording that said both "drop the collection" and "keep records" conflated the migration and feature contexts.

## 4. Consequences

- **Positive:** bounded stolen-token lifetime; reset/change/logout-all actually revoke; theft (refresh reuse) is detected and contained; no durable token in `localStorage`; per-device visibility.
- **Negative / cost:** a `Session` compare-and-swap on refresh (not on every request); frontend token-refresh plumbing **including cross-tab single-flight** (§2.2); a coordinated sunset. **No reverse-proxy is needed** (the refresh flow is same-site by virtue of the shared registrable domain, so a **host-only** cookie suffices, §2.3). The happy-path rotation needs **no Mongo transaction** — it is a single-document compare-and-swap; the multi-write paths (reset/logout-all/theft) are made safe by the **durable `sv` epoch fence + signing with the captured `authVersion`** (§2.2/ADR-014), so ordering — not a transaction — is the correctness mechanism, and the retryable cleanup is drained by the outbox. Password reset already avoids transactions via the mark-used one-time claim (§2.5). **New cost surfaced by this review:** the `authVersion` fence adds a `User.sessionVersion` read to each refresh, and D12/immediate-revocation (if chosen) needs a cross-instance cache, not a process-local one (§2.4).
- **Neutral:** exam idempotency/finalization/timing are unaffected; the rollout window is chosen to avoid interrupting in-progress exams.

## 5. Open questions (require sign-off before implementation)

1. Access-token lifetime (15 min?) and refresh sliding/absolute caps (30/90 days?).
2. Cookie scope confirmation: is the **host-only** refresh cookie (`Domain` omitted, §2.3) accepted, with a browser matrix run on Safari/iOS/privacy browsers before locking `SameSite=Lax`? (No reverse proxy is proposed; the earlier "Option A — same-origin API via the edge" question is withdrawn as moot.)
3. Reuse-detection strictness (§2.2): approve the **10 s** benign-retry grace window (below which the immediately-previous generation is a benign `409`, above which it is theft) and the **N = 10** ring depth (the security/observability trade-off of the bounded authenticated-replay window — replays older than `N` degrade to "invalid → re-auth", not a theft alarm). The grace-state contract is **decided as strict `409` (no rotation)**; the rotating "leeway" alternative is rejected as unsafe (leapfrog), and the only sanctioned relaxation, if ever needed, is a separately-reviewed idempotent-response cache (§2.2 case 7) — flag if product wants that scoped now.
4. Legacy-token sunset date T and the metric threshold that gates it.
5. Change-password UX: acceptable to require the frontend to swap tokens (keeps the acting device signed in)?
6. Session-status checking on the access path (ADR-009/018): does the per-request access check consult `Session` status for **immediate** single-device/theft revocation, or is stateless validation with a ≤15-min access-TTL exposure acceptable? If immediate is chosen, the revoked-`sid` cache **must be cross-instance** (shared store or synchronous invalidation), not process-local (§2.4) — approve that cost? (Logout-all is immediate either way via the `sv` bump.)
7. Feature-rollback posture (§3, ADR-010): approve the **component-level flags** (`issue_new_model` / `honor_existing_refresh` / `emergency_reauth`), the **Drain-when-refresh-is-healthy / Emergency-when-the-defect-is-in-refresh** rule, and the **reload-safe, bounded-`exp` HttpOnly session cookie** as what a new login receives during rollback (never the `localStorage` bearer, never a no-`exp` token that would reopen CR-003 or clash with the Phase-2 sunset, and not a mechanism that drops auth on reload)? Confirm the rollback-cookie `exp` as a **concrete fixed duration** (proposed **7 days**), not "the pre-migration session length" (which is not consistent across the current login paths).
8. Scope alignment with AUD-019 (CSP/HSTS/security headers) and AUD-008 (rate limits, password policy, anti-enumeration) so identity hardening ships coherently.
9. **CSRF mechanism (D17):** pick **double-submit CSRF token** or **strict `Origin`/`Referer` allow-list** for state-changing POSTs once the cookie flow lands. CORS alone does not prevent a cross-origin POST from being *sent*, so one of these must be chosen and tested; they are different implementation contracts.
10. **Cookie names & route surface:** confirmed (Gate 0) as `__Secure-exq_rt` (`Path=/api/users/refresh`) / `__Host-exq_sess` (`Path=/`), §2.3/D19, and the ADR-016 decision to **retain `/api/users/*` paths** (adding only `/refresh` + `/logoutAll`, keeping `GET /logout` as a temporary alias) rather than introducing a new `/api/auth/*` surface.
11. **API entry-point coverage:** confirm all five `generateToken` call sites (register, login, loginWithCode, google×2) migrate together, and that the frontend `localStorage` sweep (~21 sites) is tracked to completion, not just the auth service (§8/D11).

## 6. What is already true on the remediation branch

- `User.sessionVersion` + shared `resolveSessionUser` validator (protect/attachUser/loginStatus) — the revocation substrate this ADR builds on. These `sv` tokens still have **no `exp`** (bounded lifetime is Phase 1 above).
- `resetPassword` bumps `sessionVersion` and consumes its token via an **atomic one-time claim** (`findOneAndUpdate` sets `usedAt` before the password write), so the token cannot be redeemed twice — even if the password save commits and then errors (CR-005). A pre-commit failure safely strands only that token; the user recovers with a new reset link. This is a durable claim (not a delete-then-restore, which could re-enable a token after a committed change).
- Not yet: `exp`, refresh/rotation, `Session` records, storage change, logout-all, legacy sunset — all specified above.

## 7. Session data model (formal schema)

Mongoose sketch for the new collection (indexes and rationale inline). This is the normative shape referenced by §2.2.

```js
const sessionSchema = new Schema({
  _id:               { type: String },            // = sid (opaque high-entropy id, also the JWT `sid` claim)
  userId:            { type: Schema.Types.ObjectId, ref: "User", required: true }, // NO index:true — see index note
  authVersion:       { type: Number, required: true }, // IMMUTABLE auth epoch captured at creation (= User.sessionVersion then). ADR-014 fence.
  refreshHash:       { type: String, required: true },   // SHA-256 of the CURRENT refresh secret
  refreshGen:        { type: Number, required: true, default: 0 }, // current rotation generation
  usedRefreshHashes: { type: [{ gen: Number, hash: String, _id: false }], default: [] }, // bounded ring (last N=10)
  userAgent:         { type: String },            // device/browser label for the Profile session list
  ip:                { type: String },            // last-seen ip (coarse; retention-policy governed)
  createdAt:         { type: Date, required: true },
  lastUsedAt:        { type: Date },              // any successful use
  lastRotatedAt:     { type: Date },              // last happy-path rotation (drives the grace window)
  refreshExpiresAt:  { type: Date, required: true }, // sliding inactivity deadline (advanced per rotation)
  absoluteExpiresAt: { type: Date, required: true }, // immutable hard cap set at creation
  revokedAt:         { type: Date, default: null },  // set on logout/theft/reset
  theftFenceTarget:  { type: Number, default: null }, // CR-009: account-fence intent committed ATOMICALLY with a theft revoke; worker-swept on crash, then cleared
});
sessionSchema.index({ refreshHash: 1 }, { unique: true });        // fast rotation lookup; global uniqueness
sessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL sweep of dead sessions
sessionSchema.index({ userId: 1, revokedAt: 1 });                 // logout-all + Profile session list (also serves userId-prefix queries)
```

- **Index count:** four explicit indexes — unique `refreshHash`, TTL `absoluteExpiresAt`, compound `{ userId, revokedAt }`, and the sparse `theftFenceTarget` (CR-009 worker sweep). `index: true` is deliberately NOT set on `userId` (that would add a redundant fifth standalone `{ userId: 1 }` on top of the compound, which already serves `userId`-prefix lookups).
- **`authVersion` (ADR-014):** captured **once** at session creation from `User.sessionVersion` and never mutated. It is the fence that binds a refresh family to the auth epoch it was born in (used in the rotation predicate and to sign new access tokens — §2.1/§2.2). A reset/logout-all/change bumps `User.sessionVersion`; a stale family then fails the epoch check on its next rotation and cannot mint a current-epoch access token.
- `usedRefreshHashes` is capped at `N` by the `$slice: -N` in the rotation pipeline (§2.2); it never grows unbounded.
- `absoluteExpiresAt` is written once at creation and never mutated, which is what makes the `$min(nowPlus30d, "$absoluteExpiresAt")` in the pipeline safe and what makes the pre-read alternative equivalent.
- No refresh **secret** is ever stored in the clear — only SHA-256 hashes. The `sid`/`gen` locators are not secrets.
- **The rollback fallback cookie has NO Session record** — it is a self-contained bounded-`exp` JWT (§2.3/§3, ADR-015); nothing in this collection applies to it.

## 8. API surface (reconciled with the *actual* routes — ADR-016)

**Route strategy — retain existing paths, add only what is new.** The current app mounts everything at **`/api/users/*`** (`server.js`: `app.use("/api/users", userRoute)`). To minimize deployed-client churn this ADR **keeps the existing paths and their casing** and hardens them in place behind the feature flag; it does **not** introduce a parallel `/api/auth/*` surface. Only genuinely new operations get new endpoints: `POST /api/users/refresh` and `POST /api/users/logoutAll`. (An earlier draft's `/api/auth/*`, kebab-case names were aspirational and are dropped.)

**Current routes and their treatment** (verified in `routes/userRoute.js`):

| Existing route | Change under the new model | Compatibility |
| --- | --- | --- |
| `POST /api/users/register` | issue new pair + create `Session` (was `generateToken`) | — |
| `POST /api/users/login` | issue new pair + create `Session` | — |
| `POST /api/users/loginWithCode/:email` | issue new pair + create `Session` | — |
| `POST /api/users/google/callback/` | issue new pair + create `Session` (2 call sites: new + existing user) | — |
| `GET /api/users/logout` | revoke current `Session`, clear **both** cookies | **keep GET as a temporary alias**; add canonical `POST /api/users/logout`; migrate the frontend to POST, retire GET after clients drain |
| `PATCH /api/users/changePassword` | rebind+re-issue caller, revoke others, `sv`++ (§2.5) | same path/casing |
| `PATCH /api/users/resetPassword/:resetToken` | `sv`++ + revoke all (one-time claim already in this working tree, §6) | same path/casing |
| `GET /api/users/loginStatus` | see startup note below | same path |
| **`POST /api/users/refresh`** *(new)* | the epoch-fenced rotation + decision tree (§2.2) | new endpoint |
| **`POST /api/users/logoutAll`** *(new)* | `sv`++ (fence) then revoke all sessions | new endpoint |

**All five `generateToken()` call sites must migrate together** (verified in `controllers/userController.js`): `registerUser`, `loginUser`, `loginWithCode`, and `loginWithGoogle` (new-user and existing-user branches). Leaving any one on the old path keeps issuing no-`exp`/`localStorage` credentials and silently defeats CR-003/D11. An **auth-entry-point matrix test** must assert every one of these issues the new model (or the bounded rollback credential when `issue_new_model = off`) and never the legacy no-`exp` token.

**`loginStatus` under memory-only access tokens.** Today `loginStatus` inspects a presented token. With the access token in memory only, a **cold page load has no access token** (memory was cleared on reload). Startup sequence: the SPA first calls `POST /api/users/refresh` (the `HttpOnly` cookie bootstraps a fresh access token), and *only then* is `loginStatus` meaningful. In rollback-cookie mode, the rollback JWT cookie authenticates directly, so `loginStatus` works without a refresh call. `loginStatus` must therefore not be treated as the source of truth on boot; the refresh bootstrap is.

**Frontend `localStorage` sweep is not a one-file change (D11).** ~21 token-related `localStorage` reads/writes exist across ~19 files (App, AiAssistant, ExamCreateWizard, MaterialViewer, MathEditor, StructuredBuilder, Quiz, Result, SharedMaterial, JoinByLink, PendingJoinHandler, Login, Register, onboarding, …). D11 is complete only when **every** one is routed through the in-memory access-token accessor; a single auth-service edit is insufficient. Track them as an explicit checklist item in §14.

**`/api/users/refresh` status-code contract** (security-critical, maps 1:1 to the §2.2 precedence): `200` rotate · `409` grace (case 7) · `403` **confirmed theft only** (case 8) · `401` every other auth outcome incl. a benign revoked/stale cookie (cases 0–5, 9) · `5xx` infrastructure (case 10). `429` on any of these depends on AUD-008 rate limiting.

## 9. Threat model & security properties

| Threat | Mitigation in this ADR | Residual after full rollout |
| --- | --- | --- |
| **XSS exfiltrates a credential** | access token in memory only; refresh token in `HttpOnly` cookie; no `localStorage` (D11) | **Accurately stated (ADR-018):** script on the trusted frontend origin can still act as the user, call `/api/users/refresh` through the allowed CORS origin, read the returned **short-lived access token** from the JSON body, and exfiltrate it — that stolen access token is usable until its `exp` (≤15 min), *including after the tab closes*. What memory-only storage buys is that XSS **cannot read the `HttpOnly` refresh secret**, so it cannot mint an unbounded stream of access tokens or obtain a durable credential. Bounding the blast radius to one short-lived access token is the goal; eliminating XSS itself is AUD-019 (CSP). |
| **Copied/leaked token valid forever (CR-003)** | mandatory `exp` on access tokens; refresh sliding+absolute caps; Phase-2 sunset rejects any no-`exp` token (D3/D14) | ≤ access-TTL (copied access) / ≤ caps (copied refresh) |
| **Refresh-token replay / theft** | rotation + bounded authenticated replay-detection; theft ⇒ revoke + `sv`++ (D7/D8) | replay of an ancestor older than `N` gens is rejected as invalid (no alarm) — accepted, fail-safe |
| **Concurrency / lost-response false-positive theft** | strict `409` contract + client single-flight (D5/D9) | occasional forced re-login on genuine response loss |
| **`sid`-guessing DoS (force-logout a victim)** | never revoke on an *unauthenticated* presentation (§2.2 case 9) | none for this vector |
| **Session fixation** | `sid` is server-minted high-entropy; sessions created only on successful auth | none |
| **CSRF on state-changing POSTs** | `SameSite=Lax` + CSRF token / strict `Origin` check (D10) | pending browser-matrix confirmation |
| **Mass logout on deploy/rollback** | flagged staged rollout; drain rollback; bounded-`exp` cookie fallback (D15/D16) | Emergency posture intentionally logs out when the defect is in refresh |
| **Reset-token reuse** | atomic mark-used one-time claim (implemented in this working tree, CR-005) | none (fail-closed) |

Core invariant the design preserves: **exactly one live refresh secret per session at any instant, and the generation counter advances only via a genuine rotation.** Strict Contract A is what keeps this true (a rotating leeway would break it — §2.2).

## 10. Test plan (Rule 12 — add before/with implementation)

Backend, in-memory Mongo, mirroring the existing suites. `MongoMemoryReplSet` is only needed if any step is made transactional (none currently are).

- **Rotation happy path:** valid current refresh ⇒ new pair at `gen+1`; old secret ringed; `refreshExpiresAt` advanced but ≤ `absoluteExpiresAt`.
- **Sliding/absolute boundaries:** rotate just inside/outside the 30-day slide; assert rejection past `absoluteExpiresAt` even with recent activity.
- **Replay within window (theft):** present `gen-2` ⇒ `403`, `Session.revokedAt` set, `sv` incremented, security event emitted.
- **Replay beyond window:** present a `gen` evicted from the ring ⇒ `401`, session **not** revoked (DoS guard).
- **Grace `409`:** present `gen-1` within 10 s of `lastRotatedAt` ⇒ `409`, **no** state change, generation unchanged.
- **Grace expiry:** present `gen-1` after the window ⇒ `403` theft (not `409`).
- **No-leapfrog invariant:** interleave two holders of `gen-1`; assert the generation cannot be marched forward by alternating replays (the property that killed Contract B).
- **Logout / logout-all:** single revokes one `sid`; all revokes every session and bumps `sv` (assert every access token rejected next request).
- **`pendingSecurityActions` outbox:** inject an `sv`-bump write failure ⇒ record enqueued with idempotency key; worker re-applies idempotently; duplicate drain is a no-op.
- **Rollback cookie:** the fallback cookie JWT carries a valid `exp`; assert it is rejected by the Phase-2 `exp`-required check only *after* its own `exp`, never as a no-`exp` token.
- **Legacy sunset:** a no-`exp` token passes in Phase 1, is rejected in Phase 2.
- **Epoch fence — concurrent refresh vs reset (ADR-014):** race a refresh against a reset that bumps `sv`; assert the refresh either fails the epoch-fenced CAS (`401` superseded) or mints a token stamped with the *old* `sv` that the per-request check then rejects — **never** a live current-epoch token from a stale family.
- **Epoch fence — refresh vs logout-all** and **refresh vs change-password:** same invariant; change-password's caller survives (rebound to `n+1`) while all other families are fenced.
- **Change-password failure:** inject a failure in the caller rebind/re-issue *after* the `sv` bump ⇒ caller is logged out (`401`/re-auth), never left on a stale-epoch credential; other sessions still fenced.
- **Failed-CAS precedence (ADR-017):** table-drive the classification — current-but-expired ⇒ `401`; current-but-revoked ⇒ `401` (counted `revoked`, **not** theft); malformed `sid`/`gen`/secret ⇒ `401`; deleted/suspended user ⇒ `401`; simulated DB error ⇒ `5xx` (not an auth code); two concurrent *current*-token requests ⇒ exactly one `200`, the other `409` (not theft).
- **Cookie attributes & rotation expiry:** assert the refresh `Set-Cookie` carries `HttpOnly; Secure; SameSite=Lax; Path=/api/users/refresh` and **no `Domain`**; assert `Max-Age`/`Expires` is capped by the absolute/session deadline (not only the DB `absoluteExpiresAt`); assert the rollback cookie is a *distinct name* at `Path=/` with `Max-Age ≤` its JWT `exp`; assert logout/mode-change clears **both** names.
- **Extractor discipline (ADR-015):** a refresh cookie presented to a protected route is ignored by `getToken`; an access/rollback JWT presented to `/refresh` is ignored; `type` claim mismatch is rejected.
- **Auth entry-point matrix (ADR-016):** each of the five issuance sites (register, login, loginWithCode, google new/existing) issues the new model (or the bounded rollback credential when `issue_new_model = off`) and never a no-`exp`/`localStorage` token.

Each maps to a TEST_GAPS entry to be added when this ADR is scheduled (AUD-002-T*).

## 11. Observability & metrics

- **`auth_non_expiring_token_total`** — requests presented with a no-`exp` token; the Phase-1→2 sunset gate (§2.6). Must trend to ~0 before cutoff.
- **`auth_refresh_outcome_total{outcome=rotated|grace_409|revoked_401|superseded_401|expired_401|unknown_401|theft_403|infra_5xx}`** — the §2.2 precedence distribution. **Only `theft_403` (case 8) is the theft signal;** `revoked_401` (case 3, ordinary stale cookie after logout/reset) must **not** be counted or paged as theft (ADR-017). A `grace_409` spike suggests broken client single-flight; an `infra_5xx` spike is an availability signal, not an auth one.
- **`auth_theft_events_total`** — confirmed refresh reuse (paged, not just logged).
- **`pending_security_actions_depth`** — outbox backlog; a nonzero standing value means the `sv`-bump worker is failing (defense-in-depth degraded).
- **`auth_active_sessions`** — drives the drain-rollback gate (§3) and capacity planning.
- Alert thresholds are a sign-off item; wire dashboards alongside AUD-019.

## 12. Migration specification (Rule 10)

- **Session collection:** additive only — create the collection + indexes (§7). **No data migration/backfill**; sessions are created lazily on login. The migration script must support `--dry-run` (print intended index creations + current collection counts) and record a rollback note: *migration rollback* drops the empty collection + indexes (§3, only valid before any session exists).
- **`sv`/`usedAt` fields:** already added as optional schema fields in this working tree (not yet deployed) (`User.sessionVersion`, `Token.usedAt`); no backfill needed (absent = default). No production-data change (Rule 7 preserved).
- **Sunset (Phase 2):** a **validation-time** change in `resolveSessionUser` (reject no-`exp`), **not** a data migration. Gated by the metric (§2.6/§11); reversible by config until enforced.
- **Rollback cookie:** pure code (issue a bounded-`exp` cookie); no schema impact.
- **`pendingSecurityActions` outbox (formal spec — ADR-018):** a security-relevant collection created by the same migration as `Session`.
  ```js
  const pendingSecurityActionSchema = new Schema({
    _id:          { type: String },   // idempotency key: `<action>:<sid>:<targetVersion>`
    action:       { type: String, enum: ["sv-bump", "revoke-session"], required: true },
    userId:       { type: Schema.Types.ObjectId, required: true },
    sid:          { type: String },
    targetVersion:{ type: Number },   // for sv-bump; re-applied with a monotonic $lt guard
    reason:       { type: String },   // "refresh-reuse" | "reset" | "logout-all" | ...
    attempts:     { type: Number, default: 0 },
    nextAttemptAt:{ type: Date, required: true }, // backoff schedule
    leaseOwner:   { type: String, default: null }, // worker id holding the lease
    leaseUntil:   { type: Date, default: null },   // lease expiry (crash-safe hand-off)
    deadLetter:   { type: Boolean, default: false },// terminal after maxAttempts
    createdAt:    { type: Date, required: true },
  });
  pendingSecurityActionSchema.index({ deadLetter: 1, nextAttemptAt: 1 });      // drain query
  pendingSecurityActionSchema.index({ leaseUntil: 1 });                         // reclaim expired leases
  ```
  - **Idempotent drain / multi-worker lease:** a worker claims due records with a conditional update (`{ deadLetter:false, nextAttemptAt:{$lte:now}, $or:[{leaseOwner:null},{leaseUntil:{$lt:now}}] }` → set `leaseOwner`, `leaseUntil = now+lease`), applies the action, then deletes on success. Two workers cannot both hold a record (the lease write is a CAS); a crashed worker's lease expires and is reclaimed.
  - **Retry/backoff & dead-letter:** exponential backoff on `nextAttemptAt`; after `maxAttempts` set `deadLetter:true` and **page** (a stuck security action is a real incident).
  - **Enqueue-failure alerting:** the depth metric (§11) cannot observe a record that never enqueued, so the *enqueue* path itself emits `auth_outbox_enqueue_failed_total` and alerts — a failed enqueue means a security action may have been dropped, which must not pass silently.
  - This is defense-in-depth: the durable `sv` fence + ≤15-min access TTL already bound exposure (§2.2); the outbox exists so the sibling-fence/cleanup eventually completes even under partial failure.

## 13. Non-goals

- Full OAuth2/OIDC or an external IdP — out of scope; this hardens the existing first-party session.
- A device-management UI beyond "sign out all devices" (per-device naming/geo, trusted devices) — future work; the `Session` schema leaves room (`userAgent`, `ip`) but no UI is specified.
- Silver-bullet XSS prevention — that is AUD-019 (CSP/headers); this ADR only removes the *durable* credential from XSS reach.
- Per-request DB session lookups by default — only the optional short-TTL revoked-`sid` cache (D12) is on the table, and only if immediate single-device revocation is required.
- Changing exam attempt/finalization/timing semantics — explicitly untouched (§4 neutral).

## 14. Implementation task breakdown (execute only after sign-off)

**Gate:** do not start until §5 open questions are answered and this ADR moves to *Accepted*. Ordered so each step is independently shippable behind the feature flag.

1. `Session` model + indexes + migration (`--dry-run`, counts, rollback note) — §7, §12.
2. Refresh-token mint/parse/hash helpers (`<sid>.<gen>.<secret>`) + the rotation pipeline CAS — §2.2.
3. `/auth/refresh` decision tree (rotate / `409` / `403` theft / `401`) + `pendingSecurityActions` outbox + worker — §2.2, §8.
4. Access-token `exp` + `sid` claim; extend `resolveSessionUser` (still `id`, add `sid`, keep `sv`) — §2.1.
5. `/auth/login`, `/auth/logout`, `/auth/logout-all`; wire `Session` creation/revocation — §8.
6. Change-password re-issue + reset session-record revocation — §2.5.
7. Cookie config (host-only, `SameSite=Lax`, CSRF) + CORS credentialed allow-list — §2.3.
8. Frontend: in-memory access token, single-flight refresh, token-swap on change-password — §2.2/§2.5.
9. Rollback component flags + bounded-`exp` fallback cookie — §3.
10. Metrics/alerts + the sunset metric; then advance Phase 1→2 per the gate — §11, §2.6.
11. Regression suites per §10 (Rule 12) at each step; full suite green before flag exposure.

## 15. Review history & disposition log

Every raised item and how it was closed, so future readers see the reasoning, not just the result.

| Item | Raised | Disposition |
| --- | --- | --- |
| CR-001 | `sv` enforced only in `protect`; `attachUser`/`loginStatus` bypassed | **Closed** — shared `resolveSessionUser` across all three (implemented in this working tree, §6) |
| CR-003 | no `exp`; legacy tokens forever-valid | **Addressed in design** — mandatory `exp` + sunset (§2.6); remains open until implemented |
| CR-005 | reset-token reuse (delete-then-restore unsafe) | **Closed** — atomic mark-used one-time claim (implemented in this working tree, §6) |
| ADR-001 | one `prevRefreshHash` misses older replays | **Closed** — `refreshGen` + bounded ring (§2.2) |
| ADR-002 | sliding expiry not enforced | **Closed** — `refreshExpiresAt` in the CAS predicate (§2.2) |
| ADR-003 | concurrency/lost-response + multi-doc theft | **Closed** — decision tree + revoke-first outbox (§2.2) |
| ADR-004 | parent-domain cookie unnecessary/weaker | **Closed** — host-only + four-property table (§2.3) |
| ADR-005 | rollback logs migrated users out | **Closed** — drain + component flags (§3) |
| ADR-006 | server can't distinguish the two grace cases | **Closed** — single deterministic contract (§2.2 case 7) |
| ADR-007 | "full-chain" overstated | **Closed** — renamed bounded authenticated window (§2.1/§2.2) |
| ADR-008 | leeway CAS + `$min` unspecified | **Closed** — leeway rejected; happy-path pipeline specified (§2.2) |
| ADR-009 | revocation immediacy + durable retry | **Closed** — conditional guarantee + `pendingSecurityActions` (§2.4/§2.2) |
| ADR-010 | rollback re-login impossible / no-`exp` cookie | **Closed** — bounded-`exp` reload-safe cookie (§3) |
| ADR-013 | rollback cookie must be `exp`-bounded | **Closed** — accepted; concrete 7-day proposed lifetime (§3) |
| ADR-014 | refresh families not bound to auth epoch | **Closed** — immutable `Session.authVersion` fence + sign-with-captured-epoch + bump-first ordering + change-password rebind (§2.1/§2.2/§2.5) |
| ADR-015 | refresh vs rollback cookies conflated | **Closed** — two distinct names/paths/claims/extractors, `Max-Age ≤ exp`, both cleared (§2.3) |
| ADR-016 | API omits real routes + issuance paths | **Closed** — reconciled to `/api/users/*`, all 5 `generateToken` sites, GET→POST logout alias, `loginStatus` bootstrap, ~21-site `localStorage` sweep (§8) |
| ADR-017 | failed-CAS classification incomplete | **Closed** — 11-step precedence; `403` = theft only; revoked/expired/superseded/unknown = `401`; infra = `5xx` (§2.2) |
| ADR-018 | XSS residual / CSRF / outbox underspecified | **Closed** — XSS residual restated; CSRF a decision (D17/§5.9); `pendingSecurityActions` formal schema + lease + dead-letter + enqueue-alert (§12); cross-instance cache caveat (§2.4) |
| Contract B | leapfrog vulnerability | **Rejected** — strict Contract A adopted (§2.2 case 7) |
| Minors | index count, `SameSite` cause, "shipped" wording, `utils` comment, FIX_RESULTS wording, cookie-attr tests | **Closed** — §7 index-count note (now four: + sparse `theftFenceTarget`, CR-009), §1 symptom/cause split, "implemented in this working tree" throughout, `utils/index.js` comment corrected, FIX_RESULTS updated, §10 cookie-attr assertions |

Protocol design is converged and every raised item is dispositioned above; the remaining gate is the product/security sign-off on the §2.0 *Proposed* values (§5).
