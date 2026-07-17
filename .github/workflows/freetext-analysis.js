// ============================================================================
// CFP FREE-TEXT THEMATIC ANALYSIS
// ----------------------------------------------------------------------------
// Analyses the six open-ended survey questions across all four language versions.
// Approach (full-then-incremental, like the main pipeline):
//   - First run (no theme cache): full fetch of all free-text, scrub PII, translate
//     to English, DISCOVER a theme taxonomy per question, assign every response to
//     theme(s), write the theme cache.
//   - Later runs: incremental fetch of only new/modified responses; translate and
//     assign them into the EXISTING taxonomy; refresh counts. Cheap.
//   - Re-discovery: delete freetext-cache.json to force a fresh full theme discovery
//     (do this if the corpus has grown a lot and new themes are emerging).
//
// PRIVACY: raw comments are NEVER stored. The cache and output hold only theme
// assignments, lens values, and PII-scrubbed representative quotes. Any response
// whose text still looks like it contains contact details after scrubbing is
// dropped from quoting (its theme assignment is kept, its text is not).
// ============================================================================

const fs = require("fs");

// ─── Config ─────────────────────────────────────────────────────────────────
const SURVEYS = {
  English:  "422468336",
  Malay:    "422521738",
  Mandarin: "527473275",
  Tamil:    "422521746",
};
const SM_BASE  = "https://api.surveymonkey.com/v3";
const SM_TOKEN = process.env.SM_MCP_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

const CACHE_FILE  = "freetext-cache.json";       // repo root, not published
const OUTPUT_FILE = "docs/freetext-analysis.json"; // published to Pages
const CACHE_OVERLAP_MS = 2 * 60 * 60 * 1000;

// The six open-ended questions (English ids + survey position for cross-language resolution).
// 824 is a multi-row open-ended (activities wanted, by age band) - each row treated as text.
const FREETEXT_QIDS = {
  "289909817": { module:"parent", short:"What needs to change for children", ro:[4], domains:["OS","SP"] },
  "289909833": { module:"parent", short:"What would improve safety",         ro:[4], domains:["RI","TR"] },
  "289909838": { module:"parent", short:"Environmental changes worried about",ro:[5], domains:["OS","HS"] },
  "289909824": { module:"parent", short:"Activities wanted (by age)",         ro:[4], domains:["SP"], multiRow:true },
  "289909855": { module:"child",  short:"Places/activities wanted",           ro:[4], domains:["SP","OS"] },
  "289909862": { module:"child",  short:"One thing to make the area safer",   ro:[4], domains:["RI","TR"] },
};

const RO_LABELS = {
  1:"RO1 - Awareness of child rights", 2:"RO2 - Effectiveness of mechanisms",
  3:"RO3 - Child participation", 4:"RO4 - Inclusive & safe environments", 5:"RO5 - Climate & resilience",
};
const DOMAIN_LABELS = {
  OS:"Outdoor Spaces & Buildings", TR:"Transportation", HO:"Housing", SP:"Social Participation",
  RI:"Respect & Social Inclusion", CP:"Civic Participation & Employment", CI:"Communication & Information",
  HS:"Community Support & Health Services",
};

const THEMES_PER_QUESTION = 10;   // target number of themes to discover per question
const BATCH_SIZE = 40;            // comments per API call for translate+assign
const DISCOVERY_SAMPLE = 400;     // max comments sampled for theme discovery per question

// ─── Small utils ─────────────────────────────────────────────────────────────
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

// ─── Anthropic API (translate + theme) ───────────────────────────────────────
async function anthropic(system, user, maxTokens = 4000, attempt = 1) {
  const MAX = 4;
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "x-api-key":ANTHROPIC_KEY, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:ANTHROPIC_MODEL, max_tokens:maxTokens, system, messages:[{role:"user",content:user}] }),
    });
  } catch (e) {
    if (attempt < MAX) { await sleep(2000*2**(attempt-1)); return anthropic(system,user,maxTokens,attempt+1); }
    throw e;
  }
  if ((res.status===429||res.status>=500) && attempt < MAX) {
    const ra = parseInt(res.headers.get("retry-after")||"0",10);
    await sleep(ra>0?ra*1000:5000*2**(attempt-1)); return anthropic(system,user,maxTokens,attempt+1);
  }
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
}
function parseJSON(text) {
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) throw new Error("No JSON in model response");
  return JSON.parse(m[0]);
}

