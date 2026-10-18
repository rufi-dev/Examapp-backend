/*
 * Live exam cameras (owner, 2026-10-18: "in a live exam, open the students'
 * cameras and the teacher watches live"; "only if enabled in the settings";
 * "a student who doesn't open it can still take the exam, and the live exam
 * shows it as closed"), and voice (same day: "students' voice, which they can
 * close; the teacher answers one of them or speaks to all at once, and all
 * hear").
 *
 * The media goes through our own LiveKit server (Oracle, see the deploy notes),
 * never through this backend: here we only sign the passes. Nothing is recorded.
 * Each exam has TWO rooms, so a student can never see or hear another student:
 *  - the camera room `exam-<id>`: a student may SEND a camera and a microphone
 *    and receive nothing; the exam's teacher gets a hidden pass that may only
 *    watch and listen;
 *  - the voice room `exam-<id>-voice`: the teacher may SEND a microphone (and
 *    chooses who may hear it: everyone, or one student); students may only
 *    listen, hidden from each other.
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
const voiceRoomFor = (examId) => `exam-${examId}-voice`;
// A student is the same participant whichever attempt they are on.
const studentIdentity = (userId) => `u-${userId}`;
const teacherIdentity = (userId, tag) => `t-${userId}-${tag}`;

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

// As long as the attempt can run, plus a margin.
const attemptTtl = (expiresAt) => {
  const left = expiresAt ? (new Date(expiresAt).getTime() - Date.now()) / 1000 : 3600;
  return Math.min(6 * 3600, Math.max(600, left + 600));
};

// A student taking the exam: may send their camera and microphone (nothing else), sees and hears no one.
function studentPass({ examId, userId, name, expiresAt }) {
  return accessToken({
    identity: studentIdentity(userId),
    name,
    room: roomFor(examId),
    video: { canPublish: true, canPublishSources: ["camera", "microphone"], canSubscribe: false },
    ttlSec: attemptTtl(expiresAt),
  });
}

// A student taking the exam, in the voice room: only listens (to what a teacher lets them hear), unseen.
function studentListenPass({ examId, userId, name, expiresAt }) {
  return accessToken({
    identity: studentIdentity(userId),
    name,
    room: voiceRoomFor(examId),
    video: { canPublish: false, canSubscribe: true, hidden: true },
    ttlSec: attemptTtl(expiresAt),
  });
}

// The exam's teacher: watches and listens to every student, hidden from the room, sends nothing there.
function teacherPass({ examId, userId, name, tag }) {
  return accessToken({
    identity: teacherIdentity(userId, tag),
    name,
    room: roomFor(examId),
    video: { canPublish: false, canSubscribe: true, hidden: true },
    ttlSec: 4 * 3600,
  });
}

// The exam's teacher, in the voice room: may speak (a microphone only) and say whom to (its attributes).
function teacherTalkPass({ examId, userId, name, tag }) {
  return accessToken({
    identity: teacherIdentity(userId, tag),
    name,
    room: voiceRoomFor(examId),
    video: { canPublish: true, canPublishSources: ["microphone"], canSubscribe: false, canUpdateOwnMetadata: true },
    ttlSec: 4 * 3600,
  });
}

module.exports = { configured, roomFor, voiceRoomFor, studentIdentity, accessToken, studentPass, studentListenPass, teacherPass, teacherTalkPass };
