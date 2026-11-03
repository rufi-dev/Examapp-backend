/*
 * Month arithmetic for billing dates, in UTC.
 */

// Same day n months on; the 31st becomes the month's last day, never the 1st after.
function addMonths(date, n = 1) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

// The first monthly date after `now`, counting on from `from`.
function nextAfter(from, now) {
  let next = addMonths(from, 1);
  let guard = 0;
  while (next <= now && guard++ < 240) next = addMonths(next, 1);
  return next;
}

/*
 * The next monthly date of a yearly plan: its billing day, the month after now.
 * Counted back from the period's end (one step each from the original date, so a
 * 31st does not drift to the 28th), and never past that end.
 */
function nextMonthlyBefore(periodEnd, now) {
  const end = new Date(periodEnd);
  let next = end;
  for (let k = 1; k <= 12; k++) {
    const earlier = addMonths(end, -k);
    if (earlier <= now) break;
    next = earlier;
  }
  return next;
}

module.exports = { addMonths, nextAfter, nextMonthlyBefore };
