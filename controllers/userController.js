const asyncHandler = require("express-async-handler");
const User = require("../models/userModel");
const { usedBytes, quotaFor } = require("../middleware/uploadLimit");
const Enrollment = require("../models/enrollmentModel");
const Class = require("../models/classModel");
const Exam = require("../models/examModel");
const Result = require("../models/resultModel");
const bcrypt = require("bcryptjs");
const { generateToken, hashToken, getToken, validatePassword, normalizeEmail } = require("../utils/index");
const { recordDebug } = require("../utils/debugLog");
// CR-001: loginStatus must make the SAME session decision as protect/attachUser
// (token-version revocation, suspended/deleted) — not just a bare signature check.
const { resolveSessionUser } = require("../middleware/authMiddleware");
// AUD-002: new session model, gated by SESSION_MODEL_ENABLED (default off).
const { flags } = require("../config/featureFlags");
const {
  issueLoginToken,
  sessionAwareLogout,
  clearAuthCookies,
  setRefreshCookie,
  legacyCookiePolicy,
  setTrustCookie,
  clearTrustCookie,
  TRUST_COOKIE,
} = require("./authSessionController");
const sessionService = require("../services/sessionService");
const { resolveAdminCapability, resolveApprovalAction, resolveSelfServiceCapability } = require("../services/teacherCapability");
const { isJourneyEnabled } = require("../config/teacherSuccess/flag");
const { capabilitiesFor } = require("../helper/teacherCapabilities");
const { usageFor } = require("../helper/planLimits");
const { normalizePlan, PLAN_IDS, planDef } = require("../config/plans");
const { stuckStateForOwners } = require("../helper/stuckTeachers");
const teacherReferralService = require("../services/teacherReferralService");
const { recordLoginResult } = require("../middleware/authLimit");
const authMetrics = require("../utils/authMetrics");
const parser = require("ua-parser-js");
const jwt = require("jsonwebtoken");
const { sendNotification } = require("../utils/sendEmail");
// CR-109: the ONE stable mail-failure classifier (shared with health + metrics). Mail
// catch paths persist only its allowlisted category + a fixed event name — never the
// raw error message, SMTP response, host, credentials, recipient, subject or body.
const { healthCategory: classifyMailFailure } = require("../utils/mailConfig");
const crypto = require("crypto");
const Token = require("../models/tokenModel");
const Cryptr = require("cryptr");
const { OAuth2Client } = require("google-auth-library");
const { hardDeleteUsers } = require("../services/entityLifecycle");
const { pageLimit, withCursor, pageResult, wantsEnvelope } = require("../utils/cursorPagination");
const VisitorSession = require("../models/visitorSessionModel");

// Sanitise the client-supplied first-touch acquisition into a bounded shape.
// Returns undefined when there is nothing meaningful to store (organic/direct).
function cleanAcquisition(a) {
  if (!a || typeof a !== "object") return undefined;
  const s = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
  const out = {
    source: s(a.source, 120),
    medium: s(a.medium, 120),
    campaign: s(a.campaign, 200),
    referrer: s(a.referrer, 400),
    landing: s(a.landing, 300),
  };
  const meaningful = out.source && out.source !== "(direct)";
  if (!meaningful && !out.campaign && !out.referrer) return undefined;
  out.at = new Date();
  return out;
}

const cryptr = new Cryptr(process.env.CRYPTR_KEY);

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "postmessage"
);

// Google verify seam (exchange auth code → verified id-token payload). The
// override is TEST-ONLY: it throws unless NODE_ENV === "test", so production code
// can never mutate the real verifier. Pass null to restore the default.
const defaultGoogleVerify = async (code) => {
  const { tokens } = await client.getToken(code);
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
  return ticket.getPayload();
};
let googleVerify = defaultGoogleVerify;
const __setGoogleVerifyForTest = (fn) => {
  if (process.env.NODE_ENV !== "test") throw new Error("googleVerify override is test-only");
  googleVerify = fn || defaultGoogleVerify;
};

// Register User
const registerUser = asyncHandler(async (req, res) => {
  try {
    const { name, password, phone, grade } = req.body;
    const email = normalizeEmail(req.body.email); // CR-050: canonical identity
    // Role is chosen at sign-up (teacher/student). Anything else falls back to
    // student, so a bad/absent value can never silently create a teacher.
    const role = req.body.role === "teacher" ? "teacher" : "student";
    // AUD-005 (CR-046): a public registrant NEVER receives teacher CAPABILITY.
    // Requesting the teacher role only records the request — the shared
    // self-service resolver creates the account `pending` (method "self"),
    // unprivileged until an admin approves it (upgradeUser). Any client-supplied
    // approval field in the body is ignored.
    const selfCap = resolveSelfServiceCapability({ role });
    const teacherApproval = selfCap.teacherApproval;

    // Validation — name/email/password/phone always required; grade (Sinif) only
    // for students (teachers don't have a grade).
    if (!name || !email || !password || !phone || (role === "student" && !grade)) {
      res.status(400);
      throw new Error(
        role === "student"
          ? "Zəhmət olmasa bütün xanaları doldurun (ad, email, şifrə, sinif, telefon)"
          : "Zəhmət olmasa bütün xanaları doldurun (ad, email, şifrə, telefon)"
      );
    }

    // AUD-008: shared password policy (min length + letter&digit).
    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) {
      res.status(400);
      throw new Error(pwCheck.message);
    }

    // Check if the user already exists
    const userExist = await User.findOne({ email });

    if (userExist) {
      res.status(400);
      throw new Error("Bu Email artıq mövcüddur!");
    }

    // Get user agent
    const ua = parser(req.headers["user-agent"]);
    const userAgent = ua.ua;

    // Create a new user. Auto-verified: email verification is intentionally
    // skipped (students aren't tech-savvy), so no one is gated by isVerified.
    const user = await User.create({
      name,
      email,
      password,
      phone,
      role,
      teacherApproval,
      teacherApprovalMeta: selfCap.teacherApprovalMeta || undefined,
      grade: role === "student" ? grade : undefined,
      // Welcome AI credits (free plan bonus) so a new teacher can try AI at once.
      aiCredits: role === "teacher" ? planDef("free").credits.welcome || 0 : 0,
      onboarded: true, // role + profile chosen at sign-up, so don't re-prompt
      userAgent,
      isVerified: true,
      signupIp: req.ip,
      lastIp: req.ip,
      // Where this account came from (first-touch), for the admin "from an ad"
      // badge. Client-supplied but harmless: it only labels a marketing source.
      acquisition: cleanAcquisition(req.body.acquisition),
    });

    // AUD-002 (CR-011): unified issuance — legacy off, session/rollback on.
    const token = await issueLoginToken(req, res, user);
    // Trust this device for one-tap re-login later (opt-in; default on).
    if (req.body?.rememberDevice !== false) await issueTrustDevice(req, res, user);

    // CR-125: bind a referral if a valid code came through the register flow
    // (?ref=<code>). Teacher referees only. NEVER fail registration on a referral
    // problem — a deferred row is repaired by reconcilePendingBindings().
    if (isJourneyEnabled()) {
      const ref = (req.body.ref || "").toString().trim();
      if (ref && role === "teacher") {
        try { await teacherReferralService.bind({ refereeId: user._id, code: ref }); }
        catch (e) { console.warn("referral bind failed:", e && e.message); }
      }
    }

    if (user) {
      const {
        _id,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        teacherApproval,
        isVerified,
        userAgent,
        grade,
        createdAt,
      } = user;
      res.status(201).json({
        _id,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        teacherApproval, // AUD-005: a requested teacher is created "pending" (no capability)
        // Teacher Success Journey — same trusted signals as login/getUser so a
        // freshly-registered teacher's header/capabilities render immediately.
        teacherSuccessJourneyEnabled: isJourneyEnabled(),
        ...(isJourneyEnabled() && role === "teacher" ? { teacherLevel: user.teacherLevel || "spark", journeyWelcomeSeen: !!user.journeyWelcomeSeenAt } : {}),
        capabilities: [...capabilitiesFor(user, { journeyEnabled: isJourneyEnabled() })],
        isVerified,
        userAgent,
        grade,
        createdAt,
        token,
      });
    } else {
      res.status(400);
      throw new Error("Invalid user data");
    }
  } catch (error) {
    console.log("register catch: ", error);
    res
      .status(res.statusCode && res.statusCode >= 400 ? res.statusCode : 400)
      .json({ message: error.message });
  }
});

