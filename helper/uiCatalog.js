/*
 * Every screen of the app and every control on it, for the chat's picture guides.
 *
 * Owner, 2026-10-13: the chat used to pick one of 56 hand-made guides, so a
 * question outside them got the nearest one's pictures ("how do I delete from
 * the bin" showed deleting an exam, "change my bio" showed the photo button).
 * Now the frontend's e2e/ui-catalog.spec.js photographs every screen state at
 * phone and desktop size and records every button, link, field, tab and switch
 * on it (data/ui-catalog.json). For each question this file finds the controls
 * that fit, the AI names the ones its answer describes, and the reply carries
 * [[steps:ID|ID|…]]: the chat card shows each one on its real screenshot with
 * the spotlight on it. An ID that is not in the catalogue is dropped, so the AI
 * cannot invent a step, and the way to a screen (the menu item, the button
 * that opens a dialog) is added here from how the capture reached it.
 *
 * Matching folds text to plain Latin letters and compares word stems, because
 * teachers type with and without Azerbaijani letters ("şifrə", "sifre") and
 * with suffixes ("qutusundan", "imtahanı").
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "ui-catalog.json");

const fold = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/i̇/g, "i")
    .replace(/ə/g, "e")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

const words = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

// Words of a question that say nothing about where to press.
const STOP = new Set(
  ("nece harada harda hara men mene menim bunu onu ve ile ucun olar olur edim edek edir edirem etmek etmeliyem " +
    "elemek eleyim edin zehmet olmasa salam sagol bir bu o da de ki ne niye mi mu hansi var yox ise bele cox " +
    "istiyirem isteyirem lazim kimi sonra evvel indi gore yene artiq hem amma ancaq lutfen xahis bilmirem bilerem " +
    "olsun oldu olmur alinmir isleyir islemir yaxsi necedir harasidir hesabi hesabim")
    .split(" "),
);

// Teachers' words for the app's words (folded). Each key adds its values.
const SYNONYMS = {
  bio: ["haqqimda", "haqqinda"], biom: ["haqqimda"], biomu: ["haqqimda"], haqqimda: ["bio"],
  parol: ["sifre"], parolu: ["sifre"], sifremi: ["sifre", "cari", "tehlukesizlik"], password: ["sifre"],
  wp: ["whatsapp"], vatsap: ["whatsapp"], whatsap: ["whatsapp"], wa: ["whatsapp"], votsap: ["whatsapp"],
  sinaq: ["imtahan"], test: ["imtahan", "sual"], testi: ["imtahan"], exam: ["imtahan"],
  korzina: ["zibil"], sebet: ["zibil"], silinmis: ["zibil", "qaytar"], silinen: ["zibil", "qaytar"],
  berpa: ["qaytar"], geri: ["qaytar"], qaytarim: ["qaytar"],
  poz: ["sil"], pozmaq: ["sil"], silim: ["sil"], silmek: ["sil"], silinsin: ["sil"],
  redakte: ["deyis", "duzelis"], duzelt: ["deyis", "duzelis", "redakte"], deyisim: ["deyis", "redakte"], deyisdirim: ["deyis"],
  foto: ["sekil"], fotom: ["sekil"], avatar: ["sekil"], sekli: ["sekil"], seklimi: ["sekil"],
  usaq: ["sagird"], telebe: ["sagird"], sagirdi: ["sagird"],
  ana: ["valideyn"], ata: ["valideyn"], valideyne: ["valideyn"],
  qrup: ["sinif"], qrupu: ["sinif"], sinfi: ["sinif"], sinfe: ["sinif"],
  cedvel: ["ders", "cedvel"], davamiyyet: ["davamiyyet", "qr"], yoxlama: ["davamiyyet", "yoxla"],
  pul: ["odenis"], odenisi: ["odenis"], kart: ["odenis"], aylik: ["odenis"],
  kod: ["kod", "devet", "link"], kodu: ["kod", "devet"], link: ["link", "devet", "paylas"], linki: ["link", "kopyala"],
  devet: ["devet"], qosmaq: ["devet", "elave"],
  upload: ["yukle"], yuklemek: ["yukle"], yuklim: ["yukle"], yukleyim: ["yukle"],
  gonder: ["paylas", "gonder"], gondermek: ["paylas", "gonder"], paylasim: ["paylas"],
  ev: ["tapsiriq"], tapsirig: ["tapsiriq"], odev: ["tapsiriq"],
  netice: ["netice"], bal: ["bal", "netice"], qiymet: ["qiymet", "bal"],
  vaxt: ["vaxt", "muddet"], muddet: ["muddet", "vaxt"], saat: ["vaxt"],
  gizlet: ["gizli", "gizlet"], gizle: ["gizli", "gizlet"],
  qaranliq: ["tema", "qaranliq"], tema: ["tema"], gece: ["tema", "qaranliq"],
  cix: ["cixis"], cixim: ["cixis"], cixmaq: ["cixis"],
  kredit: ["kredit"], paket: ["paket", "plan"], premium: ["premium", "paket"],
  doska: ["lovhe"], lovhe: ["lovhe"],
  material: ["material"], pdf: ["pdf", "senet", "yukle"], video: ["video"],
  plan: ["plan"], studiya: ["studiya"], nailiyyet: ["nailiyyet"],
  canli: ["canli"], izle: ["izle", "canli"],
  qaristir: ["qaristir"], variant: ["variant"], cehd: ["cehd"], kocurme: ["kocurme", "qoruma"],
  ad: ["ad"], adimi: ["ad"], telefon: ["telefon", "nomre"], nomre: ["telefon", "nomre"],
  // Making something is «Yeni …» or «… əlavə et» in the app.
  yarat: ["yarat", "yeni", "elave"], yaradim: ["yarat", "yeni", "elave"], yaratmaq: ["yarat", "yeni", "elave"], yaradiram: ["yeni", "elave"],
  yaradilir: ["yeni", "elave"], qurum: ["yeni", "elave"], acim: ["ac", "yeni", "elave"], elave: ["elave", "yeni"],
  ver: ["yeni", "elave", "ver"], verim: ["yeni", "elave", "ver"], vermek: ["yeni", "elave", "ver"],
  qoy: ["qoy", "elave"], qoyum: ["qoy", "elave"], qoymaq: ["qoy", "elave"],
  qr: ["qr"], ai: ["ai"], alim: ["kredit"], almaq: ["kredit"],
  qiymetlendir: ["qiymet", "yoxla", "bal"], qiymetlendirim: ["qiymet", "yoxla", "bal"], yoxlayim: ["yoxla"],
  bildiris: ["bildiris"], bildirisler: ["bildiris"],
};

// Phrases a word list misses.
const PHRASES = [
  [/\bb\s*-?\s*variant/, ["nusxe", "variant"]],
  [/\bqaranliq\b|\bgece rejim/, ["qaranliq", "tema"]],
];

/*
 * Verbs say what to do, nouns say where. "Biomu necə dəyişim" is about the bio,
 * not about every «Dəyiş» button, so a verb counts less than the thing it acts
 * on; it still decides between the controls of one screen ("sil" vs "qaytar").
 */
