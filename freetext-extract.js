// ============================================================================
// CFP FREE-TEXT EXTRACT (no LLM / no API cost)
// ----------------------------------------------------------------------------
// Fetches the six open-ended survey questions across all four language versions,
// scrubs PII, tags each comment with its language and lens values (gender, age,
// income, disability, migration, low-wellbeing), and writes a clean JSON file.
//
// This does NO translation or theming - it only uses SurveyMonkey (SM_MCP_TOKEN,
// free). Bring the output into a Claude session (Project or Cowork) to translate
// and theme it within your subscription, at no API cost.
//
// PRIVACY: contact details (phone, email, IC, links) are stripped before writing.
// Comments still looking contact-bearing after scrubbing are flagged (dropQuote)
// so they can be excluded from any published quotes.
//
// Output: docs/freetext-extract.json  (also downloadable via the repo / Pages)
// ============================================================================

const fs = require("fs");

const SURVEYS = {
  English:  "422468336",
  Malay:    "422521738",
  Mandarin: "527473275",
  Tamil:    "422521746",
};
const SM_BASE  = "https://api.surveymonkey.com/v3";
const SM_TOKEN = process.env.SM_MCP_TOKEN;
const OUTPUT_FILE = "docs/freetext-extract.json";

// The six open-ended questions (English ids + survey position for cross-language resolution)
const FREETEXT_QIDS = {
  "289909817": { module:"parent", short:"What needs to change for children", ro:[4], domains:["OS","SP"] },
  "289909833": { module:"parent", short:"What would improve safety",         ro:[4], domains:["RI","TR"] },
  "289909838": { module:"parent", short:"Environmental changes worried about",ro:[5], domains:["OS","HS"] },
  "289909824": { module:"parent", short:"Activities wanted (by age)",         ro:[4], domains:["SP"], multiRow:true },
  "289909855": { module:"child",  short:"Places/activities wanted",           ro:[4], domains:["SP","OS"] },
  "289909862": { module:"child",  short:"One thing to make the area safer",   ro:[4], domains:["RI","TR"] },
};

// ─── Utils ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _lastSmCall = 0;
const SM_CALL_SPACING_MS = 600;

