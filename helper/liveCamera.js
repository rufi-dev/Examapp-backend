/*
 * Live exam cameras (owner, 2026-10-18: "in a live exam, open the students'
 * cameras and the teacher watches live"; "only if enabled in the settings";
 * "a student who doesn't open it can still take the exam, and the live exam
 * shows it as closed").
 *
 * The video goes through our own LiveKit server (Oracle, see the deploy notes),
 * never through this backend: here we only sign the passes. Each exam is a
 * LiveKit room. A student taking the exam gets a pass that may SEND one camera
 * and receive nothing; the exam's teacher gets a hidden pass that may only
 * WATCH. Video only, no audio, nothing recorded.
 *
 * Off unless LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are set
 * (server .env, never git): the exam then simply runs without cameras.
 *
 * A LiveKit pass is a JWT signed with the API secret: issuer = the API key,
 * subject = the participant's identity, and a `video` grant naming the room
 * and what the holder may do (what livekit-server-sdk's AccessToken writes).
 */
const jwt = require("jsonwebtoken");

const configured = () => Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

const roomFor = (examId) => `exam-${examId}`;
// A student is the same participant whichever attempt they are on.
const studentIdentity = (userId) => `u-${userId}`;

function accessToken({ identity, name = "", room, video, ttlSec }) {
  return jwt.sign(
    {
      name: String(name || "").slice(0, 120),
      video: { room, roomJoin: true, canPublishData: false, ...video },
    },
    process.env.LIVEKIT_API_SECRET,
    {
      algorithm: "HS256",
      issuer: process.env.LIVEKIT_API_KEY,
      subject: identity,
      jwtid: identity,
      notBefore: 0,
      expiresIn: Math.max(60, Math.round(ttlSec)),
    }
  );
}

// A student taking the exam: may send their camera (and only a camera), sees no one.
function studentPass({ examId, userId, name, expiresAt }) {
  const left = expiresAt ? (new Date(expiresAt).getTime() - Date.now()) / 1000 : 3600;
  return accessToken({
    identity: studentIdentity(userId),
    name,
    room: roomFor(examId),
    video: { canPublish: true, canPublishSources: ["camera"], canSubscribe: false },
    ttlSec: Math.min(6 * 3600, Math.max(600, left + 600)),
  });
}

// The exam's teacher: watches every camera, hidden from the room, sends nothing.
function teacherPass({ examId, userId, name, tag }) {
  return accessToken({
    identity: `t-${userId}-${tag}`,
    name,
    room: roomFor(examId),
    video: { canPublish: false, canSubscribe: true, hidden: true },
    ttlSec: 4 * 3600,
  });
}

module.exports = { configured, roomFor, studentIdentity, accessToken, studentPass, teacherPass };