const VERBS = ["deyis", "redakte", "duzelis", "sil", "elave", "yarat", "yaradi", "ac", "bax", "gor", "yukle", "paylas", "gonder", "sec", "yaz", "et", "duzelt", "hazirla", "qos", "kopyala", "goster"];
const isVerb = (w) => VERBS.some((v) => sameStem(w, v));

// The menu and the top bar are on every page: nothing has to be opened first.
const EVERYWHERE = { nav: "Menyu (hər səhifədə)", snav: "Şagirdin menyusu (hər səhifədə)", top: "Yuxarı panel (hər səhifədə)", stop: "Şagirdin yuxarı paneli (hər səhifədə)" };

const KIND = {
  nav: "menyu bəndi", button: "düymə", link: "keçid", tab: "sekmə", field: "xana",
  toggle: "açar/seçim", select: "siyahı", file: "fayl seçimi",
};

let cache = null;
function load(file = FILE) {
  if (cache && cache.file === file) return cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    raw = { states: {}, elements: {} };
  }
  cache = index(raw);
  cache.file = file;
  return cache;
}

// For tests and for a catalogue handed over in memory.
function index(raw) {
  const states = raw.states || {};
  const elements = raw.elements || {};
  const ids = Object.keys(elements);
  const stateOf = (id) => elements[id]?.m?.state || elements[id]?.d?.state || null;

  // The control a screen is opened by: [scope, regex] in the capture → an element id.
  const resolve = ([scope, source]) => {
    let re;
    try {
      re = new RegExp(source);
    } catch {
      return null;
    }
    const hits = ids.filter((id) => elements[id].scope === scope && re.test(elements[id].label));
    return hits.find((id) => elements[id].m && elements[id].d) || hits[0] || null;
  };
  const entry = {}; // state → the element that opens it (the first way the capture took)
  const entries = {}; // state → every element known to open it
  const leads = {}; // element → the state it opens
  for (const [sid, st] of Object.entries(states)) {
    for (const v of st.via || []) {
      const el = resolve(v);
      if (!el) continue;
      if (!entry[sid]) entry[sid] = el;
      (entries[sid] ||= []).push(el);
      if (!leads[el]) leads[el] = sid;
    }
  }
  // The clicks from the start (the menu) to a screen, without loops.
  const pathTo = (sid, seen = new Set()) => {
    if (!sid || seen.has(sid) || seen.size > 8) return [];
    seen.add(sid);
    const el = entry[sid];
    if (!el) return [];
    // Opened from the menu or the top bar: those are on every page.
    if (EVERYWHERE[elements[el].scope]) return [el];
    return [...pathTo(stateOf(el), seen), el];
  };

  // Search documents: the label counts most, then the screen's title, then the
  // heading it sits under and the way to the screen.
  const docs = ids.map((id) => {
    const e = elements[id];
    const st = states[stateOf(id)] || {};
    const way = pathTo(stateOf(id)).map((x) => elements[x]?.label || "").join(" ");
    return {
      id,
      fields: [
        [3, words(e.label)],
        [2, words(st.title)],
        [1, words(e.context)],
        [1, words(way)],
      ],
    };
  });
  const df = new Map();
  for (const d of docs) {
    for (const w of new Set(d.fields.flatMap(([, ws]) => ws))) df.set(w, (df.get(w) || 0) + 1);
  }
  return { raw, states, elements, ids, stateOf, entry, entries, leads, pathTo, docs, df, n: docs.length || 1 };
}