async function smGet(path, attempt = 1) {
  const MAX = 5;
  const since = Date.now() - _lastSmCall;
  if (since < SM_CALL_SPACING_MS) await sleep(SM_CALL_SPACING_MS - since);
  _lastSmCall = Date.now();
  let res;
  try {
    res = await fetch(`${SM_BASE}${path}`, { headers: { Authorization:`Bearer ${SM_TOKEN}`, "Content-Type":"application/json" } });
  } catch (e) {
    if (attempt < MAX) { await sleep(1000*2**(attempt-1)); return smGet(path, attempt+1); }
    throw e;
  }
  if (res.status === 429 && attempt < MAX) {
    const ra = parseInt(res.headers.get("retry-after")||"0",10);
    await sleep(ra>0?ra*1000:5000*2**(attempt-1)); return smGet(path, attempt+1);
  }
  if (res.status >= 500 && attempt < MAX) { await sleep(2000*2**(attempt-1)); return smGet(path, attempt+1); }
  if (!res.ok) throw new Error(`SM ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}
async function fetchDetails(id) { return smGet(`/surveys/${id}/details`); }

function buildQMap(details) {
  const qMap = {}; const order = [];
  for (const page of (details.pages||[])) {
    for (const q of (page.questions||[])) {
      const choices = {}, menuChoices = {}, rows = {};
      const ans = q.answers || {};
      for (const c of (ans.choices||[])) choices[c.id] = c.text;
      for (const r of (ans.rows||[])) rows[r.id] = r.text;
      for (const col of (ans.cols||[])) for (const c of (col.choices||[])) menuChoices[c.id] = c.text;
      qMap[q.id] = { family:q.family||"", subtype:q.subtype||"", heading:(q.headings?.[0]?.heading||""), choices, menuChoices, rows };
      order.push(q.id);
    }
  }
  return { qMap, order };
}
function resolveByPosition(engOrder, survOrder, engId) {
  const pos = engOrder.indexOf(engId);
  if (pos < 0 || pos >= survOrder.length) return null;
  return survOrder[pos];
}
async function fetchResponses(surveyId) {
  const all = [];
  let page = 1;
  while (true) {
    const path = `/surveys/${surveyId}/responses/bulk?per_page=100&page=${page}&status=completed`;
    const data = await smGet(path);
    all.push(...(data.data || []));
    if (!data.links || !data.links.next) break;
    page++;
    if (page > 200) break;
  }
  return all;
}
function answersFor(response, qid) {
  for (const page of (response.pages||[])) {
    for (const q of (page.questions||[])) {
      if (q.id === qid) return q.answers || [];
    }
  }
  return null;
}

// ─── PII scrubbing ────────────────────────────────────────────────────────────
function scrubPII(text) {
  if (!text) return { clean:"", dropQuote:false };
  let t = text;
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]");
  t = t.replace(/https?:\/\/\S+/g, "[link]");
  t = t.replace(/(\+?6?0?1\d[-\s]?\d{3,4}[-\s]?\d{3,4})/g, "[phone]");
  t = t.replace(/\b\d{6}[-\s]?\d{2}[-\s]?\d{4}\b/g, "[id]");
  t = t.replace(/\b\d{7,}\b/g, "[number]");
  const dropQuote = /\[phone\]|\[email\]|\[id\]|\[number\]/.test(t) || /whatsapp|wasap|call me|hubungi|contact/i.test(t);
  return { clean: t.trim(), dropQuote };
}

// ─── Lens classification ──────────────────────────────────────────────────────
function textOf(ans, qMap, qid) {
  const q = qMap[qid]; if (!q) return "";
  const parts = [];
  for (const a of (ans||[])) {
    if (a.choice_id && q.choices?.[a.choice_id]) parts.push(q.choices[a.choice_id]);
    if (a.choice_id && q.menuChoices?.[a.choice_id]) parts.push(q.menuChoices[a.choice_id]);
    if (a.text) parts.push(a.text);
  }
  return parts.join(" ").toLowerCase();
}
function resolveLensIds(qMap, order) {
  const ids = { childGender:null, childAge:null, income:null, disability:null, status:null, wb905:null, wbMatrix:null, housing:null };
  for (const qid of order) {
    const q = qMap[qid];
    const h = (q.heading||"").toLowerCase();
    const choiceText = Object.values(q.choices||{}).join(" ").toLowerCase();
    if (!ids.childGender && /child'?s gender|gender of.*child|jantina.*anak/i.test(h)) ids.childGender = qid;
    if (!ids.income && /monthly income|pendapatan/i.test(h)) ids.income = qid;
    if (!ids.disability && /matrix/i.test(q.family) && /difficult|kesukaran/i.test(choiceText+h)) ids.disability = qid;
    if (!ids.status && /refugee|stateless|pelarian|tanpa negara/i.test(choiceText)) ids.status = qid;
    if (!ids.wb905 && /how have you been feeling|feeling lately/i.test(h)) ids.wb905 = qid;
    if (!ids.wbMatrix && /emotional wellbeing|anxious|worried.*sad/i.test(h)) ids.wbMatrix = qid;
    if (!ids.childAge && /age of your child.*(10|17)|which.*child.*age/i.test(h)) ids.childAge = qid;
    if (!ids.housing && /type of housing|housing.{0,10}live|jenis.{0,10}(rumah|kediaman|tempat tinggal)|住.{0,6}(房屋|房子|类型)|房屋类型/i.test(h) && Object.keys(q.choices||{}).length >= 5) ids.housing = qid;
  }
  return ids;
}
// Housing labels by option position (identical order across all four surveys).
const HOUSING_LABELS = ["High-rise flat/PPR","Apartment","Condominium","Terrace/link","Semi-detached","Bungalow","Kampung","Shop house","Employer quarters"];
function housingLabel(r, qMap, qid) {
  if (!qid) return null;
  const q = qMap[qid]; if (!q) return null;
  const idxById = {}; Object.keys(q.choices||{}).forEach((id,i)=>{ idxById[id]=i; });
  const ans = answersFor(r, qid);
  if (!ans || !ans.length || ans[0].choice_id===undefined) return null;
  const idx = idxById[ans[0].choice_id];
  return (idx===undefined || idx<0 || idx>=HOUSING_LABELS.length) ? null : HOUSING_LABELS[idx];
}
function disabilityFlag(r, qMap, qid) {
  if (!qid) return false;
  const ans = answersFor(r, qid); if (!ans) return false;
  const q = qMap[qid]; if (!q) return false;
  for (const a of ans) {
    const t = (q.menuChoices?.[a.choice_id] || q.choices?.[a.choice_id] || "").toLowerCase();
    if (/a lot of difficulty|cannot do at all|banyak kesukaran|tidak dapat|很难|完全不能|மிகவும் சிரமம்|செய்ய முடியாது/.test(t)) return true;
  }
  return false;
}
function wellbeingFlag(r, qMap, lensMap) {
  let answered = false, low = false;
  const a905 = answersFor(r, lensMap.wb905);
  if (a905) { answered = true; const q = qMap[lensMap.wb905];
    for (const a of a905) { const t = (q?.choices?.[a.choice_id]||"").toLowerCase();
      if (/worried|stressed|sad or low|risau|tertekan|sedih|担心|压力|难过|கவலை|மன அழுத்தம்/.test(t)) low = true; } }
  const am = answersFor(r, lensMap.wbMatrix);
  if (am) { answered = true; const q = qMap[lensMap.wbMatrix];
    for (const a of am) { const t = (q?.menuChoices?.[a.choice_id]||q?.choices?.[a.choice_id]||"").toLowerCase();
      if (/very often|often|sometimes|kerap|kadang|经常|有时|அடிக்கடி|சில நேரம்/.test(t)) low = true; } }
  if (!answered) return null;
  return low ? 1 : 0;
}
function classifyLenses(r, qMap, lensMap) {
  const g = (() => { const t = textOf(answersFor(r, lensMap.childGender), qMap, lensMap.childGender);
    if (/female|perempuan|女|பெண்/.test(t)) return "Female"; if (/male|lelaki|男|ஆண்/.test(t)) return "Male"; return null; })();
  const a = (() => { const t = textOf(answersFor(r, lensMap.childAge), qMap, lensMap.childAge);
    const n = parseInt((t.match(/\d+/)||[])[0]||"", 10);
    if (!isNaN(n)) { if (n<=12) return "10-12"; if (n<=16) return "13-16"; return "17"; } return null; })();
  const i = (() => { const t = textOf(answersFor(r, lensMap.income), qMap, lensMap.income);
    if (/2,?499|2,?500|4,?999|4,?849/.test(t)) return "B40";
    if (/5,?000|7,?499|7,?500|10,?9|4,?850|10,?970/.test(t)) return "M40";
    if (/11,?000|14,?999|15,?000|10,?971/.test(t)) return "T20"; return null; })();
  const d = disabilityFlag(r, qMap, lensMap.disability) ? 1 : 0;
  const m = (() => { const t = textOf(answersFor(r, lensMap.status), qMap, lensMap.status);
    return /refugee|stateless|undocumented|pelarian|tanpa negara|tiada dokumen|难民|无国籍|அகதி/.test(t) ? 1 : 0; })();
  const w = wellbeingFlag(r, qMap, lensMap);
  const hz = housingLabel(r, qMap, lensMap.housing);
  return { g, a, i, d, m, w, h: hz };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!SM_TOKEN) throw new Error("SM_MCP_TOKEN not set");
  console.log("=== CFP FREE-TEXT EXTRACT (no API) ===");

  const eng = buildQMap(await fetchDetails(SURVEYS.English));
  const engOrder = eng.order;
  const lensIds = resolveLensIds(eng.qMap, engOrder);
  console.log("Lens questions resolved (English):", JSON.stringify(Object.fromEntries(Object.entries(lensIds).map(([k,v])=>[k, v?"ok":"MISSING"]))));

  // question container
  const questions = {};
  for (const engId of Object.keys(FREETEXT_QIDS)) {
    questions[engId] = { ...FREETEXT_QIDS[engId], engId, comments: [] };
  }

  let totalComments = 0, droppedQuotes = 0;
  for (const [lang, sid] of Object.entries(SURVEYS)) {
    const surv = (lang === "English") ? eng : buildQMap(await fetchDetails(sid));
    const survOrder = surv.order;
    const ftMap = {}, lensMap = {};
    for (const engId of Object.keys(FREETEXT_QIDS)) ftMap[engId] = (lang==="English") ? engId : resolveByPosition(engOrder, survOrder, engId);
    for (const [k, engQid] of Object.entries(lensIds)) lensMap[k] = (lang==="English") ? engQid : resolveByPosition(engOrder, survOrder, engQid);

    const responses = await fetchResponses(sid);
    console.log(`  ${lang}: ${responses.length} completed responses`);

    for (const r of responses) {
      const lens = classifyLenses(r, surv.qMap, lensMap);
      for (const engId of Object.keys(FREETEXT_QIDS)) {
        const qid = ftMap[engId]; if (!qid) continue;
        const ans = answersFor(r, qid); if (!ans) continue;
        const raw = ans.map(a => a.text || "").filter(Boolean).join(" | ").trim();
        if (!raw) continue;
        const { clean, dropQuote } = scrubPII(raw);
        if (!clean) continue;
        questions[engId].comments.push({ lang, lens, text: clean, dropQuote });
        totalComments++; if (dropQuote) droppedQuotes++;
      }
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    note: "PII-scrubbed free-text for session-based translation and theming. Comments flagged dropQuote:true still look contact-bearing and should not be quoted verbatim.",
    lensLegend: { g:"gender", a:"child age band", i:"income (B40/M40/T20)", d:"disability (1=yes)", m:"migration/refugee (1=yes)", w:"low wellbeing (1=yes, null=not asked)", h:"housing type (9 categories, null=not answered)" },
    questions,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\nTotal comments: ${totalComments} (${droppedQuotes} flagged not-quotable)`);
  for (const engId of Object.keys(questions)) console.log(`  ${engId} (${questions[engId].short}): ${questions[engId].comments.length}`);
  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log("=== DONE ===");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
