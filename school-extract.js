#!/usr/bin/env node
/**
 * CFP School Participation Extract
 * --------------------------------
 * Standalone, run on demand (not part of the daily pipeline).
 * Reads Q63 "What school/learning centre does your child attend (or is not attending)?"
 * (English question id 289909842) across all four language surveys, normalises the
 * free-text answers, tallies by school and district, and writes an .xlsx the
 * education department can cross-reference against their master list to find
 * schools with no/low participation.
 *
 * "Not attending" responses are separated into their own sheet.
 *
 * Run:  node school-extract.js
 * Output: docs/school-participation.xlsx
 */

const XLSX = require("xlsx");
const fs = require("fs");

const SURVEY_IDS = {
  English:  "422468336",
  Malay:    "422521738",
  Mandarin: "527473275",
  Tamil:    "422521746",
};
const SM_BASE  = "https://api.surveymonkey.com/v3";
const SM_TOKEN = process.env.SM_MCP_TOKEN;

const SCHOOL_Q_ENGLISH_ID = "289909842"; // "What school/learning centre does your child attend"

// ─── API helpers (with rate-limit backoff, mirrors daily-report.js) ─────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SPACING = 600;
let lastCall = 0;

async function smGet(path, attempt = 1) {
  const MAX = 5;
  const since = Date.now() - lastCall;
  if (since < SPACING) await sleep(SPACING - since);
  lastCall = Date.now();

  let res;
  try {
    res = await fetch(`${SM_BASE}${path}`, { headers: { Authorization: `Bearer ${SM_TOKEN}` } });
  } catch (e) {
    if (attempt < MAX) { await sleep(1000 * 2 ** (attempt - 1)); return smGet(path, attempt + 1); }
    throw e;
  }
  if (res.status === 429 && attempt < MAX) {
    const ra = parseInt(res.headers.get("retry-after") || "0", 10);
    const wait = ra > 0 ? ra * 1000 : 5000 * 2 ** (attempt - 1);
    console.log(`  Rate limited on ${path} (attempt ${attempt}) - waiting ${Math.round(wait/1000)}s`);
    await sleep(wait); return smGet(path, attempt + 1);
  }
  if (res.status >= 500 && attempt < MAX) { await sleep(2000 * 2 ** (attempt - 1)); return smGet(path, attempt + 1); }
  if (!res.ok) throw new Error(`SM API error ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function fetchDetails(id) { return smGet(`/surveys/${id}/details`); }

async function fetchAllResponses(id) {
  const out = [];
  let page = 1, more = true;
  while (more) {
    const d = await smGet(`/surveys/${id}/responses/bulk?per_page=100&page=${page}`);
    out.push(...(d.data || []));
    more = d.links?.next != null;
    page++;
  }
  return out;
}

// ─── Build question map with positions (mirrors pipeline) ───────────────────────
function buildQMap(details) {
  const qMap = {};
  let pos = 0;
  for (const page of (details.pages || [])) {
    for (const q of (page.questions || [])) {
      qMap[q.id] = { heading: q.headings?.[0]?.heading || "", family: q.family || "", position: pos };
      pos++;
    }
  }
  return qMap;
}

// Find the school question id in a survey by position-anchoring from the English id
function findSchoolQ(qMap, engPos) {
  for (const [qId, q] of Object.entries(qMap)) {
    if (q.position === engPos) return qId;
  }
  return null;
}

// Extract the free-text answer to a given question from a response
function getText(response, qid) {
  if (!qid) return null;
  for (const page of (response.pages || [])) {
    for (const q of (page.questions || [])) {
      if (q.id === qid) {
        const parts = (q.answers || []).map(a => a.text).filter(Boolean);
        return parts.length ? parts.join(" ").trim() : null;
      }
    }
  }
  return null;
}

// ─── DUN → district (for routing follow-up to the right PPD) ────────────────────
// Reuse the same DUN lists as the pipeline; school question has no district itself,
// so we read the respondent's DUN answer to assign a district where possible.
const DUN_DISTRICT = {}; // built below
const DISTRICT_DUNS = {
  "Timur Laut": ["air itam","air putih","batu lanchang","kebun bunga","komtar","padang kota","pengkalan kota","pulau tikus","seri delima","sungai pinang","tanjong bunga","batu uban","datok keramat","paya terubong","bukit gelugor","seri tanjong pinang"],
  "Barat Daya": ["batu maung","bayan lepas","pantai jerejak","pulau betong","teluk bahang","balik pulau"],
  "SP Utara":   ["penaga","bertam","pinang tunggal","permatang berangan","sungai dua","teluk air tawar","sungai puyu","bagan jermal","bagan dalam"],
  "SP Tengah":  ["seberang jaya","permatang pasir","penanti","berapit","machang bubok","padang lalang","perai","bukit tengah"],
  "SP Selatan": ["bukit tambun","jawi","sungai bakap","sungai acheh"],
};
for (const [dist, duns] of Object.entries(DISTRICT_DUNS)) for (const d of duns) DUN_DISTRICT[d] = dist;

function normaliseDUN(text) {
  if (!text) return null;
  let s = text.toLowerCase().trim()
    .replace(/\blancang\b/g,"lanchang").replace(/\bglugor\b/g,"gelugor")
    .replace(/\bbubuk\b/g,"bubok").replace(/\btelok\b/g,"teluk")
    .replace(/\bayer\b/g,"air").replace(/\btanjung\b/g,"tanjong").replace(/\s+/g," ");
  for (const dun of Object.keys(DUN_DISTRICT)) if (s.includes(dun)) return DUN_DISTRICT[dun];
  return null;
}

// ─── School name normalisation & classification ─────────────────────────────────
function normaliseSchool(raw) {
  if (!raw) return "";
  let s = raw.trim().replace(/\s+/g, " ");
  // Standardise common prefixes / punctuation
  s = s.replace(/\bs\.?k\.?\b/gi, "SK")
       .replace(/\bs\.?m\.?k\.?\b/gi, "SMK")
       .replace(/\bs\.?j\.?k\.?\s*\(?\s*c\s*\)?/gi, "SJK(C)")
       .replace(/\bs\.?j\.?k\.?\s*\(?\s*t\s*\)?/gi, "SJK(T)")
       .replace(/\bsekolah kebangsaan\b/gi, "SK")
       .replace(/\bsekolah menengah kebangsaan\b/gi, "SMK");
  // Title-case Latin words (leave CJK/Tamil untouched)
  return s;
}

// Detect "not attending / not in school"
const NOT_ATTENDING = /not attend|not in school|no school|not schooling|doesn'?t attend|tidak bersekolah|tidak hadir ke sekolah|tiada sekolah|tidak ke sekolah|没有上学|未上学|不上学|没有就读|பள்ளி.{0,5}இல்லை|பள்ளிக்கு செல்லவில்லை/i;

function classifyType(raw) {
  const s = (raw || "").toLowerCase();
  if (NOT_ATTENDING.test(s)) return "Not attending";
  if (/sjk\(c\)|华小|华文小学|chinese (primary|vernacular)/i.test(s)) return "SJK(C) - Chinese vernacular";
  if (/sjk\(t\)|tamil|தமிழ்ப?்?\s*பள்ளி|தமிழ்ப்பள்ளி/i.test(s)) return "SJK(T) - Tamil vernacular";
  if (/international|private|tadika swasta|swasta|国际学校|私立/i.test(s)) return "Private / International";
  if (/learning cent|tuisyen|tuition|madrasah|tahfiz|pondok|refugee|jrec|learning centre|homeschool|home school/i.test(s)) return "Learning centre / Alternative";
  if (/\bsmk\b|sekolah menengah|secondary/i.test(s)) return "SMK - National secondary";
  if (/\bsk\b|sekolah kebangsaan|primary|rendah/i.test(s)) return "SK - National primary";
  return "Other / Unclassified";
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log("CFP School Participation Extract");
  console.log("Fetching surveys...");

  // Resolve the school question position from English
  const engDetails = await fetchDetails(SURVEY_IDS.English);
  const engQMap = buildQMap(engDetails);
  const engPos = engQMap[SCHOOL_Q_ENGLISH_ID]?.position;
  if (engPos == null) { console.error(`Could not find school question ${SCHOOL_Q_ENGLISH_ID} in English survey.`); process.exit(1); }
  console.log(`School question position (from English): ${engPos}`);

  // Build island/Seberang DUN question ids per survey for district lookup
  // (reuse the known English DUN ids, position-anchored)
  const DUN_ISLAND_ENG = "289909870", DUN_SEBERANG_ENG = "289909884";
  const islandPos = engQMap[DUN_ISLAND_ENG]?.position;
  const seberangPos = engQMap[DUN_SEBERANG_ENG]?.position;

  // rows: one per response that named a school (or said not attending)
  const rows = [];      // { language, district, schoolRaw, schoolNorm, type }
  const notAttending = []; // { language, district, raw }

  for (const [lang, id] of Object.entries(SURVEY_IDS)) {
    console.log(`  ${lang}...`);
    const details = (lang === "English") ? engDetails : await fetchDetails(id);
    const qMap = (lang === "English") ? engQMap : buildQMap(details);
    const schoolQ = (lang === "English") ? SCHOOL_Q_ENGLISH_ID : findSchoolQ(qMap, engPos);
    const islandQ = (lang === "English") ? DUN_ISLAND_ENG : findSchoolQ(qMap, islandPos);
    const seberangQ = (lang === "English") ? DUN_SEBERANG_ENG : findSchoolQ(qMap, seberangPos);

    const responses = await fetchAllResponses(id);
    for (const r of responses) {
      const schoolText = getText(r, schoolQ);
      if (!schoolText) continue; // only interested in responses that named something
      const dunText = getText(r, islandQ) || getText(r, seberangQ);
      const district = normaliseDUN(dunText) || "Unknown";
      const type = classifyType(schoolText);
      if (type === "Not attending") {
        notAttending.push({ language: lang, district, raw: schoolText });
      } else {
        rows.push({ language: lang, district, schoolRaw: schoolText, schoolNorm: normaliseSchool(schoolText), type });
      }
    }
  }

  console.log(`Collected ${rows.length} school responses, ${notAttending.length} "not attending".`);

  // ── Aggregate: count by normalised school + district ──
  const agg = {};
  for (const r of rows) {
    const key = `${r.schoolNorm}||${r.district}`;
    if (!agg[key]) agg[key] = { school: r.schoolNorm, district: r.district, type: r.type, count: 0, langs: new Set() };
    agg[key].count++;
    agg[key].langs.add(r.language);
  }
  const schoolList = Object.values(agg)
    .map(a => ({ School: a.school, District: a.district, Type: a.type, Responses: a.count, Languages: [...a.langs].join(", ") }))
    .sort((a, b) => (a.District.localeCompare(b.District)) || (b.Responses - a.Responses));

  // ── Summary by type and district ──
  const byType = {};
  for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
  const typeSummary = Object.entries(byType).map(([Type, Responses]) => ({ Type, Responses })).sort((a,b)=>b.Responses-a.Responses);

  const byDistrict = {};
  for (const r of rows) byDistrict[r.district] = (byDistrict[r.district] || 0) + 1;
  const districtSummary = Object.entries(byDistrict).map(([District, Responses]) => ({ District, Responses })).sort((a,b)=>b.Responses-a.Responses);

  // ── Build workbook ──
  const wb = XLSX.utils.book_new();

  // Sheet 1: instructions / overview
  const overview = [
    ["CFP School Participation Extract"],
    [`Generated: ${new Date().toISOString().slice(0,19).replace("T"," ")} UTC`],
    [],
    ["Purpose: list of schools/learning centres named by survey respondents, with response counts."],
    ["The education department can cross-reference the 'Schools' sheet against the master list"],
    ["to identify schools with NO responses (i.e. not present here) for follow-up."],
    [],
    ["IMPORTANT: A school with zero responses will NOT appear in this file - that is the point."],
    ["Compare this list against the full master list to find the gaps."],
    [],
    ["School names are free text from respondents, lightly normalised. Near-duplicates may remain;"],
    ["the master list is the authority on exact names."],
    [],
    ["Sheets:"],
    ["  Schools          - each named school/centre with district, type, response count"],
    ["  Not Attending    - responses indicating the child is not in school (child-rights flag)"],
    ["  Summary by Type  - totals by school type"],
    ["  Summary by District - totals by district"],
    [],
    [`Total school responses: ${rows.length}`],
    [`Total "not attending" responses: ${notAttending.length}`],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overview), "Overview");

  // Sheet 2: schools
  const wsSchools = XLSX.utils.json_to_sheet(schoolList);
  wsSchools["!cols"] = [{ wch: 45 }, { wch: 14 }, { wch: 28 }, { wch: 11 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, wsSchools, "Schools");

  // Sheet 3: not attending
  const naRows = notAttending.map(n => ({ Language: n.language, District: n.district, "Response text": n.raw }));
  const wsNA = XLSX.utils.json_to_sheet(naRows.length ? naRows : [{ Language: "", District: "", "Response text": "(none)" }]);
  wsNA["!cols"] = [{ wch: 12 }, { wch: 14 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, wsNA, "Not Attending");

  // Sheet 4 & 5: summaries
  const wsType = XLSX.utils.json_to_sheet(typeSummary);
  wsType["!cols"] = [{ wch: 32 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsType, "Summary by Type");

  const wsDist = XLSX.utils.json_to_sheet(districtSummary);
  wsDist["!cols"] = [{ wch: 16 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsDist, "Summary by District");

  // Write into docs/ so it is committed and downloadable from the repo
  if (!fs.existsSync("docs")) fs.mkdirSync("docs");
  const outPath = "docs/school-participation.xlsx";
  XLSX.writeFile(wb, outPath);
  console.log(`Wrote ${outPath}`);
  console.log(`  ${schoolList.length} distinct school/district rows`);
  console.log(`  Type summary: ${JSON.stringify(byType)}`);
  console.log(`  District summary: ${JSON.stringify(byDistrict)}`);
}

main().catch(e => { console.error("Extract failed:", e.message); process.exit(1); });