// A question word and a catalogue word are the same word with different endings.
// A 3-letter word only takes a short ending: "silim" is "sil", "silinmiş"
// (deleted) is not.
function sameStem(q, w) {
  if (q === w) return true;
  const short = Math.min(q.length, w.length);
  const long = Math.max(q.length, w.length);
  if ((short >= 4 || (short === 3 && long - short <= 3)) && (w.startsWith(q) || q.startsWith(w))) return true;
  let i = 0;
  while (i < short && q[i] === w[i]) i += 1;
  return i >= 5;
}

// Each word of the question with the app's words for it: one group per word,
// so a word with three synonyms still counts once.
function queryGroups(text) {
  const groups = [];
  const seen = new Set();
  const folded = fold(text);
  for (const [re, add] of PHRASES) if (re.test(folded)) groups.push(add);
  for (const w of words(text)) {
    if (seen.has(w)) continue;
    seen.add(w);
    const own = !STOP.has(w) && w.length >= 3 ? [w] : [];
    // The app's words for any form of it ("vaxtını" → vaxt → müddət).
    const syn = SYNONYMS[w] || (w.length >= 4 ? Object.entries(SYNONYMS).filter(([k]) => k.length >= 3 && sameStem(w, k)).flatMap(([, v]) => v) : []);
    const group = [...new Set([...own, ...syn])];
    if (group.length) groups.push(group);
  }
  return groups;
}
const queryWords = (text) => [...new Set(queryGroups(text).flat())];