// Login User
// ── "Trust this device" one-tap re-login ─────────────────────────────────────
// Issue a fresh trusted-device token: store its HASH on the user (capped +
// expiry-pruned) and put the raw value in the httpOnly, path-scoped trust cookie.
// `drop` removes a prior hash (used to ROTATE on each device-login). Best-effort:
// a failure here never blocks the login it rides on.
const TRUST_TTL_MS = Number(process.env.TRUST_DEVICE_TTL_MS) || 60 * 24 * 60 * 60 * 1000; // 60d
async function issueTrustDevice(req, res, user, { drop } = {}) {
  try {
    const now = Date.now();
    const raw = crypto.randomBytes(32).toString("hex");
    const dev = {
      tokenHash: hashToken(raw),
      createdAt: new Date(now),
      lastUsedAt: new Date(now),
      expiresAt: new Date(now + TRUST_TTL_MS),
      ua: String(req.headers["user-agent"] || "").slice(0, 200),
    };
    const existing = (await User.findById(user._id).select("trustedDevices").lean())?.trustedDevices || [];
    const base = existing.filter(
      (d) => d && new Date(d.expiresAt).getTime() > now && d.tokenHash !== drop
    );
    const next = [...base, dev].slice(-10); // keep at most 10 trusted devices
    await User.updateOne({ _id: user._id }, { $set: { trustedDevices: next } });
    setTrustCookie(res, raw, dev.expiresAt);
  } catch (e) {
    console.warn("issueTrustDevice failed:", e?.message);
  }
}

// The login-response DTO, shared by password login and device login so both hand
// the client an identical, fully-hydrated identity (mirrors loginUser's body).
async function buildAuthDTO(user, token) {
  const loginUsage = user.role === "teacher" ? await usageFor(user) : null;
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    bio: user.bio,
    photo: user.photo,
    role: user.role,
    teacherApproval: user.teacherApproval,
    isVerified: user.isVerified,
    userAgent: user.userAgent,
    createdAt: user.createdAt,
    token,
    plan: normalizePlan(user.plan),
    planExpiresAt: user.planExpiresAt || null,
    aiCredits: user.aiCredits || 0,
    ...(loginUsage ? { usage: loginUsage } : {}),
    teacherSuccessJourneyEnabled: isJourneyEnabled(),
    ...(isJourneyEnabled() && user.role === "teacher"
      ? { teacherLevel: user.teacherLevel || "spark", journeyWelcomeSeen: !!user.journeyWelcomeSeenAt }
      : {}),
    capabilities: [...capabilitiesFor(user, { journeyEnabled: isJourneyEnabled() })],
  };
}

// POST /api/users/device/login — exchange a valid trust cookie for a session, no
// password. Rotates the device token on success; clears it on any failure.
const deviceLogin = asyncHandler(async (req, res) => {
  const raw = req.cookies ? req.cookies[TRUST_COOKIE] : undefined;
  if (!raw) return res.status(401).json({ message: "Bu cihaz xatırlanmayıb" });

  const tokenHash = hashToken(raw);
  const now = Date.now();
  const user = await User.findOne({ "trustedDevices.tokenHash": tokenHash }).select("+trustedDevices");
  const dev =
    user && Array.isArray(user.trustedDevices)
      ? user.trustedDevices.find((d) => d.tokenHash === tokenHash && new Date(d.expiresAt).getTime() > now)
      : null;
  if (!user || !dev) {
    clearTrustCookie(res);
    return res.status(401).json({ message: "Sessiya bitib, şifrə ilə daxil olun" });
  }

  recordDebug({ kind: "login_ok", message: "device", email: user.email, ua: req.headers["user-agent"], ip: req.ip });
  const token = await issueLoginToken(req, res, user);
  await issueTrustDevice(req, res, user, { drop: tokenHash }); // rotate this device's token
  return res.status(200).json(await buildAuthDTO(user, token));
});

// POST /api/users/device/forget — the chooser's "×": drop this device's trust
// token everywhere and clear the cookie. Safe when no cookie/entry exists.
const forgetDevice = asyncHandler(async (req, res) => {
  const raw = req.cookies ? req.cookies[TRUST_COOKIE] : undefined;
  if (raw) {
    const tokenHash = hashToken(raw);
    await User.updateOne(
      { "trustedDevices.tokenHash": tokenHash },
      { $pull: { trustedDevices: { tokenHash } } }
    ).catch(() => {});
  }
  clearTrustCookie(res);
  return res.status(200).json({ ok: true });
});

const loginUser = asyncHandler(async (req, res) => {
  try {
    const { password } = req.body;
    const email = normalizeEmail(req.body.email); // CR-050: canonical identity

    //Validation
    if (!email || !password) {
      res.status(400);
      throw new Error("Email və Şifrə Əlavə edin");
    }

    // AUD-001: password is select:false by default; load it explicitly here so
    // the hash can be compared, and NOWHERE else.
    const user = await User.findOne({ email }).select("+password");

    // AUD-008: do NOT enumerate accounts. An unknown email and a wrong password
    // return the SAME status + message. When the email is unknown we still run a
    // bcrypt compare against a dummy hash so the response TIME doesn't reveal
    // whether the account exists (constant-work path).
    const DUMMY_HASH = "$2a$10$0000000000000000000000000000000000000000000000000000u";
    const isPasswordCorrect = await bcrypt.compare(password, (user && user.password) || DUMMY_HASH);
    if (!user || !isPasswordCorrect) {
      // CR-051: record the FAILED login against the per-account bucket.
      recordLoginResult(email, false);
      res.status(400);
      throw new Error("Email və ya şifrə yanlışdır");
    }
    recordLoginResult(email, true); // success clears the account's failure bucket

    // AUD-007: do NOT log the user document — it carries the password hash and
    // personal fields into long-lived, broadly-accessible log storage.

    // Trigger 2FA for unknown user agent
    // const ua = parser(req.headers["user-agent"])
    // const thisUserAgent = ua.ua;

    // const allowedAgent = user.userAgent.includes(thisUserAgent)

    // if (!allowedAgent) {
    //     // Generate 6 digit code
    //     const loginCode = Math.floor(100000 + Math.random() * 900000)
    //     console.log(loginCode)
    //     //Encrypt login code
    //     const encryptedLoginCode = cryptr.encrypt(loginCode.toString())

    //     // Delete the token if exists
    //     let userToken = await Token.findOne({ userId: user._id })
    //     if (userToken) {
    //         await userToken.deleteOne()
    //     }

    //     //Save token to DB
    //     await new Token({
    //         userId: user._id,
    //         lToken: encryptedLoginCode,
    //         createdAt: Date.now(),
    //         expiresAt: Date.now() + 60 * (60 * 1000) // 1hour
    //     }).save()

    //     res.status(400)
    //     throw new Error("New browser or device detected")
    // }

    let token;
    if (user && isPasswordCorrect) {
      // Diagnostic: which device logged in (to correlate with later failures).
      recordDebug({
        kind: "login_ok",
        message: "password",
        email: user.email,
        ua: req.headers["user-agent"],
        ip: req.ip,
      });
      // AUD-002 (CR-011): one issuance path — legacy when flag off, session or
      // bounded rollback cookie when on (never a legacy no-exp token when on).
      token = await issueLoginToken(req, res, user);
      // "Trust this device" for one-tap re-login later (opt-in; default on). The
      // client sends rememberDevice:false to skip it (e.g. a shared computer).
      if (req.body?.rememberDevice !== false) await issueTrustDevice(req, res, user);
      const {
        _id,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        teacherApproval,
        isVerified,
        userAgent,
        createdAt,
      } = user;

      // Plan + usage on the login DTO so the header plan badge renders immediately
      // (the boot getUser only runs from a cold start, not right after login).
      const loginUsage = role === "teacher" ? await usageFor(user) : null;

      res.status(200).json({
        _id,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        teacherApproval, // AUD-005 (CR-046): every identity DTO carries capability state
        isVerified,
        userAgent,
        createdAt,
        token,
        plan: normalizePlan(user.plan),
        planExpiresAt: user.planExpiresAt || null,
        aiCredits: user.aiCredits || 0,
        ...(loginUsage ? { usage: loginUsage } : {}),
        // Teacher Success Journey — the login DTO carries the same trusted signals
        // as getUser so the header/card render immediately (no getUser round-trip).
        teacherSuccessJourneyEnabled: isJourneyEnabled(),
        ...(isJourneyEnabled() && role === "teacher" ? { teacherLevel: user.teacherLevel || "spark", journeyWelcomeSeen: !!user.journeyWelcomeSeenAt } : {}),
        capabilities: [...capabilitiesFor(user, { journeyEnabled: isJourneyEnabled() })],
      });
    } else {
      res.status(500);
      throw new Error("Something went wrong, please try again");
    }
  } catch (error) {
    console.log("login catch: ", error);
    res
      .status(res.statusCode && res.statusCode >= 400 ? res.statusCode : 400)
      .json({ message: error.message });
  }
});

// Send Login Code to Email. AUD-008: NON-ENUMERATING — the response is identical
// (200 + generic message) whether or not the email is registered or a live code
// exists, and a send failure is logged but still returns the generic 200.
const GENERIC_CODE_MSG = "Əgər hesab mövcuddursa, giriş kodu göndərildi";
const sendLoginCode = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.params.email); // CR-050: canonical identity

  const user = email ? await User.findOne({ email }) : null;
  const userToken = user
    ? await Token.findOne({ userId: user._id, expiresAt: { $gt: Date.now() }, lToken: { $gt: "" } })
    : null;

  if (user && userToken) {
    try {
      await sendNotification({
        kind: "loginCode",
        to: email,
        subject: "Examopia — Giriş kodu",
        name: user.name,
        code: cryptr.decrypt(userToken.lToken),
      });
    } catch (error) {
      recordDebug({ kind: "login_code_send_failed", category: classifyMailFailure(error) });
      authMetrics.emailSendFailed();
    }
  }
  return res.status(200).json({ message: GENERIC_CODE_MSG });
});

