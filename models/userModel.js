const mongoose = require('mongoose')
const Schema = mongoose.Schema
const bcrypt = require('bcryptjs')

const userSchema = Schema(
    {
        name: {
            type: String,
            required: [true, "Please add a name"]
        },
        email: {
            type: String,
            required: [true, "Please add an email"],
            unique: true,
            trim: true,
            // AUD-008 (CR-050): store the CANONICAL (lower-cased) address so the
            // unique index is effectively case-insensitive. Lookups also normalize
            // via utils.normalizeEmail (a setter alone doesn't lower-case query
            // conditions). Migration 2026-07-26-canonical-email backfills legacy rows.
            lowercase: true,
            match: [
                /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
                "Please enter a valid email",
            ],
        },
        password: {
            type: String,
            required: [true, "Please add a password"],
            // AUD-001: never serialize the bcrypt hash by default. Any query that
            // legitimately needs it (login / change-password comparison) must opt
            // in with .select("+password"). This makes hash exclusion a schema
            // default rather than call-site-dependent.
            select: false,
        },
        // AUD-002 (partial): a monotonically-increasing token-version. New JWTs
        // embed the value current at issue time (`sv`); the shared session
        // validator (protect / attachUser / loginStatus) rejects a token whose
        // `sv` no longer matches. Incremented on password RESET so it REVOKES
        // previously-issued sessions. (Change-password does NOT increment yet — it
        // would revoke the caller's own in-flight token and needs coordinated
        // frontend auto-logout; see FIX_RESULTS AUD-002.) Legacy tokens with no
        // `sv` claim are grandfathered (no forced logout) until re-login.
        sessionVersion: {
            type: Number,
            default: 0,
        },
        photo: {
            type: String,
            required: [true, "Please add a photo"],
            default: "https://i.stack.imgur.com/34AD2.jpg",
        },
        phone: {
            type: String,
            default: "+994",
        },
        // Whether the student wants automatic WhatsApp notifications (e.g. when a
        // new exam is published to their class). Default on; students can opt out.
        whatsappOptIn: {
            type: Boolean,
            default: true,
        },
        // Set true once the student is verified to be in the WhatsApp notify
        // group (checked against the group's participants). Gate stops prompting.
        whatsappGroupJoined: {
            type: Boolean,
            default: false,
        },
        // PER-TEACHER WhatsApp notify config (teachers): the group this teacher's
        // exam alerts post to, and an optional invite link to share with students.
        whatsappGroupId: {
            type: String,
            default: "",
        },
        whatsappInviteLink: {
            type: String,
            default: "",
        },
        // Student's grade/year ("Sinif"), e.g. "9", "11", "Məzun". Collected at
        // sign-up (and enforced via the profile-completion gate for students).
        grade: {
            type: String,
            default: "",
        },
        bio: {
            type: String,
            default: "bio"
        },
        // Staff preference: hide the floating AI assistant. Some teachers/admins
        // find it distracting; when true the app never even mounts it (no chunk,
        // no listeners, no AI calls). Default false = shown.
        hideAssistant: {
            type: Boolean,
            default: false,
        },
        role: {
            type: String,
            default: "student",
            required: true
            //student, teacher, admin (suspended)
        },
        deletedAt: { type: Date, default: null, index: true },
        deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        // AUD-005: the requested account TYPE (`role: "teacher"`) is separate from
        // the granted teacher CAPABILITY. A public registrant who asks for teacher
        // gets `role:"teacher"` but `teacherApproval:"pending"` — no teacher
        // capability until an admin approves. Existing teachers are migrated to
        // `approved_legacy` (preserves behavior, flags the legacy grant for review).
        // Capability is server-derived from THIS field, never from the request body.
        //   none            — not a teacher / never requested
        //   pending         — requested teacher, awaiting admin approval (NO capability)
        //   approved        — admin-approved teacher (capability granted)
        //   approved_legacy — pre-AUD-005 teacher, grandfathered pending admin review
        teacherApproval: {
            type: String,
            enum: ["none", "pending", "approved", "approved_legacy"],
            default: "none",
        },
        // AUD-005 (CR-041/CR-042): provenance for a GRANTED teacher capability —
        // who approved it, when, by which path, and (for migrations) under which
        // reversible batch tag. `approved_legacy` is MIGRATION-OWNED: only the
        // grandfather migration may create it, and only with method "migration" +
        // a batch tag, so a rollback can target exactly its own grants and an audit
        // can tell an admin decision from a migration grant. Cleared on revoke/demote.
        teacherApprovalMeta: {
            // WHO granted/decided the capability: the admin's User id for method
            // "admin"; the REVIEWER admin's id for a reviewed migration grant
            // (approved_legacy); null for an unreviewed migration hold (pending)
            // and for self-service (method "self").
            by: { type: Schema.Types.ObjectId, ref: "User" },
            at: { type: Date },
            method: { type: String, enum: ["admin", "migration", "self"] },
            batch: { type: String }, // migration batch tag (reversible grouping)
        },
        // True once the user made their one-time role choice (teacher/student)
        // at onboarding. After this the role is locked (only admins change it,
        // via upgradeUser) — stops a student self-promoting to teacher later.
        onboarded: {
            type: Boolean,
            default: false,
        },
        isVerified: {
            type: Boolean,
            default: true
        },
        // Last time this user made an authenticated request. Written by the
        // `protect` middleware at most once every 10 minutes (see
        // authMiddleware) so it costs ~nothing, and lets the admin user list
        // show who is actually active vs. a dormant account.
        lastActiveAt: {
            type: Date,
            index: true,
        },
        // Per-teacher storage allowance for uploaded materials, in bytes.
        // Unset means the platform default (UPLOAD_QUOTA_BYTES, 4GB); an admin
        // raises it for the accounts that genuinely need more.
        storageQuotaBytes: {
            type: Number,
        },
        // Setup walkthrough. Every step except the last is read from real data
        // (does a class exist, an exam, questions in it) so it cannot drift out
        // of sync with reality. Sharing the join link is the one step that
        // leaves no trace of its own, so it is recorded here when it happens.
        onboarding: {
            invitedAt: { type: Date },
        },
        userAgent: {
            type: Array,
            required: true,
            default: []
        },
        exams: [{
            type: Schema.Types.ObjectId,
            ref: "Exam"
        }],
        // CR-103: INTERNAL acquisition-migration ownership markers, keyed by exam.
        // When the canonicalize-exam-acquisition migration backfills a legacy
        // reverse-only grant into `exams`, it stamps a marker here in the SAME atomic
        // update, carrying the migration `batch` + a per-operation `nonce`. This binds
        // each journal row to the exact grant LINEAGE, so a rollback removes ONLY
        // grants the migration created — never a grant a user legitimately removed and
        // re-acquired (an ordinary acquire/assignment creates NO marker). Every
        // canonical-removal path (deleteMyExam, purgeExam) pulls the matching marker
        // atomically with the exam ref. `select:false` (+ no default) keeps it OUT of
        // every login/profile/admin DTO; the migration reads/writes it via the native
        // collection. Markers/journals are FINALIZED (removed) after the rollback
        // window via the migration's `--finalize --batch`.
        _acqMig: {
            type: [{
                exam: { type: Schema.Types.ObjectId, ref: "Exam" },
                batch: { type: String },
                nonce: { type: String },
                _id: false,
            }],
            select: false,
            default: undefined,
        },
        // ── Teacher Success Journey (ADR Backend/docs/adr/Teacher-Success-Journey.md) ──
        // Minimal, bounded fields only (D15 — no unbounded arrays on User).
        // A growth LEVEL is recognition, NEVER a security role: it must never be
        // read in any authorization/ownership/capability decision (D10). These
        // fields carry harmless schema defaults so a new teacher is Spark; the
        // Journey migration owns population of existing users (conservatively Spark).
        teacherLevel: {
            type: String,
            enum: ["spark", "momentum", "impact"],
            default: "spark",
        },
        levelSince: { type: Date, default: null },
        // How the current level was reached. `subscription` is reserved for a
        // future, separate commercial system and is never set by this feature.
        // Unset (undefined) until a promotion/migration assigns a source — null
        // is intentionally NOT an enum member, so the field is simply absent for
        // a brand-new Spark teacher.
        levelSource: {
            type: String,
            enum: ["activity", "referral", "admin", "subscription"],
        },
        // Advance-only optimistic-concurrency version. A promotion succeeds only
        // via CAS on this value, so concurrent/retried admin clicks promote once.
        levelVersion: { type: Number, default: 0 },
        // At most one referrer, bound ONCE at registration. Immutability is
        // enforced at the SERVICE layer (teacherReferralService.bind sets it with
        // a conditional atomic update only while it is null, and rejects any
        // switch) — NOT via schema `immutable`, which would also block that
        // legitimate one-time set. No retroactive switching, no circular claim.
        // A signup alone never qualifies a reward.
        referredBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        // This teacher's OWN random, non-sequential share code (/register?ref=<code>).
        // Uniqueness is enforced by a migration-owned partial unique index.
        referralCode: { type: String, default: null },
        // Marketing acquisition — WHERE this account came from, captured ONCE at
        // sign-up from the visitor tracker's first-touch data (utm_source / ?ref /
        // referring site). Powers the "came from an ad/campaign" badge in the admin
        // user list. Absent for accounts created before this existed / organic.
        acquisition: {
            source: { type: String },   // e.g. "instagram", "facebook", "google", "(direct)"
            medium: { type: String },   // utm_medium
            campaign: { type: String }, // utm_campaign
            referrer: { type: String },
            landing: { type: String },  // first page of the visit
            at: { type: Date },
        },
        // Teacher Journey (flag-gated): when the teacher first saw the full-page
        // Journey welcome. Stamped once via POST /teacher-success/welcome-seen so the
        // welcome shows once automatically yet stays reachable later. Absent = never.
        journeyWelcomeSeenAt: { type: Date, default: null },
        // Telegram notifications (teachers): when linked, the user gets a bot
        // message whenever a student starts one of their exams.
        // telegramChatId = the linked Telegram chat (set via the bot webhook).
        // telegramLinkCode = one-time deep-link token used to bind the account.
        telegramChatId: {
            type: String,
        },
        telegramLinkCode: {
            type: String,
        },
        telegramLinkedAt: {
            type: Date,
        },
        // Which Telegram notifications this teacher wants, and the scope.
        // Event flags default ON. Scope is OPT-OUT: everything notifies unless
        // its class or exam id is in an excluded list — so a newly created
        // class/exam is automatically included without any action.
        telegramPrefs: {
            onStart: { type: Boolean, default: true },     // student starts an exam
            onFinish: { type: Boolean, default: true },    // student finishes -> result
            onViolation: { type: Boolean, default: true }, // exam terminated for cheating
            onJoin: { type: Boolean, default: true },      // student joins/requests a class
            onReport: { type: Boolean, default: true },    // end-of-exam PDF+Excel report
            excludedClasses: [{ type: Schema.Types.ObjectId, ref: "Class" }],
            excludedExams: [{ type: Schema.Types.ObjectId, ref: "Exam" }],
        }
    },
    {
        timestamps: true,
        minimize: false,
        // AUD-008 CR-062: the unique {email:1} index is MIGRATION-OWNED. Disable
        // application auto-index/auto-create so merely requiring this model +
        // connecting never builds (or repairs) email_1 or creates the collection.
        // The canonical-email migration builds email_1 (+ the lastActiveAt perf
        // index it reconciles); production startup VERIFIES email_1 without creating
        // it. Tests build indexes explicitly via User.createIndexes().
        autoIndex: false,
        autoCreate: false,
    }
);

userSchema.index(
    { createdAt: -1, _id: -1 },
    { name: "page_createdAt_desc" }
);

// Encrypt password before saving to DB
userSchema.pre("save", async function (next) {
    if (!this.isModified("password")) {
        return next()
    }

    // Hash the password
    const salt = await bcrypt.genSalt(10)
    const hashedPassword = await bcrypt.hash(this.password, salt)

    this.password = hashedPassword;

    next();
})

const User = mongoose.model("User", userSchema)
module.exports = User