/*
 * The controls that fit a question, best first. Each question word adds the
 * rarest catalogue word it matches, weighted by where that word sits.
 */
const ABOUT_STUDENTS = ["sagird", "usaq", "telebe", "valideyn"];

function search(text, { limit = 40, cat = load() } = {}) {
  const q = queryGroups(text);
  if (!q.length) return [];
  /*
   * How rare a question word is, counted over every form of it: "imtahan",
   * "imtahanı", "imtahanlara" are one common word, so they weigh little next
   * to "vaxt" or "bio".
   */
  // A word and its synonyms are one word: one rarity for the group.
  const idfOf = q.map((group) => {
    let n = 0;
    for (const d of cat.docs) if (d.fields.some(([, ws]) => ws.some((w) => group.some((qw) => sameStem(qw, w))))) n += 1;
    return Math.log(1 + cat.n / (n || 1));
  });
  // The chat is for teachers: the student's and the signed-out screens come
  // second unless the question is about them.
  const aboutStudents = q.flat().some((w) => ABOUT_STUDENTS.some((s) => sameStem(w, s)));
  const scored = [];
  /*
   * Two parts: the control itself (its label, the heading it sits under) and
   * its screen (the screen's title, the way there). The screen part decides
   * WHERE, the control part WHICH ONE, so the screen counts for less: a
   * screen described as "ad, telefon, haqqımda" must not make every control
   * on it answer "bio". A search box («Zibil qutusunda axtar») is where you
   * look, not what you do, unless the question is about searching.
   */
  const aboutSearch = q.flat().some((w) => ["axtar", "axtaris", "tap"].some((s) => sameStem(w, s)));
  for (const d of cat.docs) {
    let control = 0;
    let screen = 0;
    let hits = 0;
    const [label, title, context, way] = d.fields.map(([, ws]) => ws);
    for (const [gi, group] of q.entries()) {
      let c = 0;
      let sc = 0;
      for (const qw of group) {
        const k = (isVerb(qw) ? 0.55 : 1) * idfOf[gi];
        const has = (ws) => ws.some((w) => sameStem(qw, w));
        if (has(label)) c = Math.max(c, 3 * k);
        if (has(context)) c = Math.max(c, 1 * k);
        if (has(title)) sc = Math.max(sc, 2 * k);
        if (has(way)) sc = Math.max(sc, 1 * k);
      }
      if (c || sc) hits += 1;
      control += c;
      screen += sc;
    }
    const searchBox = !aboutSearch && cat.elements[d.id].kind === "field" && label.some((w) => sameStem(w, "axtar"));
    const score = (control + 0.6 * screen) * (searchBox ? 0.4 : 1);
    if (score <= 0) continue;
    const as = cat.states[cat.stateOf(d.id)]?.as;
    const side = as === "student" && !aboutStudents ? 0.6 : as === "guest" ? 0.8 : 1;
    scored.push({ id: d.id, score: score * (1 + 0.25 * Math.max(0, hits - 1)) * side });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

/*
 * The list the AI chooses from: the best controls, plus every control on the
 * two best screens (so a question about a screen sees all of it), grouped by
 * screen with the way there.
 */
function candidatesFor(text, { cat = load(), limit = 40, cap = 110 } = {}) {
  const top = search(text, { cat, limit });
  if (!top.length) return "";
  const byState = new Map();
  for (const { id, score } of top) {
    const s = cat.stateOf(id);
    byState.set(s, (byState.get(s) || 0) + score);
  }
  const bestStates = [...byState.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s]) => s);
  const chosen = new Set(top.map((t) => t.id));
  for (const s of bestStates) for (const id of cat.ids) if (cat.stateOf(id) === s) chosen.add(id);
  const list = [...chosen].slice(0, cap);
  const groups = new Map();
  for (const id of list) {
    const scope = cat.elements[id].scope;
    const s = EVERYWHERE[scope] ? `@${scope}` : cat.stateOf(id);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(id);
  }
  const lines = [];
  for (const [s, ids] of groups) {
    if (s.startsWith("@")) {
      lines.push(`• ${EVERYWHERE[s.slice(1)]}`);
    } else {
      const st = cat.states[s] || {};
      const way = cat.pathTo(s).map((x) => `«${cat.elements[x].label}»`).join(" → ");
      lines.push(`• Ekran: ${st.title || s}${st.as === "student" ? " (şagird görür)" : st.as === "guest" ? " (giriş etməmiş)" : ""}${way ? ` — yol: ${way}` : ""}`);
    }
    const st = cat.states[cat.stateOf(ids[0])] || {};
    for (const id of ids) {
      const e = cat.elements[id];
      const only = e.m && !e.d ? " · yalnız telefonda" : e.d && !e.m ? " · yalnız kompüterdə" : "";
      const ctx = e.context && e.context !== st.title ? ` · «${e.context}» altında` : "";
      lines.push(`  ${id} — «${e.label}» (${KIND[e.kind] || e.kind})${ctx}${only}`);
    }
  }
  return lines.join("\n");
}