// Login With Code
const loginWithCode = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.params.email); // CR-050: canonical identity
  const { loginCode } = req.body;

  if (!loginCode) {
    res.status(400);
    throw new Error("Please enter login code");
  }

  // AUD-008: NON-ENUMERATING — unknown email, no live code, and a wrong code all
  // return the SAME 400. (cryptr.decrypt is only reached when a token exists.)
  const user = await User.findOne({ email });
  const userToken = user
    ? await Token.findOne({ userId: user._id, expiresAt: { $gt: Date.now() }, lToken: { $gt: "" } })
    : null;
  const decryptedLoginCode = userToken ? cryptr.decrypt(userToken.lToken) : null;

  if (!user || !userToken || String(loginCode) !== String(decryptedLoginCode)) {
    recordLoginResult(email, false); // CR-051: failed code login counts per account
    res.status(400);
    throw new Error("Giriş kodu yanlışdır və ya vaxtı bitib");
  }
  {
    recordLoginResult(email, true); // success clears the account failure bucket
    // Register user agent
    const ua = parser(req.headers["user-agent"]);
    const thisUserAgent = ua.ua;

    if (user.userAgent.includes(thisUserAgent)) {
      res.status(400);
      throw new Error("This browser or device has already registered");
    }

    user.userAgent.push(thisUserAgent);
    await user.save();

    // Generate token
    // AUD-002 (CR-011): unified issuance (loginWithCode) — preserve the historical
    // 1-day flag-off cookie expiry.
    const token = await issueLoginToken(req, res, user, { expires: new Date(Date.now() + 1000 * 86400) });

    const { _id, name, phone, bio, photo, role, teacherApproval, isVerified, userAgent } =
      user;
    const codeUsage = role === "teacher" ? await usageFor(user) : null;
    res.status(200).json({
      _id,
      name,
      email, // the canonical (outer) email; avoids shadowing it inside this block
      phone,
      bio,
      photo,
      role,
      teacherApproval, // AUD-005 (CR-046): code-login DTO carries capability state
      isVerified,
      userAgent,
      token,
      plan: normalizePlan(user.plan),
      planExpiresAt: user.planExpiresAt || null,
      aiCredits: user.aiCredits || 0,
      ...(codeUsage ? { usage: codeUsage } : {}),
    });
  }
});

// Send Verification Email
const sendVerificationEmail = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }
  if (user.isVerified) {
    res.status(400);
    throw new Error("User already verified");
  }
  let token = await Token.findOne({ userId: user._id });
  if (token) {
    await token.deleteOne();
  }
  // Create Verification Token and Save
  const verificationToken = crypto.randomBytes(32).toString("hex") + user._id;
  //Hash token and save
  const hashedToken = hashToken(verificationToken);
  await new Token({
    userId: user._id,
    vToken: hashedToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * (60 * 1000), // 1hour
  }).save();
  //Construct Verification URL
  const verificationUrl = `/verify/${verificationToken}`;
  try {
    await sendNotification({
      kind: "verify",
      to: user.email,
      subject: "Examopia — Hesabı təsdiqlə",
      name: user.name,
      link: verificationUrl,
    });
    res.status(200).json({ message: "Verification Email Sent" });
  } catch (error) {
    res.status(500);
    throw new Error("Verification Email not sent, please try again");
  }
});

// Verify User
const verifyUser = asyncHandler(async (req, res) => {
  const { verificationToken } = req.params;
  const hashedToken = hashToken(verificationToken);
  const userToken = await Token.findOne({
    vToken: hashedToken,
    expiresAt: { $gt: Date.now() },
  });
  if (!userToken) {
    res.status(404);
    throw new Error("Invalid or Expired Token!");
  }
  // Find user
  const user = await User.findOne({ _id: userToken.userId });
  if (user.isVerified) {
    res.status(400);
    throw new Error("User is already verified");
  }
  // Now verify the user
  user.isVerified = true;
  await user.save();
  res.status(200).json({
    message: "Account verification successful",
  });
});

// Logout User
const logoutUser = asyncHandler(async (req, res) => {
  if (flags.SESSION_MODEL_ENABLED) {
    // AUD-002 (CR-011): revoke the current Session (sid from the access token)
    // and clear BOTH credential cookies, not just the legacy one.
    await sessionAwareLogout(req, res);
  } else {
    // Legacy behavior — byte-identical when the flag is off.
    res.cookie("token", "", {
      path: "/",
      httpOnly: true,
      expires: new Date(0), // expire immediately
      ...legacyCookiePolicy(),
    });
  }

  return res.status(200).json({
    message: "Çıxış uğurludur",
  });
});

// Get User
const getUser = asyncHandler(async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (user) {
      const {
        _id,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        teacherApproval,
        exams,
        isVerified,
        userAgent,
        whatsappOptIn,
        whatsappGroupJoined,
        grade,
        hideAssistant,
        assistantEnabled,
        teacherLevel,
        plan,
        planExpiresAt,
        createdAt,
      } = user;

      // Teacher Success Journey — the frontend learns the enabled state from THIS
      // trusted backend identity response (not a Vite flag). When off, no Journey
      // fields are surfaced and the client renders exactly as before. When on, we
      // expose the (recognition-only) level; live credit/allowance comes from the
      // dedicated Journey endpoint. NEVER a capability/authorization signal.
      const journeyEnabled = isJourneyEnabled();

      // Paid plan + live usage vs limits (teachers only — students have no plan).
      const planUsage = role === "teacher" ? await usageFor(user) : null;

      res.status(200).json({
        _id,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        // AUD-005 (CR-042): surface the granted capability state so the client can
        // show a pending teacher an "awaiting approval" screen instead of a staff
        // UI whose privileged API calls would all 403.
        teacherApproval,
        exams,
        isVerified,
        userAgent,
        whatsappOptIn,
        whatsappGroupJoined,
        grade,
        // Account age — the onboarding gate uses this to grandfather users who
        // signed up BEFORE the gate shipped (they keep working as-is); only new
        // signups are forced to complete phone (+ grade for students).
        createdAt,
        hideAssistant,
        assistantEnabled,
        teacherSuccessJourneyEnabled: journeyEnabled,
        ...(journeyEnabled && role === "teacher" ? { teacherLevel: teacherLevel || "spark", journeyWelcomeSeen: !!user.journeyWelcomeSeenAt } : {}),
        // CR-124: the SERVER-derived capability set the frontend route tree gates
        // on (never derived from teacherLevel). Reflects role + approval + flag —
        // a new Spark teacher gets safe own-scope; risky/admin stay gated.
        capabilities: [...capabilitiesFor(user, { journeyEnabled })],
        // Paid packages (Pulsuz/Pro/Premium). Missing plan resolves to "free".
        plan: normalizePlan(plan),
        planExpiresAt: planExpiresAt || null,
        aiCredits: user.aiCredits || 0,
        ...(planUsage ? { usage: planUsage } : {}),
      });
    } else {
      res.status(404);
      throw new Error("User not found!");
    }
  } catch (error) {
    console.log("getUsercatch: ", error);
    res
      .status(res.statusCode && res.statusCode >= 400 ? res.statusCode : 500)
      .json({ message: error.message });
  }
});

// Get User By Id
const getUserById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Teachers may only view their OWN students — someone approved-enrolled in a
  // class they own. Admin can view anyone. Stops one teacher from opening
  // another teacher's student (and their results) by guessing the id.
  if (req.user.role !== "admin") {
    const classIds = await ownedClassIds(req.user._id);
    const mine = await Enrollment.exists({
      class: { $in: classIds },
      student: id,
      status: "approved",
    });
    if (!mine) {
      res.status(403);
      throw new Error("Bu istifadəçiyə giriş yoxdur");
    }
  }

  // Never leak the student's password hash, nor the access `password`/`pdf`
  // location of the exams they hold (those exams may belong to other teachers).
  const user = await User.findById(id)
    .select("-password")
    .populate({ path: "exams", select: "-password -pdf" })
    .exec();

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  // Results live in their own collection keyed by userId — there is no `results`
  // path on the User schema, so populating it threw a StrictPopulateError (500).
  // Fetch them directly and attach the fields the profile renders.
  const results = await Result.find({ userId: id })
    .select("earnPoints attemptOrdinal createdAt examId")
    .populate({ path: "examId", select: "name" })
    .sort({ createdAt: 1 })
    .lean();

  res.status(200).json({ ...user.toObject(), results });
});