// ─── PII scrubbing ───────────────────────────────────────────────────────────
// Remove phone numbers, emails, URLs. Flag comments that still look contact-bearing.
function scrubPII(text) {
  if (!text) return { clean:"", dropQuote:false };
  let t = text;
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]");
  t = t.replace(/https?:\/\/\S+/g, "[link]");
  // Malaysian & generic phone patterns (01X-XXXXXXXX, +60..., long digit runs)
  t = t.replace(/(\+?6?0?1\d[-\s]?\d{3,4}[-\s]?\d{3,4})/g, "[phone]");
  t = t.replace(/\b\d{7,}\b/g, "[number]");
  // IC number pattern (YYMMDD-PB-###G)
  t = t.replace(/\b\d{6}[-\s]?\d{2}[-\s]?\d{4}\b/g, "[id]");
  // If after scrubbing there are still tokens that look like contact details, flag to not quote
  const dropQuote = /\[phone\]|\[email\]|\[id\]|\[number\]/.test(t) || /whatsapp|wasap|call me|hubungi|contact/i.test(t);
  return { clean: t.trim(), dropQuote };
}

// ─── Lens classification (minimal - the 7 lenses only) ────────────────────────
// Reused patterns from the main pipeline, kept lightweight here.
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
// (Lens question ids resolved per survey by position, see resolveQuestionIds.)

// ─── Survey structure ─────────────────────────────────────────────────────────
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

// Resolve the free-text qids + lens qids for a survey by English position.
function resolveByPosition(engOrder, survOrder, engId) {
  const pos = engOrder.indexOf(engId);
  if (pos < 0 || pos >= survOrder.length) return null;
  return survOrder[pos];
}

// ─── Fetch responses (bulk, incremental) ─────────────────────────────────────
async function fetchResponses(surveyId, sinceISO) {
  const all = [];
  let page = 1;
  while (true) {
    let path = `/surveys/${surveyId}/responses/bulk?per_page=100&page=${page}&status=completed`;
    if (sinceISO) path += `&start_modified_at=${encodeURIComponent(sinceISO)}`;
    const data = await smGet(path);
    const arr = data.data || [];
    all.push(...arr);
    if (!data.links || !data.links.next) break;
    page++;
    if (page > 200) break;
  }
  return all;
}

