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
    title: "Ekranda daha çox yer",
    summary:
      "Menyunu bir kliklə nazik zolağa yığın. İş sahəniz genişlənir, menyu isə əl altında qalır.",
    where: "Yan menyunun yuxarısındakı « düyməsi",
    scene: "sidebarRail",
  },
  {
    id: "lesson-plan-edit",
    publishedAt: "2026-09-03",
    kind: "improvement",
    title: "Planı özünüz düzəldin — kredit xərcləmədən",
    summary:
      "Başlığı və ya müddəti dəyişmək üçün artıq AI-a müraciət etmək lazım deyil. Müddəti dəyişəndə mərhələlərin dəqiqələrini AI özü uyğunlaşdırır.",
    where: "Dərs planı → Planı redaktə et",
    to: "/ders-planlari",
    scene: "planEdit",
  },
  {
    id: "worksheet-variant-pdf",
    publishedAt: "2026-09-03",
    kind: "feature",
    title: "Çap edin, birbaşa şagirdə verin",
    summary:
      "Hər variantın öz PDF düyməsi var. Cavabsız, ad-soyad xanası və yazı xətləri ilə — printerdən birbaşa masaya.",
    where: "Dərs planı → variantın başlığındakı PDF düyməsi",
    to: "/ders-planlari",
    scene: "variantPdf",
  },
  {
    id: "mso-analytic-table",
    publishedAt: "2026-09-03",
    kind: "feature",
    title: "Analitik cədvəl artıq özü yazılır",
    summary:
      "Saatlarla əl ilə doldurduğunuz cədvəl bir kliklə hazır PDF olur — hər tapşırığın səhifəsi, alt-standartı, meyarı və balı yerində.",
    where: "İmtahan kartı → ⋯ → Analitik cədvəl",
    scene: "analyticTable",
  },
  {
    id: "lesson-plan",
    publishedAt: "2026-09-01",
    kind: "feature",
    title: "Dərs planı — mövzunu yazın, qalanını AI yazsın",
    summary:
      "Məqsədlər, qiymətləndirmə meyarları, dərsin mərhələləri dəqiqələri ilə, tapşırıqlar və hər birinin addım-addım həlli. Dərslik fəslini bağlasanız, tapşırıqlar oradan götürülür və səhifə nömrəsi ilə göstərilir.",
    where: "Yan menyu → Tədris → Dərs planı",
    to: "/ders-planlari",
    scene: "lessonPlan",
  },
  {
    id: "exam-ab-variants",
    publishedAt: "2026-09-02",
    kind: "feature",
    title: "Yanaşı oturanlar üçün iki vərəq",
    summary:
      "Bir imtahandan A və B variantı. Eyni mövzu, eyni çətinlik, başqa suallar — köçürmək mümkün olmur.",
    where: "İmtahan kartı → ⋯ → Nüsxə / B variantı",
    scene: "examVariants",
  },
  {
    id: "result-explain-mode",
    publishedAt: "2026-09-12",
    kind: "feature",
    title: "Nəticənin üzərində izah edin",
    summary:
      "Şagirdin cavablarını açın, «İzah et» düyməsinə basın və düz ekranda cızın, yazın, fiqur çəkin — ekranı paylaşarkən səhvi göstərmək üçün. Saxlasanız, şagird öz telefonunda da eyni izahı görür.",
    where: "Nəticə → Cavabların təhlili → İzah et",
    scene: "resultExplain",
  },
  {
    id: "studio-credits",
    publishedAt: "2026-09-12",
    kind: "improvement",
    title: "Dərs studiyası kreditlə işləyir",
    summary:
      "Studiyada material yaratmaq 6, dəyişmək 2 kredit sərf edir — eyni kreditlər, yuxarıdakı balansdan. Qiymət düymənin üstündə yazılır; kredit çatmırsa heç nə başlamır və heç nə sərf olunmur.",
    where: "Dərs studiyası → göndər düyməsi · Planım → AI kredit sərfi",
    scene: "studioCredits",
  },
  {
    id: "studio-live-progress",
    publishedAt: "2026-09-12",
    kind: "improvement",
    title: "Studiya nə etdiyini canlı göstərir",
    summary:
      "İndi hər addım göründüyü kimi yazılır: hansı faylı oxuyur, neçənci səhifəni aldı, sənədi yoxlamaq üçün PDF-ə çevirir, nəyi düzəldir. Həm də daha sürətli və daha ucuz — düzəliş üçün bütün sənəd yenidən yazılmır, yalnız dəyişən hissə.",
    where: "Dərs studiyası → «Nə etdiyimi göstər»",
    scene: "studioLive",
  }
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