// Update User
const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (user) {
    const { name, email, phone, bio, photo } = user;

    user.email = email;
    user.name = req.body.name || name;
    user.phone = req.body.phone || phone;
    user.name = req.body.name || name;
    user.bio = req.body.bio || bio;
    user.photo = req.body.photo || photo;
    // WhatsApp notification opt-in (boolean). Only change it when the client
    // actually sends the field, so other profile edits don't reset it.
    if (typeof req.body.whatsappOptIn === "boolean") {
      user.whatsappOptIn = req.body.whatsappOptIn;
    }
    // Hide/show the floating AI assistant (staff preference).
    if (typeof req.body.hideAssistant === "boolean") {
      user.hideAssistant = req.body.hideAssistant;
    }
    // Opt in/out of the AI assistant (staff preference; off by default).
    if (typeof req.body.assistantEnabled === "boolean") {
      user.assistantEnabled = req.body.assistantEnabled;
    }
    // Grade ("Sinif") — only when the client sends a non-empty value.
    if (typeof req.body.grade === "string" && req.body.grade.trim()) {
      user.grade = req.body.grade.trim();
    }
    // One-time role choice at onboarding: a user may set their OWN role to
    // teacher or student exactly once. After that it's locked (admins use the
    // upgradeUser endpoint) — prevents a student self-promoting to teacher later.
    if (!user.onboarded && (req.body.role === "teacher" || req.body.role === "student")) {
      // AUD-005 (CR-046): route the self-service role choice through the SHARED
      // transition helper so role + capability + provenance are set atomically
      // (choosing teacher records `pending` with method "self"; any stale
      // admin/migration provenance is cleared). A self-service choice can never
      // grant teacher capability.
      const next = resolveSelfServiceCapability({ role: req.body.role });
      user.role = next.role;
      user.onboarded = true;
      user.teacherApproval = next.teacherApproval;
      user.teacherApprovalMeta = next.teacherApprovalMeta || undefined;
    }

    const updatedUser = await user.save();

    res.status(200).json({
      _id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      phone: updatedUser.phone,
      bio: updatedUser.bio,
      photo: updatedUser.photo,
      role: updatedUser.role,
      teacherApproval: updatedUser.teacherApproval, // AUD-005 (CR-046): reflect capability after onboarding
      isVerified: updatedUser.isVerified,
      whatsappOptIn: updatedUser.whatsappOptIn,
      grade: updatedUser.grade,
      hideAssistant: updatedUser.hideAssistant,
      assistantEnabled: updatedUser.assistantEnabled,
    });
  } else {
    res.status(404);
    throw new Error("User not found!");
  }
});

// Delete User
const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  // Never let an admin permanently delete their own account.
  if (String(user._id) === String(req.user._id)) {
    res.status(400);
    throw new Error("Öz hesabınızı silə bilməzsiniz");
  }

  // HARD delete (physical removal) + clean cascade of the account's data.
  await hardDeleteUsers([user._id]);

  res.status(200).json({
    message: "User removed successfully",
  });
});

// PATCH /api/users/:id/phone — ADMIN sets any user's phone number. Focused on
// phone only so this endpoint can never silently change roles, capabilities or
// identity. Basic format check (>= 7 digits) mirrors the sign-up rule.
const setUserPhone = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }
  const phone = typeof req.body.phone === "string" ? req.body.phone.trim() : "";
  if (!phone || phone.replace(/\D/g, "").length < 7) {
    res.status(400);
    throw new Error("Telefon nömrəsi düzgün deyil");
  }
  user.phone = phone.slice(0, 40);
  await user.save();
  res.status(200).json({ _id: user._id, phone: user.phone, message: "Telefon nömrəsi yeniləndi" });
});

// POST /api/users/impersonate/:id — ADMIN "log in as" a user. Issues a REAL
// session/token for the TARGET (so the admin's browser acts as that user) and
// returns the same identity DTO login does. The client then hard-reloads and
// re-bootstraps as the target from the freshly-set session cookie. Audited;
// cannot target a deleted account or the admin's own account.
const impersonateUser = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target || target.deletedAt) {
    res.status(404);
    throw new Error("User not found!");
  }
  if (String(target._id) === String(req.user._id)) {
    res.status(400);
    throw new Error("Öz hesabınıza daxil ola bilməzsiniz");
  }
  // Audit trail (stderr survives redeploy + is captured in the deploy logs).
  console.error(`[IMPERSONATE] admin ${req.user._id} logged in as user ${target._id} (${target.role})`);

  const token = await issueLoginToken(req, res, target);
  const { _id, name, email, phone, bio, photo, role, teacherApproval, isVerified, userAgent } = target;
  const journeyEnabled = isJourneyEnabled();
  res.status(200).json({
    _id, name, email, phone, bio, photo, role, teacherApproval, isVerified, userAgent, token,
    teacherSuccessJourneyEnabled: journeyEnabled,
    ...(journeyEnabled && role === "teacher"
      ? { teacherLevel: target.teacherLevel || "spark", journeyWelcomeSeen: !!target.journeyWelcomeSeenAt }
      : {}),
    capabilities: [...capabilitiesFor(target, { journeyEnabled })],
    impersonated: true,
  });
});

// Class ids the teacher owns (for scoping their students).
async function ownedClassIds(userId) {
  return Class.find({ owner: userId }).distinct("_id");
}

// Get Users — admins see everyone; teachers see only THEIR OWN students
// (students approved-enrolled in a class they own).
const getUsers = asyncHandler(async (req, res) => {
  let filter = {};
  if (req.user.role !== "admin") {
    const classIds = await ownedClassIds(req.user._id);
    const studentIds = await Enrollment.find({
      class: { $in: classIds },
      status: "approved",
    }).distinct("student");
    filter = { _id: { $in: studentIds } };
  }
  const query = req.query || {};
  const limit = pageLimit(query.limit);
  const usersPlus = await User.find(withCursor(filter, query.cursor))
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .select("-password")
    .lean();
  const page = pageResult(usersPlus, limit);
  const users = page.items;

  // Push-notification opt-in: expose a boolean + first-opt-in date for the admin
  // directory, and NEVER leak the raw subscription keys to the client.
  users.forEach((u) => {
    u.pushEnabled = Array.isArray(u.push) && u.push.length > 0;
    if (u.pushEnabled) u.pushAt = u.pushSubscribedAt || u.push[u.push.length - 1]?.at || null;
    delete u.push;
    // Paid plan for the admin directory (missing → "free" for grandfathered rows).
    u.plan = normalizePlan(u.plan);
  });

  // "Started but stuck": teachers who created an EXAM and left it empty (no
  // questions AND no PDF), OR created a CLASS with no exams inside. Lets the
  // admin reach out and help them finish setting up.
  const teacherIds = users.filter((u) => u.role === "teacher").map((u) => u._id);
  if (teacherIds.length) {
    const stuckMap = await stuckStateForOwners(teacherIds);
    users.forEach((u) => {
      if (u.role !== "teacher") return;
      const st = stuckMap.get(String(u._id));
      if (!st) return;
      u.emptyExams = st.emptyExams;
      u.hasEmptyExam = st.hasEmptyExam;
      u.emptyClasses = st.emptyClasses;
      u.hasEmptyClass = st.hasEmptyClass;
      u.hasNoSetup = st.hasNoSetup; // signed up, created nothing
    });
  }

  // For the admin directory, attach each student's teacher(s) so the list can
  // answer "whose student is this?" without a request per row. A student can
  // belong to several teachers (one per class they joined), so this is a list.
  // Three queries total, regardless of how many users there are.
  if (req.user.role === "admin" && users.length) {
    const enrollments = await Enrollment.find({
      status: "approved",
      student: { $in: users.map((user) => user._id) },
    })
      .select("student teacher class")
      .lean();

    // `teacher` is denormalised on newer enrollments; fall back to the class
    // owner for older rows that predate it.
    const classIds = [...new Set(enrollments.map((e) => String(e.class)))];
    const classes = classIds.length
      ? await Class.find({ _id: { $in: classIds } }).select("owner").lean()
      : [];
    const ownerOfClass = new Map(classes.map((c) => [String(c._id), String(c.owner)]));

    const byStudent = new Map();
    const teacherIds = new Set();
    enrollments.forEach((e) => {
      const tid = String(e.teacher || ownerOfClass.get(String(e.class)) || "");
      if (!tid || tid === "undefined") return;
      teacherIds.add(tid);
      const key = String(e.student);
      if (!byStudent.has(key)) byStudent.set(key, new Set());
      byStudent.get(key).add(tid);
    });

    const teachers = teacherIds.size
      ? await User.find({ _id: { $in: [...teacherIds] } }).select("name").lean()
      : [];
    const nameOf = new Map(teachers.map((t) => [String(t._id), t.name]));

    users.forEach((u) => {
      const ids = byStudent.get(String(u._id));
      u.teachers = ids
        ? [...ids].map((id) => ({ _id: id, name: nameOf.get(id) || "—" }))
        : [];
    });
  }

  // "Came from" — link each account to its earliest tagged visitor session with
  // a real source, so the directory shows where a user arrived from even if they
  // signed up before acquisition was captured at register (as long as they've
  // since browsed while logged in, which stamps their id on the session).
  if (users.length) {
    const ids = users.map((u) => u._id);
    const sessions = await VisitorSession.find({
      userId: { $in: ids },
      affiliate: { $exists: true, $nin: [null, "", "(direct)"] },
    })
      .sort({ firstSeen: 1 })
      .select("userId affiliate campaign")
      .lean();
    const srcOf = new Map();
    for (const s of sessions) {
      const key = String(s.userId);
      if (!srcOf.has(key)) srcOf.set(key, { source: s.affiliate, campaign: s.campaign || "" });
    }
    users.forEach((u) => {
      if (!u.acquisition?.source && srcOf.has(String(u._id))) {
        u.acquisitionMatched = srcOf.get(String(u._id));
      }
    });
  }

  res.status(200).json(wantsEnvelope(req) ? page : users);
});

