// ─────────────────────────────────────────────────────────────────────────────
// School-type diagnostic (READ-ONLY, no writes to the dashboard).
// Pulls Q63 "What school / learning centre does your child attend" free-text
// across all four language surveys, classifies each into a simple five-way type
// by name prefix, and writes a report so we can judge whether school-type is
// recoverable before any pipeline integration.
//
// Run as a GitHub Action (needs SM_MCP_TOKEN). Outputs school-diagnostic.json.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");

const SURVEYS = {
  English:  "422468336",
  Malay:    "422521738",
  Mandarin: "527473275",
  Tamil:    "422521746",
};
const SM_BASE  = "https://api.surveymonkey.com/v3";
const SM_TOKEN = process.env.SM_MCP_TOKEN;
const OUTPUT   = "school-diagnostic.json";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _last = 0;
async function smGet(path) {
  const wait = 600 - (Date.now() - _last);
  if (wait > 0) await sleep(wait);
  _last = Date.now();
  const res = await fetch(SM_BASE + path, { headers: { Authorization: `Bearer ${SM_TOKEN}`, Accept: "application/json" } });
  if (res.status === 429) { await sleep(8000); return smGet(path); }
  if (!res.ok) throw new Error(`SM ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// Build a question map for a survey (id -> {heading, family, position})
async function getQMap(surveyId) {
  const details = await smGet(`/surveys/${surveyId}/details`);
  const qmap = {};
  let pos = 0;
  for (const page of (details.pages || [])) {
    for (const q of (page.questions || [])) {
      const heading = (q.headings && q.headings[0] && q.headings[0].heading) || "";
      qmap[q.id] = { heading: heading.replace(/<[^>]+>/g, "").trim(), family: q.family, pos };
      pos++;
    }
  }
  return qmap;
}

// Detect the school-name question by heading (multilingual, content-anchored).
function findSchoolQ(qmap) {
  for (const [qid, q] of Object.entries(qmap)) {
    const h = (q.heading || "").toLowerCase();
    if (/school.*learning centre|learning centre.*attend|full name of the school|what school|nama.*sekolah|sekolah.*pusat pembelajaran|pusat pembelajaran|哪一所学校|学校.*名称|就读.*学校|பள்ளி.*பெயர்|கற்றல் மையம்/i.test(h)
        && /open|text|single|essay|comment/i.test(q.family || "single")) {
      return qid;
    }
  }
  // fallback: any open-text question mentioning school
  for (const [qid, q] of Object.entries(qmap)) {
    const h = (q.heading || "").toLowerCase();
    if (/school|sekolah|学校|பள்ளி/.test(h) && /open|text|essay/i.test(q.family || "")) return qid;
  }
  return null;
}

// ── Five-way classifier ──────────────────────────────────────────────────────
// national | chinese_medium | tamil_medium | private_international | learning_centre
function classifySchool(raw) {
  if (!raw) return "blank";
  let t = String(raw).trim().toLowerCase();
  if (!t || /^(n\/?a|na|nil|none|-|\.|tiada|tak ada|takde|没有|无|不适用|not attending|not applicable)$/i.test(t)) return "blank";

  // normalise punctuation/spacing
  t = t.replace(/[.]/g, "").replace(/\s+/g, " ").trim();

  // Chinese-medium: SJK(C) / SRJK(C) / SMJK / 华小 / 国民型华文
  if (/sjk\s*\(?c\)?|srjk\s*\(?c\)?|s[rj]k c|smjk|华小|华文小学|华中|国民型.*华|chinese (primary|school|medium)|kebangsaan cina|jenis kebangsaan.*cina|\(c\)/i.test(t)) return "chinese_medium";

  // Tamil-medium: SJK(T) / தமிழ் / Tamil school
  if (/sjk\s*\(?t\)?|srjk\s*\(?t\)?|s[rj]k t|தமிழ்|tamil (primary|school|medium)|kebangsaan tamil|jenis kebangsaan.*tamil|\(t\)/i.test(t)) return "tamil_medium";

  // Private / international / homeschool / college
  if (/international|private|independent|homeschool|home school|persendirian|antarabangsa|swasta|college|kolej|academy|akademi|international school|\bisp\b|smart reader|montessori|tadika swasta/i.test(t)) return "private_international";

  // Learning centre / refugee / non-formal / NGO centres
  if (/learning centre|learning center|pusat pembelajaran|refugee|rohingya|madrasah|pusat|centre|center|tuition|tadika|kindergarten|pra ?sekolah|preschool|nursery|childcare|taska|学习中心|难民|dnata|realm|elom|acr|unhcr/i.test(t)) return "learning_centre";

  // National (Malay-medium): SK / SRK / SMK / SMKA / sekolah kebangsaan / sekolah menengah
  if (/\bsk\b|\bsrk\b|\bsmk\b|\bsmka\b|\bsbp\b|\bmrsm\b|sekolah kebangsaan|sekolah menengah kebangsaan|sekolah rendah|sekolah agama|maktab|国民学校|国民中学|kebangsaan/i.test(t)) return "national";

  // Heuristic: starts with common national prefixes even if noisy
  if (/^s[mk]k?\b/i.test(t)) return "national";

  return "unclassified";
}

async function getResponses(surveyId) {
  let all = [], page = 1;
  while (true) {
    const data = await smGet(`/surveys/${surveyId}/responses/bulk?per_page=100&page=${page}`);
    all = all.concat(data.data || []);
    if (!data.data || data.data.length < 100) break;
    page++;
    if (page > 60) break;
  }
  return all;
}

function answerText(resp, qid) {
  for (const page of (resp.pages || [])) {
    for (const q of (page.questions || [])) {
      if (q.id === qid) {
        for (const a of (q.answers || [])) {
          if (a.text) return a.text;
        }
      }
    }
  }
  return null;
}

(async () => {
  if (!SM_TOKEN) { console.error("SM_MCP_TOKEN not set"); process.exit(1); }
  const report = { generatedAt: new Date().toISOString(), byLanguage: {}, totals: {}, samples: {}, unclassifiedSamples: [] };
  const TYPES = ["national","chinese_medium","tamil_medium","private_international","learning_centre","unclassified","blank"];
  const grand = Object.fromEntries(TYPES.map(t => [t, 0]));

  for (const [lang, sid] of Object.entries(SURVEYS)) {
    console.log(`\n=== ${lang} (${sid}) ===`);
    const qmap = await getQMap(sid);
    const schoolQ = findSchoolQ(qmap);
    if (!schoolQ) { console.log("  School question NOT found by heading."); report.byLanguage[lang] = { error: "school question not detected" }; continue; }
    console.log(`  School question: ${schoolQ} - "${qmap[schoolQ].heading.slice(0,70)}"`);
    const responses = await getResponses(sid);
    const counts = Object.fromEntries(TYPES.map(t => [t, 0]));
    const samplesByType = {};
    let answered = 0;
    for (const r of responses) {
      const txt = answerText(r, schoolQ);
      const cls = classifySchool(txt);
      counts[cls]++; grand[cls]++;
      if (txt && cls !== "blank") answered++;
      if (!samplesByType[cls]) samplesByType[cls] = [];
      if (txt && samplesByType[cls].length < 8) samplesByType[cls].push(txt.slice(0, 50));
      if (cls === "unclassified" && txt && report.unclassifiedSamples.length < 60) report.unclassifiedSamples.push(txt.slice(0, 60));
    }
    report.byLanguage[lang] = { schoolQ, heading: qmap[schoolQ].heading, total: responses.length, answered, counts };
    report.samples[lang] = samplesByType;
    console.log(`  responses: ${responses.length}, answered school: ${answered}`);
    for (const t of TYPES) if (counts[t]) console.log(`    ${t}: ${counts[t]}`);
  }
  report.totals = grand;
  const classifiable = TYPES.filter(t => !["unclassified","blank"].includes(t)).reduce((s,t)=>s+grand[t],0);
  const nonBlank = classifiable + grand.unclassified;
  report.summary = {
    grandTotalTyped: classifiable,
    unclassified: grand.unclassified,
    blank: grand.blank,
    classifiableRateOfAnswered: nonBlank ? Math.round(classifiable / nonBlank * 100) : 0,
  };
  console.log("\n=== GRAND TOTALS ===");
  for (const t of TYPES) console.log(`  ${t}: ${grand[t]}`);
  console.log(`\nClassifiable rate (of non-blank answers): ${report.summary.classifiableRateOfAnswered}%`);
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUTPUT}`);
})();
