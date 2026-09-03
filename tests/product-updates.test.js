/*
 * The changelog.
 *
 * Two properties carry the whole feature. First, a teacher who has already read an
 * announcement must never be shown it again — a "what's new" dialog that reappears
 * is worse than none at all, because it trains people to dismiss it unread. Second,
 * a brand-new sign-up must see NOTHING: they never used the old version, so a
 * backlog of announcements about it is noise.
 *
 * Pure data and pure functions, no DB.
 */
const assert = require("assert");
const u = require("../config/productUpdates");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

console.log("\n1. The manifest is well-formed:");
{
  const list = u.PRODUCT_UPDATES;
  ok("there are entries", list.length > 0);

  const ids = list.map((x) => x.id);
  ok("ids are unique", new Set(ids).size === ids.length, ids.join(","));
  ok("ids are url-safe slugs", ids.every((id) => /^[a-z0-9-]+$/.test(id)), ids.join(","));

  const KINDS = new Set(["feature", "improvement", "fix"]);
  for (const e of list) {
    ok(`${e.id}: has a title`, Boolean(e.title && e.title.trim()));
    ok(`${e.id}: has a summary`, Boolean(e.summary && e.summary.trim()));
    // An announcement that does not say where to go leaves the teacher no better
    // off than not knowing about the change.
    ok(`${e.id}: says where to find it`, Boolean(e.where && e.where.trim()));
    ok(`${e.id}: has a known kind`, KINDS.has(e.kind), e.kind);
    ok(`${e.id}: has a scene`, Boolean(e.scene));
    ok(`${e.id}: date parses`, !Number.isNaN(new Date(e.publishedAt).getTime()), e.publishedAt);
    ok(`${e.id}: date is ISO yyyy-mm-dd`, /^\d{4}-\d{2}-\d{2}$/.test(e.publishedAt), e.publishedAt);
  }
}

console.log("\n2. Newest first, whatever order the file is in:");
{
  const dates = u.updatesNewestFirst().map((x) => x.publishedAt);
  const sorted = [...dates].sort().reverse();
  ok("sorted descending by date", JSON.stringify(dates) === JSON.stringify(sorted), dates.join(","));
  ok("nothing is dropped", u.updatesNewestFirst().length === u.PRODUCT_UPDATES.length);
  ok("the newest date is exposed",
    u.latestPublishedAt().toISOString().slice(0, 10) === sorted[0], String(u.latestPublishedAt()));
}

console.log("\n3. Who sees what:");
{
  // An account from before the feature existed: everything is news.
  ok("no mark ⇒ everything is unseen", u.unseenFor(null).length === u.PRODUCT_UPDATES.length);
  ok("undefined behaves the same", u.unseenFor(undefined).length === u.PRODUCT_UPDATES.length);
  ok("junk does not hide updates", u.unseenFor("not a date").length === u.PRODUCT_UPDATES.length);

  // Caught up: nothing at all. This is the property that stops the dialog nagging.
  ok("marked now ⇒ nothing unseen", u.unseenFor(new Date()).length === 0);
  ok("marked at the newest publish date ⇒ nothing unseen",
    u.unseenFor(u.latestPublishedAt()).length === 0, JSON.stringify(u.unseenFor(u.latestPublishedAt()).map((x) => x.id)));

  // Partially read: only what shipped afterwards.
  const all = u.updatesNewestFirst();
  const oldest = all[all.length - 1];
  const cut = u.unseenFor(oldest.publishedAt);
  ok("marked at the oldest entry ⇒ that one is seen", !cut.some((x) => x.id === oldest.id));
  ok("and the newer ones are not", cut.length === all.length - all.filter((x) => x.publishedAt <= oldest.publishedAt).length,
    `${cut.length} of ${all.length}`);
  ok("the unseen slice keeps newest-first order",
    JSON.stringify(cut.map((x) => x.publishedAt)) === JSON.stringify([...cut.map((x) => x.publishedAt)].sort().reverse()));

  // A future mark must not resurrect anything.
  const future = new Date(Date.now() + 86400000 * 365);
  ok("a mark in the future ⇒ nothing unseen", u.unseenFor(future).length === 0);
}

console.log("\n4. It is pure data — importable anywhere:");
{
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "../config/productUpdates.js"), "utf8");
  // No requires and no env: a changelog that needs a database to describe itself
  // cannot be rendered by a test, or by a page, without one.
  ok("requires nothing", !/\brequire\s*\(/.test(src));
  ok("reads no environment", !/process\.env/.test(src));

  const ctl = fs.readFileSync(path.join(__dirname, "../controllers/updatesController.js"), "utf8");
  ok("the mark uses the publish date, not the clock", /latestPublishedAt\(\)/.test(ctl));
  ok("and never moves backwards", /current > mark \? current : mark/.test(ctl));

  const route = fs.readFileSync(path.join(__dirname, "../routes/updatesRoute.js"), "utf8");
  ok("both routes are behind protect", (route.match(/protect/g) || []).length >= 2);

  const users = fs.readFileSync(path.join(__dirname, "../controllers/userController.js"), "utf8");
  // Both sign-up paths, or a Google sign-up gets a backlog the email one does not.
  ok("every sign-up path starts caught up", (users.match(/updatesSeenAt: new Date\(\)/g) || []).length === 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} product-updates assertions failed`);
process.exit(failed ? 1 : 0);