// PATCH /api/users/bulk — admin-only batch role change or delete, so a class of
// newly-registered students doesn't have to be handled one row at a time.
const bulkUsers = asyncHandler(async (req, res) => {
  const { ids, action, role } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: "İstifadəçi seçilməyib" });
  }
  // Never let an admin wipe out their own account in a bulk sweep.
  const targets = ids.filter((id) => String(id) !== String(req.user._id));
  if (!targets.length) {
    return res.status(400).json({ message: "Öz hesabınızı dəyişə bilməzsiniz" });
  }

  if (action === "delete") {
    const { deleted } = await hardDeleteUsers(targets);
    return res.json({ action, count: deleted, ids: targets });
  }

  if (action === "role") {
    const allowed = ["student", "teacher", "admin", "suspended"];
    if (!allowed.includes(role)) {
      return res.status(400).json({ message: "Yanlış rol" });
    }
    // CR-042: resolve role + capability through the shared service so a bulk
    // promotion to teacher also GRANTS the capability (never leaves a latent
    // teacherApproval:"none" teacher), and a demotion clears it. One timestamp
    // for the whole batch. `teacherApprovalMeta:null` is written as an explicit
    // $unset so a demoted account carries no stale provenance.
    const next = resolveAdminCapability({ role, actorId: req.user._id, now: new Date() });
    const set = { role: next.role, teacherApproval: next.teacherApproval };
    const update = next.teacherApprovalMeta
      ? { $set: { ...set, teacherApprovalMeta: next.teacherApprovalMeta } }
      : { $set: set, $unset: { teacherApprovalMeta: "" } };
    const { modifiedCount } = await User.updateMany({ _id: { $in: targets } }, update);
    return res.json({ action, role, count: modifiedCount, ids: targets });
  }

  // CR-042: explicit approve / revoke of the teacher CAPABILITY, applied ONLY to
  // targets that are teachers (role unchanged). approve → capable + provenance;
  // revoke → held at "pending" (non-capable), provenance cleared.
  if (action === "approve" || action === "revoke") {
    const { teacherApproval, teacherApprovalMeta } = resolveApprovalAction({
      approve: action === "approve", actorId: req.user._id, now: new Date(),
    });
    const set = { teacherApproval };
    const update = teacherApprovalMeta
      ? { $set: { ...set, teacherApprovalMeta } }
      : { $set: set, $unset: { teacherApprovalMeta: "" } };
    const { modifiedCount } = await User.updateMany(
      { _id: { $in: targets }, role: "teacher" },
      update
    );
    return res.json({ action, count: modifiedCount, ids: targets });
  }

  res.status(400).json({ message: "Yanlış əməliyyat" });
});

// GET /api/users/teacher/:id/overview — everything an admin needs about ONE
// teacher in a single call: the classes they own, the students in them
// (approved + still pending), and the exams they created.
const teacherOverviewExamDto = ({ deletedAt, ...exam }) => ({
  _id: exam._id,
  name: exam.name,
  class: exam.class || null,
  createdAt: exam.createdAt,
  duration: exam.duration || 0,
  archived: Boolean(deletedAt),
});

const teacherOverview = asyncHandler(async (req, res) => {
  const teacher = await User.findById(req.params.id).select("-password").lean();
  if (!teacher) return res.status(404).json({ message: "Tapılmadı" });

  const classes = await Class.find({ owner: teacher._id })
    .sort("-createdAt")
    .select("name level joinCode createdAt")
    .lean();
  const classIds = classes.map((c) => c._id);

  const enrollments = classIds.length
    ? await Enrollment.find({ class: { $in: classIds } })
        .select("student class status createdAt")
        .lean()
    : [];

  const studentIds = [...new Set(enrollments.map((e) => String(e.student)))];
  const students = studentIds.length
    ? await User.find({ _id: { $in: studentIds } })
        .select("name email phone role lastActiveAt")
        .lean()
    : [];
  const studentById = new Map(students.map((s) => [String(s._id), s]));
  const classById = new Map(classes.map((c) => [String(c._id), c]));

  // Per-class head counts for the class cards.
  const counts = new Map(classIds.map((id) => [String(id), { approved: 0, pending: 0 }]));
  enrollments.forEach((e) => {
    const c = counts.get(String(e.class));
    if (c && (e.status === "approved" || e.status === "pending")) c[e.status] += 1;
  });

  const exams = await Exam.find({ owner: teacher._id })
    .sort("-createdAt")
    .select("name class createdAt deletedAt duration")
    .populate("class", "name level")
    .lean();
  const examDtos = exams.map(teacherOverviewExamDto);

  res.json({
    teacher,
    classes: classes.map((c) => ({
      ...c,
      approved: counts.get(String(c._id))?.approved || 0,
      pending: counts.get(String(c._id))?.pending || 0,
    })),
    students: enrollments.map((e) => ({
      ...(studentById.get(String(e.student)) || { _id: e.student, name: "—" }),
      status: e.status,
      className:
        classById.get(String(e.class))?.name ||
        (classById.get(String(e.class))?.level
          ? `${classById.get(String(e.class)).level}-ci sinif`
          : "—"),
      joinedAt: e.createdAt,
    })),
    exams: examDtos,
    stats: {
      classes: classes.length,
      students: studentIds.length,
      pending: enrollments.filter((e) => e.status === "pending").length,
      exams: examDtos.length,
    },
  });
});

// Login Status
const loginStatus = asyncHandler(async (req, res) => {
  // CR-001: true only for a VALID CURRENT session — a token revoked by password
  // reset (sv mismatch), a suspended/deleted user, or a malformed token all
  // report false, matching what protect/attachUser now enforce.
  const { user } = await resolveSessionUser(getToken(req));
  return res.json(!!user);
});

// Update User Role — the ADMIN approval mechanism (adminOnly route). AUD-005 /
// CR-042: this is ONE of two admin entry points; both resolve the role+capability
// through the SHARED teacherCapability service so approval state can never drift
// from role. `approved_legacy` is migration-owned and can never be produced here.
const ROLE_VALUES = new Set(["student", "teacher", "admin", "suspended"]);
const upgradeUser = asyncHandler(async (req, res) => {
  const { role, id, teacherApproval } = req.body;

  if (!ROLE_VALUES.has(role)) {
    res.status(400);
    throw new Error("Invalid role");
  }

  const user = await User.findById(id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const next = resolveAdminCapability({ role, desiredApproval: teacherApproval, actorId: req.user._id });
  user.role = next.role;
  user.teacherApproval = next.teacherApproval;
  user.teacherApprovalMeta = next.teacherApprovalMeta || undefined;
  await user.save();

  // CR-108: the role/capability-changed notice is SERVER-OWNED and best-effort — a
  // send/render/SMTP failure never rolls back the already-committed role change; it
  // records only a sanitized event.
  await notifyBestEffort("roleChanged", user, {
    subject: "Examopia — Hesab statusu yeniləndi",
    link: "/",
  });

  res.status(200).json({
    message: `User role updated to ${role} successfully`,
  });
});

// CR-108: fire a SERVER-OWNED transactional notification. The recipient, template and
// link are derived entirely from the server (never client input). It NEVER throws
// into the domain controller — a failure is recorded as a label-safe event so the
// already-committed password/role change is not rolled back.
async function notifyBestEffort(kind, user, { subject, link, code } = {}) {
  try {
    await sendNotification({ kind, to: user.email, subject, name: user.name, link, code });
  } catch (error) {
    recordDebug({ kind: "notify_failed", op: kind, category: classifyMailFailure(error) });
  }
}

// Send Reset Password Email. AUD-008: NON-ENUMERATING — the response is identical
// (same 200 + message) whether or not the email is registered, so it can't be used
// to discover accounts. The token/email work happens only for a real user; a send
// failure is logged server-side but STILL returns the generic 200 (uniform result).
const GENERIC_RESET_MSG = "Əgər bu email qeydiyyatdadırsa, şifrə bərpası linki göndərildi";
const forgotPasswordEmail = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email); // CR-050: canonical identity

  const user = email ? await User.findOne({ email }) : null;
  if (!user) {
    return res.status(200).json({ message: GENERIC_RESET_MSG });
  }

  // Delete the token if exists
  let token = await Token.findOne({ userId: user._id });
  if (token) {
    await token.deleteOne();
  }

  // Create Verification Token and Save
  const resetToken = crypto.randomBytes(32).toString("hex") + user._id;

  //Hash token and save
  const hashedToken = hashToken(resetToken);
  await new Token({
    userId: user._id,
    rToken: hashedToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * (60 * 1000), // 1hour
  }).save();

  //Construct Reset Password URL (relative — resolved to the frontend origin in mail)
  const resetUrl = `/resetPassword/${resetToken}`;

  try {
    await sendNotification({
      kind: "forgotPassword",
      to: user.email,
      subject: "Examopia — Şifrə bərpası",
      name: user.name,
      link: resetUrl,
    });
  } catch (error) {
    // Swallow the send error so the response can't reveal (via status/timing) that
    // the account exists; record it for operators instead.
    recordDebug({ kind: "forgot_email_send_failed", category: classifyMailFailure(error) });
    authMetrics.emailSendFailed();
  }
  return res.status(200).json({ message: GENERIC_RESET_MSG });
});