// Pull the answers array for a given question id from a bulk response
function answersFor(response, qid) {
  for (const page of (response.pages||[])) {
    for (const q of (page.questions||[])) {
      if (q.id === qid) return q.answers || [];
    }
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!SM_TOKEN) throw new Error("SM_MCP_TOKEN not set");
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  console.log("=== CFP FREE-TEXT ANALYSIS ===");

  // Load theme cache (taxonomy + per-response assignments)
  let cache = null;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    console.log(`Loaded theme cache: ${Object.keys(cache.assignments||{}).length} responses, last modified ${cache.lastModified}`);
  } catch { console.log("No theme cache - performing full discovery + assignment."); }

  const isFull = !cache || !cache.taxonomy;
  const sinceISO = (!isFull && cache.lastModified)
    ? new Date(new Date(cache.lastModified).getTime() - CACHE_OVERLAP_MS).toISOString()
    : null;

  // Survey structures
  const eng = buildQMap(await fetchDetails(SURVEYS.English));
  const engOrder = eng.order;

  // Resolve lens question ids in English (by scanning headings/choices)
  const lensIds = resolveLensIds(eng.qMap, engOrder);
  console.log("Lens questions resolved (English):", JSON.stringify(Object.fromEntries(Object.entries(lensIds).map(([k,v])=>[k, v?"ok":"MISSING"]))));

  // Gather free-text records across all surveys
  const records = []; // { id, lang, lens:{g,a,i,u,d,m,w}, texts:{engId: "translated?raw"} }
  let rawByQuestion = {}; // engId -> [ {id, lang, text} ] raw (for translate+theme)
  for (const engId of Object.keys(FREETEXT_QIDS)) rawByQuestion[engId] = [];

  for (const [lang, sid] of Object.entries(SURVEYS)) {
    const surv = (lang === "English") ? eng : buildQMap(await fetchDetails(sid));
    const survOrder = surv.order;
    // Map English free-text + lens ids to this survey by position
    const ftMap = {};
    for (const engId of Object.keys(FREETEXT_QIDS)) ftMap[engId] = (lang==="English") ? engId : resolveByPosition(engOrder, survOrder, engId);
    const lensMap = {};
    for (const [k, engQid] of Object.entries(lensIds)) lensMap[k] = (lang==="English") ? engQid : resolveByPosition(engOrder, survOrder, engQid);

    const responses = await fetchResponses(sid, sinceISO);
    console.log(`  ${lang}: ${responses.length} responses fetched${sinceISO?" (incremental)":""}`);

    for (const r of responses) {
      const lens = classifyLenses(r, surv.qMap, lensMap);
      const texts = {};
      let hasText = false;
      for (const engId of Object.keys(FREETEXT_QIDS)) {
        const qid = ftMap[engId]; if (!qid) continue;
        const ans = answersFor(r, qid); if (!ans) continue;
        // essay = single text; multiRow = concat row texts
        const raw = ans.map(a => a.text || "").filter(Boolean).join(" | ").trim();
        if (raw) {
          const { clean, dropQuote } = scrubPII(raw);
          if (clean) { texts[engId] = { raw:clean, dropQuote }; hasText = true; rawByQuestion[engId].push({ id:r.id, lang, text:clean }); }
        }
      }
      if (hasText) records.push({ id:r.id, lang, lens, texts });
    }
  }
  console.log(`Collected ${records.length} responses with free text.`);
  for (const engId of Object.keys(FREETEXT_QIDS)) console.log(`  ${engId} (${FREETEXT_QIDS[engId].short}): ${rawByQuestion[engId].length} comments`);

  // Theme taxonomy: discover (full) or reuse (incremental)
  let taxonomy = (cache && cache.taxonomy) ? cache.taxonomy : {};
  if (isFull) {
    console.log("Discovering themes per question...");
    for (const engId of Object.keys(FREETEXT_QIDS)) {
      const sample = rawByQuestion[engId].slice(0, DISCOVERY_SAMPLE).map(c => c.text);
      if (sample.length === 0) { taxonomy[engId] = []; continue; }
      taxonomy[engId] = await discoverThemes(engId, FREETEXT_QIDS[engId].short, sample);
      console.log(`  ${engId}: ${taxonomy[engId].length} themes discovered`);
    }
  } else {
    console.log("Reusing existing theme taxonomy.");
  }

  // Assign responses to themes (translate + classify). In incremental mode, only new records.
  const assignments = (cache && cache.assignments) ? { ...cache.assignments } : {};
  const toAssign = records.filter(r => isFull || !assignments[r.id]);
  console.log(`Assigning ${toAssign.length} responses to themes...`);

  // Group work by question for batching
  for (const engId of Object.keys(FREETEXT_QIDS)) {
    const themes = taxonomy[engId] || [];
    if (!themes.length) continue;
    const items = toAssign.filter(r => r.texts[engId]).map(r => ({ id:r.id, text:r.texts[engId].raw, dropQuote:r.texts[engId].dropQuote }));
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const results = await translateAndAssign(engId, FREETEXT_QIDS[engId].short, themes, batch);
      // results: [{id, themes:[idx], quote:"..."|null}]
      for (const res of results) {
        if (!assignments[res.id]) assignments[res.id] = {};
        assignments[res.id][engId] = { t: res.themes || [], q: res.quote || null };
      }
    }
    console.log(`  ${engId}: assigned ${items.length} comments`);
  }

  // Build lens lookup for aggregation
  const lensById = {};
  for (const r of records) lensById[r.id] = r.lens;
  // carry forward lenses from cache for responses not re-fetched this run
  if (cache && cache.lensById) for (const [id, l] of Object.entries(cache.lensById)) if (!lensById[id]) lensById[id] = l;

  // Save cache
  const newCache = {
    lastModified: new Date().toISOString(),
    taxonomy,
    assignments,
    lensById,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(newCache));
  console.log(`Saved theme cache: ${Object.keys(assignments).length} responses.`);

  // Aggregate → output
  const output = aggregate(taxonomy, assignments, lensById);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  console.log(`Wrote ${OUTPUT_FILE}.`);
  console.log("=== DONE ===");
}

