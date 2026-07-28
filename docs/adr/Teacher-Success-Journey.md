# ADR: Teacher Success Journey (activity-based teacher levels, referrals, AI credits)

- **Status:** **Proposed / frozen for implementation (2026-07-27).** The product and policy decisions in §2 are frozen by the controlling instruction and are not reopened during implementation. Everything ships behind the backend-owned flag `TEACHER_SUCCESS_JOURNEY_ENABLED` (default **off**). The Journey is never called production-live while the flag is off.
- **Date:** 2026-07-27
- **Owner-gated follow-ups (out of scope here):** AUD-002 production session activation and AUD-019 hosted-edge CSP verification remain separately authorization-gated and are not part of this work.
- **Related:** `CLAUDE_NEXT_TASK.md` — "Teacher Growth Journey + referrals" and "frozen AI benefit policy" design foundation (this ADR is the controlling instruction where it differs from that older text); AUD-005 (do not undo); AUD-002 capability/trust separation; existing fail-closed migration pattern (`helper/attemptResultIndexes.js`, `helper/tokenIndexes.js`, `migrations/2026-07-27-attempt-result-indexes.js`).
- **Reading order:** §1 Context → §2 Frozen decisions → §3 Positioning & copy → §4 Capability separation → §5 Level entitlements → §6 Activity eligibility → §7 Referral system & fraud → §8 AI-credit system → §9 Manual promotion → §10 Upgrade requests → §11 Data model & migrations → §12 Feature flag & rollout → §13 UI → §14 Metrics & privacy → §15 Threat model → §16 Test plan → §17 Non-goals.

---

## 1. Context

Examopia teachers register, create classes, build exams (manual PDF + structured), publish, grade, and manage their own students/results. Today a broad `teacherApproval` gate can block a new teacher from doing safe own-scope work until an admin approves them, which delays time-to-first-value. Separately, AI-assisted exam creation calls paid providers (OpenAI/Gemini/Claude) with no per-teacher allowance or accounting boundary.

This ADR introduces an **activity-based recognition system** ("Teacher Success Levels": Spark → Momentum → Impact) that:

1. lets a new teacher receive value **immediately** (safe own-scope capabilities auto-granted), while risky capabilities stay behind verification/admin;
2. gives every level the **same** core exam tools and the **same** AI quality/models/privacy, differing only in **monthly AI allowance quantity** plus additive productivity benefits;
3. rewards teaching activity and verified referrals with **eligibility** and admin-driven promotion — never automatic promotion, never a security-privilege change, never a paywall.

**This is not a payment or subscription system.** No Stripe, no other payment processor, no prices, no paywall styling, no subscription terminology. A future commercial subscription is a separate, unimplemented concern.

## 2. Frozen decisions (do not reopen)

| # | Decision | **Frozen value** |
| --- | --- | --- |
| D1 | Customer-facing name | "Teacher Success Levels" (never "pricing packages"/"plans") |
| D2 | Levels | Spark (`spark`, Başlanğıc) → Momentum (`momentum`, İrəliləyiş) → Impact (`impact`, Təsir) |
| D3 | Starting level | Every new teacher starts at **Spark**, immediately |
| D4 | Audience | Teacher-only. Students never see levels. Admins manage but do not participate. |
| D5 | Core access | All core exam-creation/management tools available at **every** level; never gated by level; manual workflows always available even at 0 AI credits |
| D6 | AI parity | AI **quality, provider safety, privacy, and available models are identical** at every level. Only the monthly **allowance quantity** differs. Manual exam creation never consumes AI credits. |
| D7 | Monthly AI allowances | Spark **100**, Momentum **300**, Impact **750** credits (validated config, not scattered constants) |
| D8 | Promotion policy | First release is **admin manual promotion only**; activity/referrals produce progress + eligibility + `recommendedNextLevel`, never auto-promotion |
| D9 | Demotion | **No** automatic demotion for inactivity. Decay/demotion is a separate future decision. |
| D10 | Level ≠ security | Growth level is never used in `teacherOnly`, ownership, admin, or cross-tenant authorization. Momentum/Impact grant **no** extra data/admin/global/cross-tenant access. |
| D11 | Referral links | Non-sequential random codes `/register?ref=<code>`; at most one referrer bound at registration; `referredBy` immutable; no retroactive switch; no circular A→B→A; a signup alone never qualifies |
| D12 | AI credit charging | Idempotent reserve-before-provider / commit-after-usable-output / release-on-failure, keyed by a unique operation/request key; concurrent requests cannot overspend; retries/streaming reconnects cannot double-charge |
| D13 | Grading safety | Essential grading/finalization of an already-published exam must never fail due to optional AI-creation credits |
| D14 | Monthly boundary | Calendar month in **UTC**, no rollover initially; promotion mid-month raises the current ceiling immediately; consumed credits stay consumed; temporary grants add and may expire |
| D15 | Data boundaries | No unbounded arrays on `User`. Dedicated collections for history/activity/referral/upgrade-request and AI credit period/ledger/grants. |
| D16 | Feature flag | `TEACHER_SUCCESS_JOURNEY_ENABLED` (backend-owned, default off). Flag-off creates no Journey collections/indexes from model import; migrations own collection/index creation. Frontend enablement comes from a trusted backend config/identity response, not only a Vite flag. |
| D17 | No payments | No Stripe/payment processor; no prices/discounts/urgency/"upgrade by paying"/subscription wording anywhere. |