// Reset Password Action
const resetPassword = asyncHandler(async (req, res) => {
  const { resetToken } = req.params;
  const { password } = req.body;

  // AUD-008 (CR-005): COMPLETE type + policy validation BEFORE the token is
  // claimed, so malformed input (missing / non-string / too-short) can never
  // consume a one-time reset token. (A bare `.length` check let a non-string —
  // e.g. an array — pass and then strand the token on a Mongoose cast failure.)
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) {
    res.status(400);
    throw new Error(pwCheck.message);
  }

  const hashedToken = hashToken(resetToken);

  // AUD-008 (CR-005): atomically CLAIM the token by MARKING it used — set
  // `usedAt` only if it is still unused. This is one findAndModify, so it
  // serializes concurrent redemptions (exactly one matches `usedAt:null`), and
  // — crucially — the token is marked used BEFORE the password is written, so it
  // can NEVER be redeemed a second time even if the password save commits and
  // then throws. We deliberately do NOT un-claim on failure (that is exactly the
  // unsafe delete-then-restore that could re-enable a token after a committed
  // change). A failed apply strands THIS token (safe, no reuse); the user simply
  // requests a new reset link. `usedAt:null` also matches legacy tokens that
  // predate this field.
  const userToken = await Token.findOneAndUpdate(
    { rToken: hashedToken, expiresAt: { $gt: Date.now() }, usedAt: null },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
  if (!userToken) {
    // CR-051: classify a REPLAY (a token that exists but was already used) as a
    // label-safe metric — no response change (still the opaque 404).
    const alreadyUsed = await Token.findOne({ rToken: hashedToken, usedAt: { $ne: null } }).select("_id").lean();
    if (alreadyUsed) authMetrics.resetReplaySeen();
    res.status(404);
    throw new Error("Invalid or Expired Token!");
  }

  const user = await User.findOne({ _id: userToken.userId });
  if (!user) {
    // Account no longer exists; the (already-claimed) token is inert.
    res.status(404);
    throw new Error("Invalid or Expired Token!");
  }

  try {
    user.password = password;
    // AUD-002 (partial): bump the token-version so every previously-issued token
    // for this account is revoked by the reset.
    user.sessionVersion = (user.sessionVersion || 0) + 1;
    // A password reset also distrusts every remembered device (one-tap re-login).
    user.trustedDevices = [];
    await user.save();
  } catch (err) {
    // Do NOT restore the claim. Surface a structured event so a stranded reset
    // is observable rather than silently swallowed.
    recordDebug({ kind: "reset_apply_failed", message: err.message, userId: String(userToken.userId) });
    throw err;
  }

  // AUD-002 (Gate 2): the sessionVersion bump above is the DURABLE fence (it
  // already invalidates every issued token). When the session model is on, also
  // revoke the user's Session records as retryable cleanup — WITHOUT a second
  // epoch bump (revokeAllSessions does not touch sessionVersion).
  if (flags.SESSION_MODEL_ENABLED) {
    // CR-015: epoch-scoped cleanup — pass the committed target epoch (the
    // post-bump sessionVersion) so only old-epoch sessions are revoked.
    await sessionService.revokeAllSessions(user._id, user.sessionVersion || 0).catch(() => {});
  }

  // Best-effort cleanup — safety is already guaranteed by `usedAt`; a failed
  // delete just leaves an inert, already-used token (it can no longer match the
  // `usedAt:null` claim predicate). NOTE: the Token collection has no TTL index
  // yet (deferred under AUD-008), so such a record lingers until that migration
  // ships. Awaited (with the error swallowed) so cleanup ordering is
  // deterministic; it can never turn a successful reset into an error.
  await Token.deleteOne({ _id: userToken._id }).catch(() => {});

  res.status(200).json({
    message: "Password reset successful, Please login",
  });
});

// Change password
const changePassword = asyncHandler(async (req, res) => {
  const { oldPassword, password } = req.body;
  // AUD-001: needs the hash to compare the old password (schema hides it by default).
  const user = await User.findById(req.user._id).select("+password");

  // Validate types + policy BEFORE any mutation (Gate 2 / Queue 1A).
  if (typeof oldPassword !== "string" || typeof password !== "string" || !oldPassword || !password) {
    res.status(400);
    throw new Error("Please enter old and new password");
  }
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) {
    res.status(400);
    throw new Error(pwCheck.message);
  }
  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const isPasswordCorrect = await bcrypt.compare(oldPassword, user.password);
  if (!isPasswordCorrect) {
    res.status(400);
    throw new Error("Old password is incorrect");
  }

  if (!flags.SESSION_MODEL_ENABLED) {
    // Legacy behavior — byte-identical when the flag is off.
    user.password = password;
    await user.save();
    await notifyBestEffort("passwordChanged", user, { subject: "Examopia — Şifrəniz dəyişdirildi" });
    return res.status(200).json({ message: "Password reset successfully, Please re-login" });
  }

  // AUD-002 (Gate 2): atomic guarded write (password hash + one epoch bump) +
  // caller rebind + sibling revoke. `req.user._id` == sid-bound caller; get the
  // sid from the presented access token.
  const salt = await bcrypt.genSalt(10);
  const newHash = await bcrypt.hash(password, salt);
  const expectedSv = user.sessionVersion || 0;
  const decoded = jwt.decode(getToken(req)) || {};
  const sid = decoded.sid || "";

  const out = await sessionService.changePasswordAtomic(user, newHash, expectedSv, sid);
  if (!out.ok && out.conflict) {
    // Lost the guarded race to a concurrent password/epoch change — safe retry.
    res.status(409);
    throw new Error("Password change conflicted, please retry");
  }
  // A password change distrusts every remembered device (defence in depth) and
  // clears this device's trust cookie.
  await User.updateOne({ _id: user._id }, { $set: { trustedDevices: [] } }).catch(() => {});
  clearTrustCookie(res);
  // Password + epoch are committed here (whether or not the caller can rebind) — the
  // server-owned notice is best-effort and never affects that committed result.
  await notifyBestEffort("passwordChanged", user, { subject: "Examopia — Şifrəniz dəyişdirildi" });
  if (out.reauth) {
    // Password + epoch committed, but the caller's session could not be rebound
    // ⇒ clear credentials and require login (never roll back the epoch).
    clearAuthCookies(res);
    return res.status(401).json({ error: "reauthenticate", message: "Password changed, please log in again" });
  }
  // Caller stays signed in with the new pair.
  setRefreshCookie(res, out.refreshToken, out.refreshExpiresAt, out.absoluteExpiresAt);
  return res.status(200).json({ token: out.accessToken, message: "Password changed successfully" });
});

// Login With Google
const loginWithGoogle = asyncHandler(async (req, res) => {
  const { code } = req.body;

  // Exchange the one-time auth code (from the frontend popup "auth-code" flow)
  // for tokens, server-side, and verify the id_token. Routed through the
  // `googleVerify` seam so tests can inject a payload WITHOUT a real Google call.
  const payload = await googleVerify(code);
  const { name, picture, sub } = payload;
  const email = normalizeEmail(payload.email); // CR-050: canonical identity reconciliation
  const password = Date.now() + sub;

  // Get user agent
  const ua = parser(req.headers["user-agent"]);
  const userAgent = ua.ua;

  // Check if the user exist
  const user = await User.findOne({ email });

  if (!user) {
    // Create a new user
    const newUser = await User.create({
      name,
      email,
      password,
      photo: picture,
      userAgent,
      isVerified: true,
      acquisition: cleanAcquisition(req.body.acquisition),
    });

    if (newUser) {
      // Generate token
      // AUD-002 (CR-011): unified issuance (Google, new user) — preserve the
      // historical 1-day flag-off cookie expiry.
      const token = await issueLoginToken(req, res, newUser, { expires: new Date(Date.now() + 1000 * 86400) });
      await issueTrustDevice(req, res, newUser);

      const {
        _id,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        teacherApproval,
        isVerified,
        userAgent,
        createdAt,
      } = newUser;
      res.status(201).json({
        _id,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        teacherApproval, // AUD-005 (CR-046): Google new-user DTO carries capability state
        isVerified,
        userAgent,
        createdAt,
        token,
      });
    }
  }

  // User exists Login
  if (user) {
    // Diagnostic: which device logged in (to correlate with later failures).
    recordDebug({
      kind: "login_ok",
      message: "google",
      email: user.email,
      ua: req.headers["user-agent"],
      ip: req.ip,
    });

    // AUD-002 (CR-011): unified issuance (Google, existing user) — preserve the
    // historical 1-day flag-off cookie expiry.
    const token = await issueLoginToken(req, res, user, { expires: new Date(Date.now() + 1000 * 86400) });
    await issueTrustDevice(req, res, user);

    const { _id, name, email, phone, bio, photo, role, teacherApproval, isVerified, userAgent, createdAt } =
      user;
    res.status(200).json({
      _id,
      name,
      email,
      phone,
      bio,
      photo,
      role,
      teacherApproval, // AUD-005 (CR-046): Google existing-user DTO carries capability state
      isVerified,
      userAgent,
      createdAt,
      token,
    });
  }
});