/*
 * The AI's [[steps:…]] made safe and complete: unknown IDs dropped, and before
 * each control the clicks that reach its screen from where the guide already is.
 */
function expandSteps(targets, { cat = load() } = {}) {
  const steps = [];
  let here = null;
  const push = (id) => {
    if (steps[steps.length - 1] !== id) steps.push(id);
  };
  for (const t of targets) {
    if (!cat.elements[t]) continue;
    const s = cat.stateOf(t);
    // A screen with an entrance right where the guide is (the results list's
    // exam link to its results) is one click away, not the long way round.
    const near = s !== here && (cat.entries[s] || []).find((el) => cat.stateOf(el) === here);
    if (near) push(near);
    else if (s !== here && !EVERYWHERE[cat.elements[t].scope]) {
      const way = cat.pathTo(s);
      let from = -1;
      for (let i = way.length - 1; i >= 0; i -= 1) {
        if (cat.stateOf(way[i]) === here) {
          from = i;
          break;
        }
      }
      (from >= 0 ? way.slice(from) : way).forEach(push);
    }
    push(t);
    here = cat.leads[t] || s;
  }
  return steps.slice(0, 8);
}

const STEPS_RE = /\[\[steps:([^\]]*)\]\]/g;

// Every [[steps:…]] in a reply rebuilt from the catalogue; one left empty goes.
function fixSteps(text, { cat = load() } = {}) {
  let first = true;
  return String(text || "")
    .replace(STEPS_RE, (_, body) => {
      if (!first) return "";
      const ids = body.split(/[|,\s]+/).map((x) => x.trim()).filter(Boolean);
      const steps = expandSteps(ids, { cat });
      if (!steps.length) return "";
      first = false;
      return `[[steps:${steps.join("|")}]]`;
    })
    .replace(/\[\[guide:[a-z-]+\]\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A ready marker for server-written messages (the welcome); "" if the catalogue lacks them.
function stepsMarker(targets, { cat = load() } = {}) {
  const steps = expandSteps(targets, { cat });
  return steps.length && targets.every((t) => cat.elements[t]) ? `[[steps:${steps.join("|")}]]` : "";
}

function hasCatalog(cat = load()) {
  return cat.ids.length > 0;
}

module.exports = { FILE, fold, load, index, search, candidatesFor, expandSteps, fixSteps, stepsMarker, hasCatalog, sameStem, queryWords };