## 3. Positioning & copy (frozen strings)

Wherever a level or AI allowance appears, display the activity-based explanation. These exact strings are frozen.

**Azerbaijani — level/positioning:**
> "Səviyyəniz ödənişlə deyil, müəllim fəaliyyətiniz və təsdiqlənmiş tövsiyələriniz əsasında yüksəlir. Bütün əsas imtahan yaratma alətləri hər səviyyədə açıqdır."

**Azerbaijani — AI:**
> "AI alətləri bütün səviyyələrdə mövcuddur. Daha aktiv müəllimlər daha yüksək aylıq AI limiti əldə edir. Bu ödənişli paket deyil. Manual imtahan yaratmaq AI limitindən asılı deyil."

**English — level/positioning:**
> "Your level is earned through teaching activity and verified referrals. It is not a paid plan. All core exam-creation tools are available at every level."

**English — AI:**
> "AI tools are available at every level. More active teachers receive a larger monthly AI allowance. These are activity-based levels, not paid plans. Manual exam creation never requires AI credits."

**Banned in all Journey UI:** paywall styling, prices, discount language, fake urgency, "upgrade by paying", subscription terminology, color-only status signalling.

Copy lives in one localized constants module (`config/teacherSuccess.copy.js` or equivalent), single-sourced so the frozen strings cannot drift between header, panel, and dashboard card.

## 4. Capability separation (the security spine)

Four **separate** concepts, never conflated:

1. **Account role** — `student | teacher | admin` (unchanged).
2. **Security trust / server-derived capabilities** — what the server lets this account actually do.
3. **Growth level** — `spark | momentum | impact` (recognition only).
4. **Future commercial subscription** — separate, not implemented now.

### 4.1 Capability decomposition

The broad teacher permission is decomposed into **server-derived capabilities**. A new teacher is automatically granted **safe own-scope** capabilities so they receive value immediately:

- `exam:create:own`, `exam:manage:own`, `exam:publish:own`
- `class:manage:own`
- `results:view:own`

Risky capabilities stay behind **verification / admin approval**:

- `data:access:other-owner` (any other teacher's/student's data)
- `messaging:bulk`, `invite:bulk`
- `export:students:bulk` (large student-data exports)
- `ops:high-volume`
- `mutation:global` / `mutation:public`
- `admin:*`