// The setup walkthrough, as the server sees it.
//
// Only the LAST step is stored. Everything before it is derived from data that
// already exists, so a teacher who set their class up before this feature
// shipped is not told to start over, and deleting a class moves them back
// rather than leaving a stale tick behind.
const TEACHER_STEPS = ["class", "exam", "questions", "invite"];

// POST /api/users/onboarding — record the one step that leaves no other trace.
const markOnboardingStep = asyncHandler(async (req, res) => {
  if (String(req.body?.step) !== "invite") {
    res.status(400);
    throw new Error("Naməlum addım");
  }
  // First time wins: this is "when did they first share", not a click counter.
  await User.updateOne(
    { _id: req.user._id, "onboarding.invitedAt": { $exists: false } },
    { $set: { "onboarding.invitedAt": new Date() } }
  );
  res.json({ ok: true });
});

// GET /api/users/onboardingReport (admin) — how far each teacher got.
//
// Three grouped aggregations rather than a query per teacher, so this stays
// one round trip regardless of how many accounts exist.
const onboardingReport = asyncHandler(async (req, res) => {
  const teachers = await User.find({ role: { $in: ["teacher", "admin"] } })
    .select("name email role createdAt lastActiveAt onboarding")
    .sort({ createdAt: -1 })
    .lean();
  if (!teachers.length) return res.json({ steps: TEACHER_STEPS, teachers: [] });

  const ids = teachers.map((t) => t._id);

  const classRows = await Class.aggregate([
    { $match: { owner: { $in: ids } } },
    { $group: { _id: "$owner", n: { $sum: 1 } } },
  ]);

  // Exams, split into "exists" and "has questions in it" — an exam with no
  // questions is invisible to students, so it is not a finished step.
  // NB: the exam's creator is `owner`, not `user` — `user` does not exist on
  // this collection, and matching on it silently returns nothing, which reads
  // as "no teacher has ever made an exam" rather than as an error.
  const examRows = await Exam.aggregate([
    { $match: { owner: { $in: ids }, deletedAt: null } },
    { $lookup: { from: "questions", localField: "questions", foreignField: "_id", as: "q" } },
    {
      $project: {
        owner: 1,
        n: { $size: { $ifNull: [{ $arrayElemAt: ["$q.correctAnswers", 0] }, []] } },
      },
    },
    {
      $group: {
        _id: "$owner",
        exams: { $sum: 1 },
        ready: { $sum: { $cond: [{ $gt: ["$n", 0] }, 1, 0] } },
      },
    },
  ]);

  const studentRows = await Enrollment.aggregate([
    { $match: { status: "approved" } },
    { $lookup: { from: "classes", localField: "class", foreignField: "_id", as: "c" } },
    { $unwind: "$c" },
    { $match: { "c.owner": { $in: ids } } },
    { $group: { _id: "$c.owner", n: { $sum: 1 } } },
  ]);

  const byId = (rows) =>
    rows.reduce((m, r) => {
      m[String(r._id)] = r;
      return m;
    }, {});
  const cls = byId(classRows);
  const exm = byId(examRows);
  const std = byId(studentRows);

  const out = teachers.map((t) => {
    const id = String(t._id);
    const counts = {
      classes: cls[id]?.n || 0,
      exams: exm[id]?.exams || 0,
      examsReady: exm[id]?.ready || 0,
      students: std[id]?.n || 0,
    };
    const done = [
      counts.classes > 0,
      counts.exams > 0,
      counts.examsReady > 0,
      !!t.onboarding?.invitedAt || counts.students > 0,
    ];
    // Where they are is the FIRST unfinished step, not the count of finished
    // ones: someone who shared a link but never added questions is stuck on
    // questions, and reporting them as "3 of 4" would hide that.
    const stuckAt = done.indexOf(false);
    return {
      _id: t._id,
      name: t.name,
      email: t.email,
      role: t.role,
      createdAt: t.createdAt,
      lastActiveAt: t.lastActiveAt,
      invitedAt: t.onboarding?.invitedAt || null,
      counts,
      done,
      completed: stuckAt === -1,
      stuckAt: stuckAt === -1 ? null : stuckAt,
      percent: Math.round((done.filter(Boolean).length / done.length) * 100),
    };
  });

  res.json({ steps: TEACHER_STEPS, teachers: out });
});

// GET /api/users/storage (teacher) — how much of the allowance is used.
// PATCH /api/users/:id/storage (admin) — raise or reset one teacher's quota.
const getMyStorage = asyncHandler(async (req, res) => {
  const used = await usedBytes(req.user._id);
  res.json({ used, limit: quotaFor(req.user), isDefault: !req.user.storageQuotaBytes });
});

const setUserStorage = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("name email role storageQuotaBytes");
  if (!user) {
    res.status(404);
    throw new Error("İstifadəçi tapılmadı");
  }
  const raw = req.body?.gigabytes;
  // null/empty puts them back on the platform default rather than storing a
  // number that then has to be maintained if the default ever changes.
  if (raw === null || raw === "" || raw === undefined) {
    user.storageQuotaBytes = undefined;
  } else {
    const gbs = Number(raw);
    if (!Number.isFinite(gbs) || gbs <= 0 || gbs > 500) {
      res.status(400);
      throw new Error("1 ilə 500 GB arasında dəyər yazın");
    }
    user.storageQuotaBytes = Math.round(gbs * 1024 * 1024 * 1024);
  }
  await user.save();
  const used = await usedBytes(user._id);
  res.json({
    _id: user._id,
    name: user.name,
    used,
    limit: quotaFor(user),
    isDefault: !user.storageQuotaBytes,
  });
});

// PATCH /api/users/:id/plan — admin sets a user's paid package (manual upgrade
// flow: teacher pays offline, admin flips the plan here). Body: { plan, months?,
// examCreatesLeft? }. `months` sets an expiry for paid tiers; `examCreatesLeft`
// optionally overrides the free exam allowance (e.g. top up a stuck teacher).
const setUserPlan = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select(
    "name email role plan planSince planExpiresAt planSource examCreatesLeft aiCredits"
  );
  if (!user) {
    res.status(404);
    throw new Error("İstifadəçi tapılmadı");
  }
  const { plan, months, examCreatesLeft } = req.body || {};
  if (!PLAN_IDS.includes(plan)) {
    res.status(400);
    throw new Error("Yanlış paket");
  }
  const wasPaid = ["pro", "premium"].includes(normalizePlan(user.plan));
  user.plan = plan;
  user.planSource = "admin";
  if (plan === "free") {
    // Downgrade: keep them visible in the "downgraded" panel — stamp only when
    // coming FROM a paid plan; keep planSince as the original subscribe date.
    if (wasPaid) user.planDowngradedAt = new Date();
    user.planExpiresAt = null;
  } else {
    user.planSince = new Date();
    user.planDowngradedAt = null; // re-subscribed → no longer downgraded
    const m = Number(months);
    user.planExpiresAt =
      Number.isFinite(m) && m > 0
        ? new Date(Date.now() + m * 30 * 24 * 60 * 60 * 1000)
        : null; // open-ended until an expiry is set
    // Grant the plan's monthly AI credit allowance on activation/renewal
    // (skip when the admin passes an explicit examCreatesLeft-only tweak? no —
    // any plan set is an activation). Credits stack with the current balance.
    const monthly = planDef(plan).credits?.monthly || 0;
    if (monthly > 0) user.aiCredits = (user.aiCredits || 0) + monthly;
  }
  if (examCreatesLeft !== undefined) {
    const n = Number(examCreatesLeft);
    if (Number.isFinite(n) && n >= 0) user.examCreatesLeft = Math.round(n);
  }
  await user.save();
  // Upgrading raises the student cap → let waitlisted students in automatically.
  let promoted = 0;
  if (plan !== "free") {
    try {
      promoted = await require("../helper/planLimits").promoteWaitlisted(user._id);
    } catch (e) {
      console.error("[PLAN] promoteWaitlisted failed:", e.message);
    }
  }
  res.json({
    _id: user._id,
    name: user.name,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt,
    examCreatesLeft: user.examCreatesLeft,
    aiCredits: user.aiCredits,
    promoted,
  });
});

// PATCH /api/users/:id/credits — admin adjusts a user's AI credit balance.
// Body: { delta } (add/subtract) or { set } (absolute). Never goes below 0.
const setUserCredits = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("name aiCredits");
  if (!user) {
    res.status(404);
    throw new Error("İstifadəçi tapılmadı");
  }
  const { delta, set } = req.body || {};
  let next = user.aiCredits || 0;
  if (set !== undefined && Number.isFinite(Number(set))) next = Math.round(Number(set));
  else if (Number.isFinite(Number(delta))) next += Math.round(Number(delta));
  else {
    res.status(400);
    throw new Error("Kredit dəyəri yanlışdır");
  }
  user.aiCredits = Math.max(0, next);
  await user.save();
  res.json({ _id: user._id, name: user.name, aiCredits: user.aiCredits });
});

