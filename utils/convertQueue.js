// A queue in front of LibreOffice.
//
// Each conversion spawns a headless soffice process that may run for up to two
// minutes. Nothing stopped ten of them starting at once, which on a single
// container means the CPU is gone and every other request — including exams
// being submitted — waits behind them.
//
// Global concurrency 1, and per-user concurrency 1 as well, so one teacher
// cannot occupy the whole queue with a batch upload while others wait. Waiting
// is bounded: past the cap a job is refused outright rather than queued for
// minutes behind work the teacher can no longer see the point of.
const GLOBAL_CONCURRENCY = Number(process.env.CONVERT_CONCURRENCY || 1);
const PER_USER_CONCURRENCY = Number(process.env.CONVERT_PER_USER || 1);
const MAX_WAITING = Number(process.env.CONVERT_MAX_QUEUE || 20);

const waiting = []; // { userId, run, resolve, reject }
let active = 0;
const activeByUser = new Map(); // userId -> count

const activeFor = (id) => activeByUser.get(id) || 0;

// Who ran last, so a batch upload does not monopolise the queue. With a global
// concurrency of one the per-user limit never actually binds — a job always
// finishes before the next is picked — so strict FIFO would make a teacher
// uploading ten files delay everyone behind them by ten conversions. Taking
// turns costs nothing and bounds the wait to one job per other teacher.
let lastUserServed = null;

function pump() {
  if (active >= GLOBAL_CONCURRENCY) return;
  const eligible = (j) => activeFor(j.userId) < PER_USER_CONCURRENCY;
  // Prefer someone other than whoever just ran; fall back to plain order.
  let idx = waiting.findIndex((j) => eligible(j) && j.userId !== lastUserServed);
  if (idx === -1) idx = waiting.findIndex(eligible);
  if (idx === -1) return;
  const job = waiting.splice(idx, 1)[0];
  lastUserServed = job.userId;

  active += 1;
  activeByUser.set(job.userId, activeFor(job.userId) + 1);

  Promise.resolve()
    .then(job.run)
    .then(job.resolve, job.reject)
    .finally(() => {
      active -= 1;
      const n = activeFor(job.userId) - 1;
      if (n > 0) activeByUser.set(job.userId, n);
      else activeByUser.delete(job.userId);
      pump();
    });
}

// Runs `fn` when a slot frees up. Rejects immediately if the queue is full.
function enqueueConversion(userId, fn) {
  return new Promise((resolve, reject) => {
    if (waiting.length >= MAX_WAITING) {
      return reject(
        new Error("Server hazırda çox sayda fayl çevirir. Bir neçə dəqiqədən sonra cəhd edin.")
      );
    }
    waiting.push({ userId: String(userId), run: fn, resolve, reject });
    pump();
  });
}

const queueStats = () => ({ active, waiting: waiting.length });

module.exports = { enqueueConversion, queueStats };