// ─── Theme discovery ─────────────────────────────────────────────────────────
async function discoverThemes(engId, questionText, sampleComments) {
  const system = `You are a qualitative research analyst coding open-ended survey responses from a child-friendly city survey in Penang, Malaysia. Comments may be in English, Malay, Mandarin, or Tamil. Identify the main recurring themes.`;
  const user = `Question: "${questionText}"

Here are ${sampleComments.length} responses (various languages):
${sampleComments.map((c,i)=>`${i+1}. ${c}`).join("\n")}

Identify up to ${THEMES_PER_QUESTION} distinct recurring themes. Return ONLY a JSON array of objects, no preamble:
[{"label":"Short theme name (English, 2-5 words)","desc":"one-line description"}]`;
  const text = await anthropic(system, user, 2000);
  const arr = parseJSON(text);
  return arr.map((t,i)=>({ id:i, label:t.label, desc:t.desc||"" }));
}

// ─── Translate + assign a batch ──────────────────────────────────────────────
async function translateAndAssign(engId, questionText, themes, batch) {
  const system = `You translate and thematically code open-ended survey responses (child-friendly city survey, Penang, Malaysia). Input comments may be English, Malay, Mandarin, or Tamil.`;
  const themeList = themes.map(t=>`${t.id}: ${t.label} - ${t.desc}`).join("\n");
  const user = `Question: "${questionText}"

Themes:
${themeList}

For each comment below: translate to English internally, then assign the theme id(s) that apply (0-3 ids), and if the comment is a clear, vivid, self-contained example of its main theme, provide a concise English quote (translated if needed, max 25 words) - otherwise null.

Comments:
${batch.map(b=>`ID ${b.id}: ${b.text}`).join("\n")}

Return ONLY a JSON array, no preamble:
[{"id":"<response id>","themes":[<theme ids>],"quote":"<english quote or null>"}]`;
  const text = await anthropic(system, user, 4000);
  let arr;
  try { arr = parseJSON(text); } catch { arr = []; }
  // Enforce quote suppression for dropQuote items
  const dropSet = new Set(batch.filter(b=>b.dropQuote).map(b=>String(b.id)));
  return arr.map(r => ({ id:String(r.id), themes:Array.isArray(r.themes)?r.themes:[], quote: dropSet.has(String(r.id)) ? null : (r.quote||null) }));
}

// ─── Lens classification ──────────────────────────────────────────────────────
function resolveLensIds(qMap, order) {
  const ids = { childGender:null, childAge:null, income:null, island:null, dun:null, disability:null, status:null, wb905:null, wbMatrix:null };
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
  }
  return ids;
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
  return { g, a, i, u:null, d, m, w };
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

// ─── Aggregation ─────────────────────────────────────────────────────────────
function aggregate(taxonomy, assignments, lensById) {
  const LENS_KEYS = ["g","a","i","u","d","m","w"];
  const questions = {};
  for (const engId of Object.keys(FREETEXT_QIDS)) {
    const meta = FREETEXT_QIDS[engId];
    const themes = (taxonomy[engId]||[]).map(t => ({ ...t, count:0, quotes:[], byLens:{} }));
    let total = 0;
    for (const [rid, byQ] of Object.entries(assignments)) {
      const a = byQ[engId]; if (!a) continue;
      total++;
      const lens = lensById[rid] || {};
      for (const ti of (a.t||[])) {
        const th = themes[ti]; if (!th) continue;
        th.count++;
        // lens breakdown
        for (const lk of LENS_KEYS) {
          const val = lens[lk]; if (val === null || val === undefined) continue;
          th.byLens[lk] = th.byLens[lk] || {};
          const vkey = String(val);
          th.byLens[lk][vkey] = (th.byLens[lk][vkey] || 0) + 1;
        }
        if (a.q && th.quotes.length < 5) th.quotes.push(a.q);
      }
    }
    // sort themes by count desc
    themes.sort((x,y)=>y.count-x.count);
    questions[engId] = { short:meta.short, module:meta.module, ro:meta.ro, domains:meta.domains, total, themes };
  }
  // roll up: theme counts by RO and domain
  const byRO = {}, byDomain = {};
  for (const engId of Object.keys(questions)) {
    const q = questions[engId];
    for (const ro of q.ro) { byRO[ro] = byRO[ro] || { label:RO_LABELS[ro], questions:[] }; byRO[ro].questions.push(engId); }
    for (const dc of q.domains) { byDomain[dc] = byDomain[dc] || { label:DOMAIN_LABELS[dc], questions:[] }; byDomain[dc].questions.push(engId); }
  }
  return { updatedAt:new Date().toISOString(), questions, byRO, byDomain, roLabels:RO_LABELS, domainLabels:DOMAIN_LABELS };
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
