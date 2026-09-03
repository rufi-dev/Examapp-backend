/*
 * What changed in Examopia, in the order it shipped.
 *
 * This is a FILE, not a database collection, and deliberately so: an update is
 * announced by the same deploy that delivers it. Writing the entry is part of
 * shipping the change, the two can never disagree about what is live, and there is
 * no admin screen to keep in sync with reality. Rolling a release back rolls its
 * announcement back with it.
 *
 * Side-effect free — no requires, no environment — so it can be imported anywhere,
 * including a test that renders the list without a database.
 *
 * FIELDS
 *   id          stable, never reused. A teacher's "seen" mark is a DATE, but the
 *               id is what the UI keys on, so renaming one re-announces nothing.
 *   publishedAt ISO date. Ordering and the seen/unseen cut both come from this.
 *   kind        feature | improvement | fix — drives the label and the colour.
 *   title       what it is, in the teacher's words.
 *   summary     one or two sentences. What it does FOR THEM, not how it works.
 *   where       the click path, so the announcement ends somewhere they can go.
 *   to          an in-app link, when there is one worth offering.
 *   scene       key of the animation that shows it. See Frontend
 *               src/config/updateScenes.jsx — an entry with no matching scene
 *               falls back to a plain card rather than breaking the page.
 */

const PRODUCT_UPDATES = [
  {
    id: "sidebar-rail",
    publishedAt: "2026-09-03",
    kind: "improvement",
    title: "Yan menyunu yığmaq olur",
    summary:
      "Menyu çox yer tutursa, onu bir kliklə nazik zolağa yığın — yalnız ikonlar qalır. Seçiminiz yadda saxlanılır.",
    where: "Yan menyunun yuxarısındakı « düyməsi",
    scene: "sidebarRail",
  },
  {
    id: "lesson-plan-edit",
    publishedAt: "2026-09-03",
    kind: "improvement",
    title: "Dərs planının hər sahəsini dəyişmək olur",
    summary:
      "Başlıq, mövzu, fənn, sinif və dərsin müddəti artıq birbaşa redaktə olunur — AI işlətmir, kredit xərcləmir. Müddəti dəyişsəniz, AI mərhələlərin dəqiqələrini yenidən bölüşdürür.",
    where: "Dərs planı → Planı redaktə et",
    to: "/ders-planlari",
    scene: "planEdit",
  },
  {
    id: "worksheet-variant-pdf",
    publishedAt: "2026-09-03",
    kind: "feature",
    title: "Hər iş vərəqi ayrıca çap olunur",
    summary:
      "A və B vərəqlərinin hər birinin öz PDF düyməsi var. Yalnız tapşırıqlar, ad-soyad xanası və yazı üçün xətlər çıxır — cavablar olmur, ona görə birbaşa şagirdə paylaya bilərsiniz.",
    where: "Dərs planı → variantın başlığındakı PDF düyməsi",
    to: "/ders-planlari",
    scene: "variantPdf",
  },
  {
    id: "mso-analytic-table",
    publishedAt: "2026-09-03",
    kind: "feature",
    title: "Summativ üçün analitik cədvəl",
    summary:
      "Summativ presetlə hazırlanan imtahanın analitik cədvəli bir kliklə PDF olur: hər tapşırığın dərslikdəki səhifəsi və nömrəsi, alt-standartı, qiymətləndirmə meyarı, nəyi yoxladığı və balı.",
    where: "İmtahan kartı → ⋯ → Analitik cədvəl",
    scene: "analyticTable",
  },
  {
    id: "exam-ab-variants",
    publishedAt: "2026-09-02",
    kind: "feature",
    title: "İmtahanın nüsxəsi və B variantı",
    summary:
      "Bir imtahandan iki vərəq: eyni nüsxə (dərhal, AI işlətmədən) və ya B variantı — eyni tip, eyni bacarıq, eyni çətinlik, amma sual yenidir və cavab açarı da yenilənir. Yan-yana oturan şagirdlər üçün.",
    where: "İmtahan kartı → ⋯ → Nüsxə / B variantı",
    scene: "examVariants",
  },
];

// Newest first. Sorting here rather than trusting the file's order means an entry
// added in the wrong place still appears where it belongs.
const updatesNewestFirst = () =>
  [...PRODUCT_UPDATES].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));

// The newest publish date, used to stamp a brand-new account as already caught up.
const latestPublishedAt = () => {
  const [newest] = updatesNewestFirst();
  return newest ? new Date(newest.publishedAt) : null;
};

/*
 * Unseen = published after the mark. A user with NO mark at all is an account that
 * predates this feature, and they see everything — which is the point: they are
 * exactly the people who have been using the product and missed the changes.
 */
const unseenFor = (seenAt) => {
  const list = updatesNewestFirst();
  if (!seenAt) return list;
  const mark = new Date(seenAt);
  if (Number.isNaN(mark.getTime())) return list;
  return list.filter((u) => new Date(u.publishedAt) > mark);
};

module.exports = { PRODUCT_UPDATES, updatesNewestFirst, latestPublishedAt, unseenFor };