// POST /api/users/app-installed — the frontend calls this the first time the
// signed-in user opens the site as an installed PWA (standalone display mode).
// Idempotent: the timestamp is stamped once, so re-reports on later launches
// don't overwrite it. Lets the admin directory show who installed the app.
const markAppInstalled = asyncHandler(async (req, res) => {
  await User.updateOne(
    { _id: req.user._id, appInstalled: { $ne: true } },
    { $set: { appInstalled: true, appInstalledAt: new Date() } }
  );
  res.json({ ok: true });
});

// ── Web Push opt-in ─────────────────────────────────────────────────────────
// GET /api/users/push/public-key — the VAPID public key the browser needs to
// create a subscription. Public by design (the private key stays on the server).
const getPushPublicKey = asyncHandler(async (req, res) => {
  const { isConfigured, publicKey } = require("../config/webPush");
  if (!isConfigured()) {
    res.status(503);
    throw new Error("Push bildirişləri hələ konfiqurasiya olunmayıb");
  }
  res.json({ key: publicKey() });
});

// POST /api/users/push/subscribe — store THIS device's push subscription so the
// user can receive notifications on their phone. Idempotent per endpoint
// (re-subscribing just refreshes it); pushSubscribedAt is stamped on first opt-in.
const subscribePush = asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    res.status(400);
    throw new Error("Yanlış abunə məlumatı");
  }
  const entry = {
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    ua: String(req.get("user-agent") || "").slice(0, 300),
    at: new Date(),
  };
  // Refresh any existing entry for this exact device, then add the current one.
  await User.updateOne({ _id: req.user._id }, { $pull: { push: { endpoint } } });
  await User.updateOne({ _id: req.user._id }, { $push: { push: entry } });
  await User.updateOne(
    { _id: req.user._id, pushSubscribedAt: null },
    { $set: { pushSubscribedAt: new Date() } }
  );
  res.json({ ok: true });
});

// POST /api/users/push/unsubscribe — drop this device's subscription.
const unsubscribePush = asyncHandler(async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) {
    await User.updateOne({ _id: req.user._id }, { $pull: { push: { endpoint } } });
  }
  res.json({ ok: true });
});

// ── Auto-outreach watcher (admin) ────────────────────────────────────────────
// GET /api/users/outreach/status — is the watcher on, since when, and is there a
// linked+ready admin WhatsApp session to actually send from?
const getOutreachStatus = asyncHandler(async (req, res) => {
  const { getSettings, waitingCount, sentTodayCount, withinHours, GAP_MIN, DAILY_MAX, DAY_START, DAY_END } = require("../jobs/autoOutreach");
  const wa = require("../helper/whatsapp");
  const settings = await getSettings();
  const admins = await User.find({ role: "admin" }).select("_id").lean();
  const senderId = wa.firstReadyOwner(admins.map((a) => a._id));
  // Queue depth is a bit heavier (stuck check over all uncontacted teachers) —
  // best-effort so it never blocks the toggle state.
  let waiting = null;
  try {
    if (settings.enabled) waiting = await waitingCount();
  } catch {
    waiting = null;
  }
  let sentToday = null;
  try {
    sentToday = await sentTodayCount();
  } catch {
    sentToday = null;
  }
  res.json({
    enabled: settings.enabled,
    whatsappLinked: !!senderId,
    withinHours: withinHours(new Date()),
    dayStart: DAY_START,
    dayEnd: DAY_END,
    gapMin: GAP_MIN,
    dailyMax: DAILY_MAX,
    sentToday,
    lastSentAt: settings.lastSentAt,
    waiting,
  });
});

// POST /api/users/outreach/toggle — flip the watcher on/off. Turning it ON only
// watches registrations from now forward (never the historical backlog).
const toggleOutreach = asyncHandler(async (req, res) => {
  const { getSettings, setEnabled, waitingCount, withinHours, GAP_MIN, DAY_START, DAY_END } = require("../jobs/autoOutreach");
  const wa = require("../helper/whatsapp");
  const current = await getSettings();
  const next = typeof req.body?.enabled === "boolean" ? req.body.enabled : !current.enabled;
  const settings = await setEnabled(next);
  const admins = await User.find({ role: "admin" }).select("_id").lean();
  const senderId = wa.firstReadyOwner(admins.map((a) => a._id));
  let waiting = null;
  try {
    if (settings.enabled) waiting = await waitingCount();
  } catch {
    waiting = null;
  }
  res.json({
    enabled: settings.enabled,
    whatsappLinked: !!senderId,
    withinHours: withinHours(new Date()),
    dayStart: DAY_START,
    dayEnd: DAY_END,
    gapMin: GAP_MIN,
    waiting,
  });
});

// GET /api/users/setup-funnel — admin analytics: how far each teacher has got in
// setting up (a current-state snapshot for the İnkişaf tab). Categories can
// overlap (a teacher may have both an empty exam and no students). "finished" =
// fully set up (has a class, a ready exam, students, and no empty class/exam).
const getSetupFunnel = asyncHandler(async (req, res) => {
  const teachers = await User.find({ role: "teacher" }).select("_id").lean();
  const ids = teachers.map((t) => t._id);
  const total = ids.length;
  if (!total) {
    return res.json({ total: 0, finished: 0, notStarted: 0, emptyClass: 0, emptyExam: 0, noStudents: 0 });
  }

  const [stuckMap, classRows, contentExamRows, studentRows, planRows] = await Promise.all([
    stuckStateForOwners(ids),
    Class.aggregate([
      { $match: { owner: { $in: ids }, deletedAt: null } },
      { $group: { _id: "$owner", n: { $sum: 1 } } },
    ]),
    // Teachers with ≥1 exam that actually has content (questions OR a PDF).
    Exam.aggregate([
      { $match: { owner: { $in: ids }, deletedAt: null } },
      { $lookup: { from: "questions", localField: "questions", foreignField: "_id", as: "q" } },
      {
        $project: {
          owner: 1,
          qcount: { $size: { $ifNull: [{ $arrayElemAt: ["$q.correctAnswers", 0] }, []] } },
          hasPdf: { $cond: [{ $ifNull: ["$pdf", false] }, true, false] },
        },
      },
      { $match: { $or: [{ qcount: { $gt: 0 } }, { hasPdf: true }] } },
      { $group: { _id: "$owner", n: { $sum: 1 } } },
    ]),
    // Distinct approved students per teacher (Enrollment carries a denormalised teacher).
    Enrollment.aggregate([
      { $match: { status: "approved", teacher: { $in: ids } } },
      { $group: { _id: "$teacher", s: { $addToSet: "$student" } } },
      { $project: { n: { $size: "$s" } } },
    ]),
    User.aggregate([{ $match: { role: "teacher" } }, { $group: { _id: "$plan", n: { $sum: 1 } } }]),
  ]);

  const classCount = new Map(classRows.map((r) => [String(r._id), r.n]));
  const hasContentExam = new Set(contentExamRows.map((r) => String(r._id)));
  const studentCount = new Map(studentRows.map((r) => [String(r._id), r.n]));
  const plans = { free: 0, pro: 0, premium: 0 };
  planRows.forEach((r) => {
    const p = normalizePlan(r._id);
    if (plans[p] != null) plans[p] += r.n;
  });

  const out = { total, plans, finished: 0, readyNoStudents: 0, notStarted: 0, emptyClass: 0, emptyExam: 0, noStudents: 0 };
  ids.forEach((id) => {
    const k = String(id);
    const st = stuckMap.get(k) || {};
    const classes = classCount.get(k) || 0;
    const students = studentCount.get(k) || 0;
    const content = hasContentExam.has(k);
    if (st.hasNoSetup) out.notStarted += 1;
    if (st.hasEmptyClass) out.emptyClass += 1;
    if (st.hasEmptyExam) out.emptyExam += 1;
    if (classes > 0 && students === 0) out.noStudents += 1;
    // Built a class + a ready exam but never invited anyone — one step from active.
    if (classes > 0 && content && students === 0) out.readyNoStudents += 1;
    if (classes > 0 && content && students > 0 && !st.hasEmptyClass && !st.hasEmptyExam) out.finished += 1;
  });
  res.json(out);
});

module.exports = {
  __setGoogleVerifyForTest, // test-only seam (rejects unless NODE_ENV==="test")
  getSetupFunnel,
  getMyStorage,
  setUserStorage,
  markOnboardingStep,
  onboardingReport,
  registerUser,
  loginUser,
  deviceLogin,
  forgetDevice,
  logoutUser,
  markAppInstalled,
  getPushPublicKey,
  subscribePush,
  unsubscribePush,
  getUser,
  getUsers,
  updateUser,
  deleteUser,
  setUserPhone,
  setUserPlan,
  setUserCredits,
  impersonateUser,
  loginStatus,
  upgradeUser,
  sendVerificationEmail,
  verifyUser,
  forgotPasswordEmail,
  resetPassword,
  changePassword,
  sendLoginCode,
  loginWithCode,
  loginWithGoogle,
  getUserById,
  bulkUsers,
  teacherOverview,
  teacherOverviewExamDto,
  getOutreachStatus,
  toggleOutreach,
};