Rules:
- Capabilities are **server-derived** from role + verification/approval + ownership; never derived from growth level. `teacherLevel` must never appear in a capability or authorization decision.
- **Object ownership is enforced on the backend** for every own-scope capability (the resource's `owner`/`createdBy`/`teacherId` must equal the requester).
- The approval screen is updated so a new **Spark** teacher is not blocked from safe own-scope creation, while risky capabilities remain gated.

### 4.2 Router permission matrix (proof obligation)

A real router-level permission matrix test proves:
- a new Spark teacher **can** create and publish **their own** exam;
- the same teacher **cannot** access another teacher's exam/class/results, cannot perform admin actions, and cannot perform bulk/global operations;
- forging `teacherLevel` (or any client field) grants no capability.

The exact per-route capability mapping (every `teacherOnly` route → own-scope vs gated) is enumerated in Appendix A (§A) and mirrored by the matrix test.

## 5. Level entitlements

One **server-authoritative entitlement registry** (`config/teacherSuccess.entitlements.js`) is the single source; the frontend may display entitlements but backend enforcement is required for any genuinely level-restricted additive feature. **No benefit is advertised until it is actually implemented.** An existing feature already available to everyone (e.g. analytics/exports) is **not** removed from Spark to manufacture differentiation.

| Entitlement | Spark | Momentum | Impact |
| --- | --- | --- | --- |
| All core creation/management tools | ✅ | ✅ | ✅ |
| AI quality / models / privacy | same | same | same |
| Monthly AI credits | 100 | 300 | 750 |
| Activity/referral progress + request controls | ✅ | ✅ | ✅ |
| Reusable private AI/template presets | — | ✅ | ✅ |
| Priority review of temporary AI-credit requests | — | ✅ | ✅ |
| Community/template feedback eligibility | — | eligible | eligible |
| Additive advanced insights (where newly implemented) | — | ✅ | ✅ |
| Additive batch productivity workflows (still credit-charged) | — | — | ✅ |
| Moderated featured-teacher/template eligibility | — | — | ✅ |
| Explicitly flagged early-access functionality | — | — | ✅ |
| Priority support/request classification | — | — | ✅ |

Higher levels are **additive only** — they never remove functionality an existing teacher already has. Any entitlement marked additive is only surfaced/enforced once actually implemented; unimplemented rows are not advertised.

## 6. Activity eligibility

Count **meaningful server-authoritative outcomes**, not page views, clicks, drafts, repeated edits, or duplicated events. Thresholds live in one validated config (`config/teacherSuccess.thresholds.js`). Meeting a threshold marks the teacher **"Ready for review"**; it never silently promotes.

**Spark → Momentum**
- *Activity path:* ≥1 published exam; ≥2 completed attempts from **real student accounts**; meaningful activity on **2 distinct days**.
- *Referral path:* ≥1 qualified referral.

**Momentum → Impact**
- *Activity path:* activity during **4 distinct weeks** in a rolling **60-day** window; **5 exams** each with ≥1 genuine completed attempt; **20** completed attempts; ≥**5 distinct real students**.
- *Referral path:* **3** qualified referrals **and** ≥5 organic completed student attempts; **or** explicit admin review on documented evidence.

Idempotency: use idempotent **daily aggregates** and **domain-event keys**. Duplicate events, retry storms, draft spam, and self-actions must not inflate progress.

## 7. Referral system & fraud controls

### 7.1 Lifecycle

`pending → qualified → rewarded`, plus terminal/review states `held`, `rejected`, `revoked`. Store timestamps, reason, reviewer, evidence, and an **idempotent reward key**.

### 7.2 Binding rules

- Random non-sequential code, link `/register?ref=<code>`.
- At most one referrer bound during registration; `referredBy` immutable; no retroactive switching; no circular A→B→A.
- A signup alone never qualifies. Surname is **not** identity evidence.
- A qualified referral makes the referrer **eligible for review** — it does not auto-promote in this release.

### 7.3 Qualification defaults

- Verified email **or** verified OAuth identity (unconditional `isVerified:true` is not evidence).
- Account age ≥ **7 days**.
- ≥1 published exam.
- ≥2 completed attempts from genuine student accounts.
- Activity on distinct days.
- Not suspended/deleted.
- No hard identity collision.

### 7.4 Fraud controls

- **Hard-reject the reward** (not the signup) for reused verified phone or reused OAuth provider subject.
- Detect self-referral and referral rings; reject circular claims.
- Normalize email **case**, but do **not** assume Gmail-style alias stripping generalizes across providers (use alias signals as *risk*, not identity).
- Use a **signed first-party device identifier** as a risk signal; device reuse, velocity, disposable email, timing, and ring structure are **review** signals. No invasive fingerprinting.
- Shared school **IP/NAT alone never rejects or locks** a user.
- Multiple soft signals place **only the referral reward** in `held` (never block creation tools).
- Rate-limit referral claims; cap referral-derived eligibility per configured period.
- Revoking a fraudulent reward is **idempotent** and never removes core exam tools.
- Admin referral-review inbox: evidence, risk reasons, approve/reject/revoke.

## 8. AI-credit system

### 8.1 Operation → credit table

Every shipping AI endpoint/action is inventoried (Appendix B, §B) and mapped to a **stable operation name** and integer credit weight in a central table (`config/teacherSuccess.aiCredits.js`). The client never supplies a cost; the server resolves the weight from the operation name. Weights are validated config, not scattered constants. Large actions **show the cost before** the teacher confirms.

### 8.2 Reserve / commit / release protocol (D12)

1. **Reserve** credits atomically (idempotency key = stable operation/request key) **before** the provider request. Concurrent requests cannot drive `used + reserved` past the ceiling.
2. **Commit** the charge after usable output is produced.
3. **Release/refund** the reservation when the provider fails before usable output.
4. **Cancellation after output** is defined and tested so it cannot be abused (output produced ⇒ charge committed).
5. Provider failure must never silently consume unused credits. Retries/reconnects/duplicate streams keyed by the same idempotency key never double-charge.
6. Essential grading/finalization of an already-published exam (D13) never consults or fails on AI-creation credits.

### 8.3 Storage & accounting (D15)

- `AiCreditPeriod` — unique `{ teacherId, periodMonthUtc }`; `baseAllowance`, `used`, `reserved`, `tempGranted`.
- `AiCreditLedger` — append-only; unique `idempotencyKey`; `operation`, `kind ∈ {reserve, commit, release, grant}`, `amount`, `actor`, bounded metadata.
- **Temporary admin grants** with reason, actor, expiry.
- Existing `AiUsage` records remain for provider/token/cost observability; the credit period/ledger is a **separate accounting boundary**. No unbounded credit-history array on `User`.

### 8.4 Monthly policy (D14)

- Calendar month UTC; no rollover initially.
- Header shows `remaining/base` allowance + reset date.
- Promotion mid-month immediately raises the current period ceiling; already-consumed credits stay consumed.
- Temporary grants add to the current allowance and may expire.
- No automatic reduction within a month.
- Exhausted **optional** AI endpoint returns a typed **429 `ai_credit_exhausted`** with `remaining:0` and `resetAt`. Manual workflows remain available.

### 8.5 Admin

Grant temporary credits (audited); view usage without PII-heavy/high-cardinality metric labels; see reservation/commit anomalies; promote; audit every manual grant.

## 9. Manual promotion (first release)

Only an **admin** can promote. Activity/referrals produce progress/eligibility/`recommendedNextLevel`/evidence only.

Admin behavior:
- List all teachers with Spark/Momentum/Impact badges; filter by level, eligibility, activity, referral state.
- Show the evidence that made the teacher eligible.
- "Promote to next level" button; require confirmation + non-empty reason.
- Promote **one level per normal action**.
- Write **immutable** before/after history (admin, reason, time).
- Concurrent/retried clicks promote **once** (advance-only CAS on `levelVersion`).
- Exceptional admin correction/reversal: stronger confirmation + audit history; **never** removes core creation access.
- **No** automatic demotion for inactivity.

## 10. Upgrade requests

Teachers may request the next level even before automatic eligibility.

Capture: current level, requested target, class/student size, intended platform use, requested benefit, reason, contact preference, snapshot of current activity/referral evidence.

Rules: one open request per `{teacher, target}`; retried submissions idempotent; a request never grants a level or security capability; admin inbox supports approve/promote, deny, request-info; every decision has reviewer + reason + history; the teacher sees current request status.

## 11. Data model & migrations

### 11.1 Minimal `User` fields (D15)

- `teacherLevel: 'spark' | 'momentum' | 'impact'` (default `spark`)
- `levelSince: Date`
- `levelSource: 'activity' | 'referral' | 'admin' | 'subscription'`
- `levelVersion: Number` (advance-only CAS)
- `referredBy` (immutable, set at registration), referral `code` (random, indexed)

### 11.2 Dedicated collections

- `TeacherLevelHistory` — immutable old/new/source/reason/actor/time.
- `TeacherActivityDaily` — one bounded aggregate per teacher/day, unique `{ teacherId, date }`, idempotent domain-event handling.
- `TeacherReferral` — unique referee, referrer, state, evidence, risk reasons, unique reward key.
- `TeacherUpgradeRequest` — target, structured demand, decision/reviewer/audit.
- `AiCreditPeriod`, `AiCreditLedger`, `AiCreditGrant` (grants may live as ledger `grant` entries + period `tempGranted`).

### 11.3 Indexes & startup verification

Exact indexes for every collection, expressed in a **shared contract** (mirroring `helper/attemptResultIndexes.js`): single source for BUILD (migration builds natively from the contract) + VERIFY (migration/startup) + a drift test proving `model.schema.indexes()` equals the contract. Models set `autoIndex:false` so flag-off/import creates no indexes.

### 11.4 Fail-closed migrations

Each Journey migration supports `--dry-run`, explicit `--apply` + `--batch`, `--verify`, reviewed `--rollback`; **refuses before connecting** on unapproved DB names (exit 3); idempotent retries; collision + dirty-data census; response-loss/failpoint tests.

Existing teachers default **conservatively to Spark** unless an explicit reviewed migration decision promotes them. **Never infer Impact** from ambiguous historical data.

## 12. Feature flag & rollout (D16)

- `TEACHER_SUCCESS_JOURNEY_ENABLED=false` (backend-owned; validated at startup).
- **Flag-off** must remain fully compatible and must **not** create Journey collections/indexes from normal model import (migrations own creation). No runtime schema side effects.
- Frontend receives the enabled state from a **trusted backend config/identity response** (e.g. `/api/config` or the `/me` identity payload), not only a Vite flag.

Rollout phases (do **not** enable in production):
1. Models, migrations, services — flag off.
2. Admin preview.
3. Internal/test teachers.
4. Teacher UI.
5. Activity/referral collection.
6. Manual promotion + AI enforcement.

## 13. UI (summary; full spec in frontend queue)

- **Persistent teacher-only header indicator** — e.g. "Spark · AI: 72/100 qalıb": current level, remaining/allowance, low + exhausted states, reset date in accessible tooltip, no payment wording, not color-only (text + icon + keyboard + SR labels). Low-balance warning at a configurable threshold (default 20%).
- **Panel** (on click): Spark/Momentum/Impact progress, current + next-level benefits, activity criteria + honest progress, qualified/pending/held referral counts, referral share link, request-next-level, request-more-credits, frozen non-paid reassurance, "manual creation remains available".
- **Teacher Success card** on the teacher dashboard.
- **Admin**: level badges + filters, evidence, one-step promote (confirm+reason), referral risk/review inbox, upgrade-request inbox, immutable history.
- **No student-facing level UI.**

## 14. Metrics & privacy

Funnel: signup → first exam → first publish → first student → first completion → Momentum → Impact. Time-to-first-value, teaching days, distinct students, referral states, upgrade-request conversion. **No** raw email/phone/IP or high-cardinality metric labels; admin usage views exclude PII-heavy labels.

## 15. Threat model (abridged)

- **Privilege via level:** client forges `teacherLevel`/credits/eligibility → rejected; level never consulted in authz (§4).
- **Credit overspend:** concurrent/retry/reconnect → atomic reserve + idempotency key (§8.2); provider failure releases reservation.
- **Referral fraud:** self-referral, rings, reused phone/OAuth subject, disposable email, device/velocity bursts → hard-reject reward or `held`; shared NAT never blanket-blocks (§7.4).
- **Promotion abuse:** concurrent/retried promote → advance-only CAS promotes once; immutable audit (§9).
- **Flag-off leakage:** import creates no collections/indexes; no runtime schema side effects (§12).

## 16. Test plan

Backend, frontend, and disposable E2E as enumerated by the controlling instruction §13 (mirrored in the Teacher Success execution ledger). Test-first: failing backend domain tests precede implementation. Highlights: Spark default + safe own-scope + no cross-owner/admin access; client cannot forge level/credits/eligibility/capabilities; every threshold boundary; duplicate/concurrent activity counted once; draft/edit spam ignored; manual promotion advances exactly one level once; immutable history; referral state machine; self-referral/same-identity fraud; shared NAT not blanket-rejected; suspicious referral held; upgrade-request idempotency; AI monthly reset boundary; promotion mid-cycle raises allowance; concurrent reservations cannot overspend; retries/reconnects do not double-charge; provider failure releases; temp grants + expiry; no AI allowance grants privilege; migration dry/apply/verify/rollback + failpoints; flag-off creates no schema side effects.

## 17. Non-goals

- Any payment/subscription/pricing (explicitly banned).
- Automatic promotion or automatic demotion in this release.
- Using growth level for authorization.
- Advertising unimplemented benefits.
- Enabling the Journey in production.

---

## Appendix A — teacherOnly route → capability map

Grounded in the live inventory. Auth truth is `middleware/authMiddleware.js` (`hasTeacherCapability` = admin OR teacher with `teacherApproval ∈ {approved, approved_legacy}`); object ownership is enforced in controllers (`ownsOrAdmin` in `quizController.js`). The Journey **does not** change these gates; it decomposes them into named capabilities and auto-grants the safe own-scope subset to a new Spark teacher (see §4).

**Auto-granted to a new Spark teacher (safe own-scope, ownership re-checked in controller):**

| Capability | Representative routes |
| --- | --- |
| `class:manage:own` | `POST /addClass`, `PATCH /editClass/:classId`, `DELETE /deleteClass/:classId`, `PATCH /class/:classId/joinSettings` |
| `exam:create:own` | `POST /addExam/:classId`, `POST /addQuestion/:examId`, `POST /uploadPdf` |
| `exam:manage:own` | `PATCH /editExam/:examId`, `DELETE /deleteExam/:examId`, `PATCH /setExamHidden/:examId`, `GET /archivedExams`, `PATCH /exam/:examId/restore`, `DELETE /exam/:examId/forever`, tags (`/addTag` etc.), materials/videos own CRUD |
| `results:view:own` | `GET /getResultsByExam/:examId`, `GET /getExams`, `GET /storage` (own) |

**Kept behind verification / admin (NOT auto-granted):**

| Capability | Representative routes |
| --- | --- |
| `data:access:other-owner` | `GET /getUserById/:id` (other students), `GET /class/:classId/students`, `GET /teacher/requests`, `POST /addPhotoToResult/:resultId` |
| `invite:bulk` / roster mutation | `POST /class/:classId/addStudent`, `PATCH /enrollment/:id`, `GET /class/:classId/assignable` |
| `mutation:global` | `POST /addExamToUserById/:userId` (grants an exam onto another account) |
| `messaging:bulk` | `POST /whatsapp/test`, `POST /whatsapp/group/test` (send messages), Telegram automation broadcast |
| `export:students:bulk` | large student-data exports (results export surfaces) |
| `admin:*` | everything under `adminOnly`: `DELETE /deleteUser/:id`, `PATCH /users/bulk`, `POST /upgradeUser`, `PATCH /:id/storage`, `GET /aiUsage`, teacher overview/onboarding reports |

The router permission matrix test (§4.2) asserts a new Spark teacher reaches the first group for their own resources and is refused (403/401) on the second group and on any other owner's object.

## Appendix B — AI operation → credit weight table

Grounded in `controllers/aiController.js` `module.exports`. Each shipping **optional AI-creation** action gets a stable operation name + integer weight in `config/teacherSuccess.aiCredits.js`. Client never supplies cost; the server resolves the weight from the operation. Weights are initial validated config.

| Operation (stable name) | Route | Weight | Notes |
| --- | --- | --- | --- |
| `ai.extract.questions` | `POST /extractQuestions[/Stream]/:examId` | 5 | PDF → structured questions (multi-provider) |
| `ai.generate.questions` | `POST /generateQuestions[/Stream]/:examId` | 5 | prompt → questions |
| `ai.regenerate.question` | `POST /regenerateQuestion/:examId` | 1 | rewrite one question |
| `ai.chat.message` | `POST /chat` | 1 | in-dashboard assistant turn |
| `ai.transcribe.audio` | `POST /transcribe` | 2 | voice → text |
| `ai.realtime.session` | `POST /realtime-token` | 5 | mints an ephemeral Realtime secret (charge on issuance) |
| `ai.models.list` | `GET /ai/models` | 0 | no provider call — not a chargeable/optional op |

**Not charged (essential, D13):** grading/finalization of an already-published exam never consults credits. **Admin-only** `GET /aiUsage` is observability, not a teacher AI op. Streaming variants share the same operation name + idempotency key as their non-streaming counterpart so a reconnect cannot double-charge.
