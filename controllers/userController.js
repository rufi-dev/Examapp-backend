const asyncHandler = require("express-async-handler");
const User = require("../models/userModel");
const Enrollment = require("../models/enrollmentModel");
const Class = require("../models/classModel");
const VisitorSession = require("../models/visitorSessionModel");
const bcrypt = require("bcryptjs");
const { generateToken, hashToken, getToken } = require("../utils/index");
const { recordDebug } = require("../utils/debugLog");
const parser = require("ua-parser-js");
const jwt = require("jsonwebtoken");
const { sendEmail } = require("../utils/sendEmail");
const crypto = require("crypto");
const Token = require("../models/tokenModel");
const Cryptr = require("cryptr");
const { OAuth2Client } = require("google-auth-library");

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

// Register User
const registerUser = asyncHandler(async (req, res) => {
  try {
    const { name, email, password, phone, grade } = req.body;

    // Validation — phone + grade (Sinif) are mandatory at sign-up.
    if (!name || !email || !password || !phone || !grade) {
      res.status(400);
      throw new Error("Zəhmət olmasa bütün xanaları doldurun (ad, email, şifrə, sinif, telefon)");
    }

    if (password.length < 6) {
      res.status(400);
      throw new Error("Şifrə ən azı 6 karakter uzunluğunda olmalıdır");
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
      grade,
      userAgent,
      isVerified: true,
      signupIp: req.ip,
      lastIp: req.ip,
      acquisition: cleanAcquisition(req.body.acquisition),
    });

    // Generate token
    const token = generateToken(user._id);

    // Send HTTP-only cookie
    res.cookie("token", token, {
      path: "/",
      httpOnly: true,
      //expires: new Date(Date.now() + 1000 * 86400), // 1 day
      sameSite: "none",
      secure: true,
    });

    if (user) {
      const {
        _id,
        createdAt,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        isVerified,
        userAgent,
        grade,
      } = user;
      res.status(201).json({
        _id,
        createdAt,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        isVerified,
        userAgent,
        grade,
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
const loginUser = asyncHandler(async (req, res) => {
  try {
    const { email, password } = req.body;

    //Validation
    if (!email || !password) {
      res.status(400);
      throw new Error("Email və Şifrə Əlavə edin");
    }

    const user = await User.findOne({ email });

    if (!user) {
      res.status(400);
      throw new Error("Belə bir istifadəcimiz mövcud deyil");
    }

    console.log("login user", user)

    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      res.status(400);
      throw new Error("Email və ya şifrə yanlışdır");
    }

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

    // Generate token
    const token = generateToken(user._id);
    if (user && isPasswordCorrect) {
      // Diagnostic: which device logged in (to correlate with later failures).
      recordDebug({
        kind: "login_ok",
        message: "password",
        email: user.email,
        ua: req.headers["user-agent"],
        ip: req.ip,
      });
      // Send HTTP-only cookie
      res.cookie("token", token, {
        path: "/",
        httpOnly: true,
        //expires: new Date(Date.now() + 1000 * 86400), // 1 day
        sameSite: "none",
        secure: true,
      });
      const {
        _id,
        createdAt,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        isVerified,
        userAgent,
      } = user;

      res.status(200).json({
        _id,
        createdAt,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        isVerified,
        userAgent,
        token,
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

// Send Login Code to Email
const sendLoginCode = asyncHandler(async (req, res) => {
  const { email } = req.params;

  const user = await User.findOne({ email });

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  // Find login code in DB
  let userToken = await Token.findOne({
    userId: user._id,
    expiresAt: { $gt: Date.now() },
  });

  if (!userToken) {
    res.status(404);
    throw new Error("Invalid or Expired token, please login again");
  }

  const loginCode = userToken.lToken;
  const decryptedLoginCode = cryptr.decrypt(loginCode);

  //Send Login Code Email
  const subject = "BunkerMath — Giriş kodu";
  const send_to = email;
  const sent_from = process.env.EMAIL_USER;
  const reply_to = process.env.EMAIL_USER || "bunkermath@gmail.com";
  const template = "loginCode";
  const name = user.name;
  const link = decryptedLoginCode;

  try {
    await sendEmail(
      subject,
      send_to,
      sent_from,
      reply_to,
      template,
      name,
      link
    );
    res.status(200).json({ message: `Access code sent to ${email}` });
  } catch (error) {
    res.status(500);
    throw new Error("Reset Password Email not sent, please try again");
  }
});

// Login With Code
const loginWithCode = asyncHandler(async (req, res) => {
  const { email } = req.params;
  const { loginCode } = req.body;

  if (!loginCode) {
    res.status(400);
    throw new Error("Please enter login code");
  }

  const user = await User.findOne({ email });

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  // Find user login token
  let userToken = await Token.findOne({
    userId: user._id,
    expiresAt: { $gt: Date.now() },
  });

  if (!userToken) {
    res.status(404);
    throw new Error("Invalid or Expired token, please login again");
  }

  const decryptedLoginCode = cryptr.decrypt(userToken.lToken);

  if (loginCode != decryptedLoginCode) {
    res.status(400);
    throw new Error("Incorrect login code, please try again");
  } else {
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
    const token = generateToken(user._id);

    // Send HTTP-only cookie
    res.cookie("token", token, {
      path: "/",
      httpOnly: true,
      expires: new Date(Date.now() + 1000 * 86400), // 1 day
      sameSite: "none",
      secure: true,
    });

    const { _id, createdAt, name, email, phone, bio, photo, role, isVerified, userAgent } =
      user;
    res.status(200).json({
      _id,
      createdAt,
      name,
      email,
      phone,
      bio,
      photo,
      role,
      isVerified,
      userAgent,
      token,
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
  const verificationUrl = `${process.env.FRONTEND_URL}/verify/${verificationToken}`;
  //Send Verification Email
  const subject = "BunkerMath — Hesabı təsdiqlə";
  const send_to = user.email;
  const sent_from = process.env.EMAIL_USER;
  const reply_to = process.env.EMAIL_USER || "bunkermath@gmail.com";
  const template = "verifyEmail";
  const name = user.name;
  const link = verificationUrl;
  try {
    await sendEmail(
      subject,
      send_to,
      sent_from,
      reply_to,
      template,
      name,
      link
    );
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
  res.cookie("token", "", {
    path: "/",
    httpOnly: true,
    expires: new Date(0), // expire immediately
    sameSite: "none",
    secure: true,
  });

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
        createdAt,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        exams,
        isVerified,
        userAgent,
        whatsappOptIn,
        whatsappGroupJoined,
        grade,
      } = user;

      res.status(200).json({
        _id,
        createdAt,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        exams,
        isVerified,
        userAgent,
        whatsappOptIn,
        whatsappGroupJoined,
        grade,
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

  const user = await User.findById(id)
    // Never the password hash; IPs and where they came from only for an admin.
    .select(req.user.role === "admin" ? "-password" : "-password -signupIp -lastIp -acquisition -lastActiveAt")
    .populate("exams")
    .populate({
      path: "results",
      populate: {
        path: "examId",
      },
    })
    .exec();

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  res.status(200).json(user);
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
    // Grade ("Sinif") — only when the client sends a non-empty value.
    if (typeof req.body.grade === "string" && req.body.grade.trim()) {
      user.grade = req.body.grade.trim();
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
      isVerified: updatedUser.isVerified,
      whatsappOptIn: updatedUser.whatsappOptIn,
      grade: updatedUser.grade,
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

  await user.deleteOne();

  res.status(200).json({
    message: "User removed successfully",
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
  const isAdmin = req.user.role === "admin";
  // IPs and where an account came from are admin-only analytics: a teacher's
  // student list never carries them.
  const users = await User.find(filter)
    .sort("-createdAt")
    .select(isAdmin ? "-password" : "-password -signupIp -lastIp -acquisition")
    .lean();

  // "Came from" — link each account to its earliest tagged visitor session with
  // a real source, so the directory shows where a user arrived from even if they
  // signed up before acquisition was captured at register (as long as they've
  // since browsed while logged in, which stamps their id on the session).
  if (isAdmin && users.length) {
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

  res.status(200).json(users || []);
});

// Login Status
const loginStatus = asyncHandler(async (req, res) => {
  try {
    const token = getToken(req);
    if (!token) {
      return res.json(false);
    }
    //Verify Token
    const verified = jwt.verify(token, process.env.JWT_SECRET);

    if (verified) {
      return res.json(true);
    }
    console.log("loginstatus:", token);
    return res.json(false);
  } catch (error) {
    // Malformed/expired token -> treat as logged out instead of hanging the request
    console.log("loginstatuscatch:", error.message);
    return res.json(false);
  }
});

// Update User Role
const upgradeUser = asyncHandler(async (req, res) => {
  const { role, id } = req.body;

  const user = await User.findById(id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  user.role = role;
  await user.save();

  res.status(200).json({
    message: `User role updated to ${role} successfully`,
  });
});

// Send Auto Email
const sendAutomatedEmail = asyncHandler(async (req, res) => {
  const { subject, send_to, reply_to, template, url } = req.body;

  if (!subject || !send_to || !reply_to || !template) {
    res.status(500);
    throw new Error("Missing email parameter");
  }

  //Get User
  const user = await User.findOne({ email: send_to });

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const sent_from = process.env.EMAIL_USER;
  const name = user.name;
  const link = `${process.env.FRONTEND_URL}${url}`;

  try {
    await sendEmail(
      subject,
      send_to,
      sent_from,
      reply_to,
      template,
      name,
      link
    );
    res.status(200).json({ message: "Email sent successfully" });
  } catch (error) {
    res.status(500);
    throw new Error("Email not sent, please try again");
  }
});

// Send Reset Password Email
const forgotPasswordEmail = asyncHandler(async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });

  if (!user) {
    res.status(404);
    throw new Error("No user with this email");
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

  //Construct Reset Password URL
  const resetUrl = `${process.env.FRONTEND_URL}/resetPassword/${resetToken}`;

  //Send Reset Password Email
  const subject = "BunkerMath — Şifrə bərpası";
  const send_to = user.email;
  const sent_from = process.env.EMAIL_USER;
  const reply_to = process.env.EMAIL_USER || "bunkermath@gmail.com";
  const template = "forgotPassword";
  const name = user.name;
  const link = resetUrl;

  try {
    await sendEmail(
      subject,
      send_to,
      sent_from,
      reply_to,
      template,
      name,
      link
    );
    res.status(200).json({ message: "Reset Password Email Sent" });
  } catch (error) {
    res.status(500);
    throw new Error("Reset Password Email not sent, please try again");
  }
});

// Reset Password Action
const resetPassword = asyncHandler(async (req, res) => {
  const { resetToken } = req.params;
  const { password } = req.body;

  // Validation
  if (password.length < 6) {
    res.status(400);
    throw new Error("Password must be at least 6 characters");
  }

  const hashedToken = hashToken(resetToken);

  const userToken = await Token.findOne({
    rToken: hashedToken,
    expiresAt: { $gt: Date.now() },
  });
  if (!userToken) {
    res.status(404);
    throw new Error("Invalid or Expired Token!");
  }

  // Find user
  const user = await User.findOne({ _id: userToken.userId });

  // Now reset user password
  user.password = password;
  await user.save();

  res.status(200).json({
    message: "Password reset successful, Please login",
  });
});

// Change password
const changePassword = asyncHandler(async (req, res) => {
  const { oldPassword, password } = req.body;
  const user = await User.findById(req.user._id);

  if (password.length < 6) {
    res.status(400);
    throw new Error("Password must be at least 6 characters");
  }

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  if (!oldPassword || !password) {
    res.status(400);
    throw new Error("Please enter old and new password");
  }

  //Check if old password is correct
  const isPasswordCorrect = await bcrypt.compare(oldPassword, user.password);

  //Save new password
  if (user && isPasswordCorrect) {
    user.password = password;
    await user.save();
    res
      .status(200)
      .json({ message: "Password reset successfully, Please re-login" });
  } else {
    res.status(400);
    throw new Error("Old password is incorrect");
  }
});

// Login With Google
const loginWithGoogle = asyncHandler(async (req, res) => {
  const { code } = req.body;

  // Exchange the one-time auth code (from the frontend popup "auth-code" flow)
  // for tokens, server-side. This avoids the GSI button's third-party-cookie
  // requirement that breaks in modern browsers.
  const { tokens } = await client.getToken(code);

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  const { name, email, picture, sub } = payload;
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
      signupIp: req.ip,
      lastIp: req.ip,
      acquisition: cleanAcquisition(req.body.acquisition),
    });

    if (newUser) {
      // Generate token
      const token = generateToken(newUser._id);

      // Send HTTP-only cookie
      res.cookie("token", token, {
        path: "/",
        httpOnly: true,
        expires: new Date(Date.now() + 1000 * 86400), // 1 day
        sameSite: "none",
        secure: true,
      });

      const {
        _id,
        createdAt,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        isVerified,
        userAgent,
      } = newUser;
      res.status(201).json({
        _id,
        createdAt,
        name,
        email,
        phone,
        bio,
        photo,
        role,
        isVerified,
        userAgent,
        token,
      });
    }
  }

  // User exists Login
  if (user) {
    // Generate token
    const token = generateToken(user._id);

    // Diagnostic: which device logged in (to correlate with later failures).
    recordDebug({
      kind: "login_ok",
      message: "google",
      email: user.email,
      ua: req.headers["user-agent"],
      ip: req.ip,
    });

    // Send HTTP-only cookie
    res.cookie("token", token, {
      path: "/",
      httpOnly: true,
      expires: new Date(Date.now() + 1000 * 86400), // 1 day
      sameSite: "none",
      secure: true,
    });

    const { _id, createdAt, name, email, phone, bio, photo, role, isVerified, userAgent } =
      user;
    res.status(200).json({
      _id,
      createdAt,
      name,
      email,
      phone,
      bio,
      photo,
      role,
      isVerified,
      userAgent,
      token,
    });
  }
});

// GET /api/users/setup-funnel — admin analytics («Analitika» → Müəllimlər): how
// far each teacher has got in setting up, as a current-state snapshot. Ported
// from Examopia (without its plans). Categories can overlap (a teacher may have
// both an empty exam and no students). "finished" = fully set up: a class, an
// exam with content, students, and no empty class or exam.
const getSetupFunnel = asyncHandler(async (req, res) => {
  const Exam = require("../models/examModel");
  const teachers = await User.find({ role: "teacher" }).select("_id").lean();
  const ids = teachers.map((t) => t._id);
  const total = ids.length;
  if (!total) {
    return res.json({ total: 0, finished: 0, readyNoStudents: 0, notStarted: 0, emptyClass: 0, emptyExam: 0, noStudents: 0 });
  }

  const [classes, exams, enrolled] = await Promise.all([
    Class.find({ owner: { $in: ids } }).select("_id owner").lean(),
    // Each exam and whether it has content (an answer key, or a PDF).
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
    ]),
    Enrollment.aggregate([
      { $match: { status: "approved" } },
      { $group: { _id: "$class", s: { $addToSet: "$student" } } },
    ]),
  ]);

  const studentsOfClass = new Map(enrolled.map((r) => [String(r._id), r.s.map(String)]));
  const per = new Map(ids.map((id) => [String(id), { classes: 0, emptyClass: false, students: new Set(), exams: 0, content: false, emptyExam: false }]));
  for (const c of classes) {
    const t = per.get(String(c.owner));
    if (!t) continue;
    t.classes += 1;
    const s = studentsOfClass.get(String(c._id)) || [];
    if (!s.length) t.emptyClass = true;
    s.forEach((x) => t.students.add(x));
  }
  for (const e of exams) {
    const t = per.get(String(e.owner));
    if (!t) continue;
    t.exams += 1;
    if (e.qcount > 0 || e.hasPdf) t.content = true;
    else t.emptyExam = true;
  }

  const out = { total, finished: 0, readyNoStudents: 0, notStarted: 0, emptyClass: 0, emptyExam: 0, noStudents: 0 };
  for (const t of per.values()) {
    const students = t.students.size;
    if (!t.classes && !t.exams) out.notStarted += 1;
    if (t.emptyClass) out.emptyClass += 1;
    if (t.emptyExam) out.emptyExam += 1;
    if (t.classes > 0 && students === 0) out.noStudents += 1;
    // Built a class + a ready exam but never invited anyone — one step from active.
    if (t.classes > 0 && t.content && students === 0) out.readyNoStudents += 1;
    if (t.classes > 0 && t.content && students > 0 && !t.emptyClass && !t.emptyExam) out.finished += 1;
  }
  res.json(out);
});

module.exports = {
  registerUser,
  loginUser,
  logoutUser,
  getUser,
  getUsers,
  updateUser,
  deleteUser,
  loginStatus,
  upgradeUser,
  sendAutomatedEmail,
  sendVerificationEmail,
  verifyUser,
  forgotPasswordEmail,
  resetPassword,
  changePassword,
  sendLoginCode,
  loginWithCode,
  loginWithGoogle,
  getUserById,
  getSetupFunnel,
};
