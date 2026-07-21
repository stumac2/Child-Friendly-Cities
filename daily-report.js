#!/usr/bin/env node
// CFP Survey Daily Report — Node.js classification (no AI dependency for data)
// Runs via GitHub Actions every 2 hours; emails at 9am MYT

const nodemailer = require("nodemailer");

// ─── Config ────────────────────────────────────────────────────────────────────
const SURVEY_IDS = {
  English:  "422468336",
  Malay:    "422521738",
  Mandarin: "527473275",
  Tamil:    "422521746",
};
const SM_BASE    = "https://api.surveymonkey.com/v3";
const SM_TOKEN   = process.env.SM_MCP_TOKEN;
// Incremental cache of anonymised classified records (kept at repo root, NOT in docs/,
// so it is not part of the published Pages site). Contains no free text or contact data.
const CACHE_FILE = "response-cache.json";
const CACHE_OVERLAP_MS = 2 * 60 * 60 * 1000; // refetch a 2h window before last run to catch boundary/late updates
const START_DATE = new Date("2026-06-15");
const END_DATE   = new Date("2026-07-31");
const TOTAL_TARGET  = 2500;
const STRETCH_2D    = 10000;
const STRETCH_3D    = 20000;
const EMAIL_TO   = ["yancheng.tan@thinkcity.com.my", "hana.zulkifli@thinkcity.com.my", "stuart.macdonald@thinkcity.com.my"];

// Base sub-targets at the 2D (10,000) level, population-proportional from DOSM.
// When completions reach STRETCH_2D, all sub-targets double to the 3D (20,000) level.
const Q_BASE = {
  district:  { "Timur Laut":3265, "Barat Daya":1310, "SP Utara":1905, "SP Tengah":2425, "SP Selatan":1095 },
  ethnicity: { Malay:4490, Chinese:4150, Indian:990, Others:370 },
  income:    { B40:2590, M40:2870, T20:1540 },
  age:       { "10-12":2625, "13-16":3500, "17":875 },
  gender:    { Male:5080, Female:4920 },
  urbanRural:{ Urban:6000, "Peri-urban":2500, Rural:1500 },
};
const VG_BASE = { disability: 200, singleParent: 600 }; // vulnerable-group targets at 2D level

// Returns the tier multiplier: 1 below 2D, 2 once 2D reached (Option A - locks to highest reached)
function tierMultiplier(totalCompleted) {
  return totalCompleted >= STRETCH_2D ? 2 : 1;
}

// Scale a target table by the active multiplier
function scaleTable(table, mult) {
  const out = {};
  for (const [k, v] of Object.entries(table)) {
    if (typeof v === "number") out[k] = v * mult;
    else { out[k] = {}; for (const [k2, v2] of Object.entries(v)) out[k][k2] = v2 * mult; }
  }
  return out;
}

const ACTIONS = {
  district: {
    "Timur Laut":["Chase via PPD Timur Laut — targeted resend to George Town and Ayer Itam clusters"],
    "Barat Daya":["Contact PPD Barat Daya — request Balik Pulau and Teluk Bahang follow-up"],
    "SP Utara":["Contact PPD Seberang Perai Utara — Kepala Batas and north Butterworth clusters"],
    "SP Tengah":["Chase PPD Seberang Perai Tengah for Bukit Mertajam and Perai school clusters"],
    "SP Selatan":["URGENT — Direct call to PPD Seberang Perai Selatan for Nibong Tebal & Simpang Ampat"],
  },
  ethnicity: {
    Malay:["Friday mosque/surau announcement via JAIPP"],
    Chinese:["SJK(C) PIBG broadcast — resend Mandarin survey link"],
    Indian:["SJK(T) PIBG broadcast — resend Tamil survey to parent groups"],
    Others:["JREC, Equal Start, LifeBridge learning centres — direct distribution"],
  },
  income: { B40:["QR code in PPR noticeboards via MBPP/MBSP housing unit"], M40:["Check school WhatsApp groups need a resend"], T20:["Private/international schools — contact admin directly"] },
  age: { "10-12":["Year 4-6 class teacher reminder"], "13-16":["PRIORITY — Form 1-3 class teacher reminder"], "17":["Form 5 school counsellor outreach"] },
  gender: { Male:["Audit co-ed vs boys-only school distribution"], Female:["Contact girls-only secondary schools directly"] },
  urbanRural: { Urban:["PPD digital channels — check completion rate"], "Peri-urban":["Contact PPD offices for BM, Bayan Baru, Kepala Batas"], Rural:["URGENT — printed QR codes and mosque announcements for rural DUNs"] },
};

// ─── DUN mappings ──────────────────────────────────────────────────────────────
const DUN_DISTRICT = {};
const DUN_URBAN = {};
const DUN_CANONICAL = {}; // lowercase key -> display name
const DUN_ISLAND = {};    // lowercase key -> true (island) / false (mainland)
const ISLAND_DISTRICTS = new Set(["Timur Laut","Barat Daya"]);
const dunData = {
  "Timur Laut": {
    duns: ["Tanjong Bunga","Air Putih","Air Itam","Kebun Bunga","Pulau Tikus","Padang Kota","Pengkalan Kota","Komtar","Datok Keramat","Sungai Pinang","Batu Lanchang","Seri Delima","Paya Terubong","Batu Uban"],
    urban: ["Tanjong Bunga","Air Putih","Air Itam","Kebun Bunga","Pulau Tikus","Padang Kota","Pengkalan Kota","Komtar","Datok Keramat","Sungai Pinang","Batu Lanchang","Seri Delima","Batu Uban"],
    periurban: ["Paya Terubong"],
  },
  "Barat Daya": {
    duns: ["Pantai Jerejak","Batu Maung","Bayan Lepas","Pulau Betong","Teluk Bahang"],
    urban: ["Pantai Jerejak","Batu Maung","Bayan Lepas"],
    rural: ["Pulau Betong","Teluk Bahang"],
  },
  "SP Utara": {
    duns: ["Penaga","Bertam","Pinang Tunggal","Permatang Berangan","Sungai Dua","Teluk Air Tawar","Sungai Puyu","Bagan Jermal","Bagan Dalam"],
    urban: ["Sungai Puyu","Bagan Jermal","Bagan Dalam"],
    periurban: ["Bertam","Pinang Tunggal","Permatang Berangan","Sungai Dua"],
    rural: ["Penaga","Teluk Air Tawar"],
  },
  "SP Tengah": {
    duns: ["Seberang Jaya","Permatang Pasir","Penanti","Berapit","Machang Bubok","Padang Lalang","Perai","Bukit Tengah"],
    urban: ["Seberang Jaya","Perai"],
    periurban: ["Permatang Pasir","Berapit","Padang Lalang","Bukit Tengah"],
    rural: ["Penanti","Machang Bubok"],
  },
  "SP Selatan": {
    duns: ["Bukit Tambun","Jawi","Sungai Bakap","Sungai Acheh"],
    periurban: ["Bukit Tambun","Jawi","Sungai Bakap","Sungai Acheh"],
  },
};
for (const [district, info] of Object.entries(dunData)) {
  for (const dun of info.duns) {
    const key = dun.toLowerCase();
    DUN_DISTRICT[key] = district;
    DUN_CANONICAL[key] = dun;
    DUN_ISLAND[key] = ISLAND_DISTRICTS.has(district);
    if (info.urban?.includes(dun)) DUN_URBAN[key] = "Urban";
    else if (info.periurban?.includes(dun)) DUN_URBAN[key] = "Peri-urban";
    else if (info.rural?.includes(dun)) DUN_URBAN[key] = "Rural";
  }
}

// ─── Pattern matchers ──────────────────────────────────────────────────────────
const ETH_MAP = [
  { pattern: /melayu|bumiputera|malay|马来|மலாய்/i, value: "Malay" },
  { pattern: /cina|chinese|华人|சீனர்/i, value: "Chinese" },
  { pattern: /india|indian|印度|இந்தியர்/i, value: "Indian" },
  { pattern: /lain|other|refugee|non.?citizen|难民|அகதி|无国籍/i, value: "Others" },
];

function matchIncome(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/prefer not|tidak mahu|不愿|விரும்பவில்லை/.test(t)) return null;
  // Extract all RM amounts mentioned
  const nums = (text.match(/\d[\d,]*/g) || []).map(n => parseInt(n.replace(/,/g, ""))).filter(n => n >= 100);
  if (nums.length === 0) {
    // Text-based bands
    if (/b40|below|less than|bawah|kurang/i.test(t)) return "B40";
    if (/t20|above|more than|atas|lebih/i.test(t)) return "T20";
    if (/m40|middle|sederhana/i.test(t)) return "M40";
    return null;
  }
  // Use the lower bound of the band to classify
  const low = Math.min(...nums);
  if (low < 4850) return "B40";
  if (low <= 10970) return "M40";
  return "T20";
}

const GENDER_MAP = [
  { pattern: /^male$|^lelaki$|^男$|^ஆண்$/i, value: "Male" },
  { pattern: /^female$|^perempuan$|^女$|^பெண்$/i, value: "Female" },
];

const DISABILITY_PATTERN = /some difficulty|a lot of difficulty|cannot do at all|sukar|kesukaran|困难|难以|சிரமம்/i;

// ─── Intersectional outcome framework ──────────────────────────────────────────
// Each scored outcome: English question id, module, research objective, AFC domain,
// and a `concerning(text)` test returning true when the answer is a poor outcome.
// Diagnostic (multi-select) questions are tallied within cells, not scored - listed separately.
// Matrix questions (828,847,851,860,920,921) are deferred until sub-statement wording is confirmed.
//
// Detection across the 4 language surveys uses position-anchoring from the English IDs
// (same approach proven for DUN/CRG), since question IDs differ per language.

const AGREE_NEG  = /disagree|tidak setuju|不同意|உடன்படவில்லை/i;   // captures "disagree" + "strongly disagree"
const AGREE_POS  = /^(strongly )?agree|sangat setuju|^setuju|^同意|非常同意|வலுவாக ஒப்புக|ஒப்புக/i;
const FREQ_LOW   = /rarely|never|jarang|tidak pernah|很少|从不|அரிதாக|ஒருபோதும்/i;
const WORRY_HIGH = /extremely worried|very worried|sangat risau|amat risau|极度担忧|非常担忧|மிகவும் கவலை/i;

const SCORED_OUTCOMES = [
  // RO1 - Awareness of child rights
  { id:"815", module:"parent", ro:1, domain:"Communication & Information", short:"Heard of child rights",
    concerning:t => /^no$|tidak|没有|不|இல்லை/i.test((t||"").trim()) },
  { id:"846", module:"child", ro:1, domain:"Communication & Information", short:"Knows about child rights",
    concerning:t => /heard.*but|don'?t really know|pernah dengar|听说过但|கேள்விப்பட்ட/i.test(t||"") },

  // RO2 - Effectiveness of mechanisms
  { id:"822", module:"parent", ro:2, domain:"Health Services & Community Support", short:"Challenges accessing services",
    concerning:t => /^yes$|ya|是|ஆம்/i.test((t||"").trim()) },

  // RO3 - Participation
  { id:"818", module:"parent", ro:3, domain:"Civic Participation & Employment", short:"Child can express opinion freely",
    concerning:t => FREQ_LOW.test(t||"") },
  { id:"866", module:"child", ro:3, domain:"Civic Participation & Employment", short:"People in charge listen",
    concerning:t => AGREE_NEG.test(t||"") },

  // RO4 - Inclusive & safe environments
  { id:"820", module:"parent", ro:4, domain:"Social Participation", short:"Child takes part in activities",
    concerning:t => /^none$|no activit|tiada|tidak|没有|没有参加|எதுவும் இல்லை|இல்லை/i.test((t||"").trim()) },
  { id:"821", module:"parent", ro:4, domain:"Respect & Social Inclusion", short:"Fair access to activities",
    concerning:t => AGREE_NEG.test(t||"") },
  { id:"825", module:"parent", ro:4, domain:"Outdoor Spaces & Buildings", short:"Enough public spaces",
    concerning:t => AGREE_NEG.test(t||"") },
  { id:"827", module:"parent", ro:4, domain:"Outdoor Spaces & Buildings", short:"Visits green space",
    concerning:t => FREQ_LOW.test(t||"") },
  { id:"831", module:"parent", ro:4, domain:"Respect & Social Inclusion", short:"Child safe at school from bullying",
    concerning:t => AGREE_NEG.test(t||"") },
  { id:"853", module:"child", ro:4, domain:"Social Participation", short:"Takes part in activities",
    concerning:t => FREQ_LOW.test(t||"") },
  { id:"857", module:"child", ro:4, domain:"Outdoor Spaces & Buildings", short:"Spaces for children",
    concerning:t => AGREE_NEG.test(t||"") },
  { id:"861", module:"child", ro:4, domain:"Communication & Information", short:"Knows how to stay safe online",
    concerning:t => AGREE_NEG.test(t||"") },

  // RO5 - Climate & resilience (eco-anxiety framing: high worry = concerning)
  { id:"834", module:"parent", ro:5, domain:"Climate", short:"Climate worry (eco-anxiety)",
    concerning:t => WORRY_HIGH.test(t||"") },
  { id:"836", module:"parent", ro:5, domain:"Climate", short:"Children help protect environment",
    concerning:t => FREQ_LOW.test(t||"") },
  { id:"837", module:"parent", ro:5, domain:"Climate", short:"Authorities doing enough on climate",
    concerning:t => AGREE_NEG.test(t||"") },
  { id:"864", module:"child", ro:5, domain:"Climate", short:"Climate worry (eco-anxiety)",
    concerning:t => WORRY_HIGH.test(t||"") },
  { id:"865", module:"child", ro:5, domain:"Outdoor Spaces & Buildings", short:"Weather limits going outside",
    concerning:t => AGREE_POS.test(t||"") },  // agreeing it limits them = concerning
  { id:"876", module:"child", ro:5, domain:"Climate", short:"Helps protect environment",
    concerning:t => FREQ_LOW.test(t||"") },

  // Wellbeing (child)
  { id:"911742", module:"child", ro:5, domain:"Health Services & Community Support", short:"Screen time 4+ hours",
    concerning:t => /4\+|4 or more|more than 4|4-5|5\+|lebih 4|4小时以上|4\+? மணி/i.test(t||"") },
];

// Parallel question pairs (parent id <-> child id) for parent-child disparity
const PARALLEL_PAIRS = [
  { theme:"Awareness of child rights", parent:"815", child:"846" },
  { theme:"Child can express / is listened to", parent:"818", child:"866" },
  { theme:"Public spaces for children", parent:"825", child:"857" },
  { theme:"Activity participation", parent:"820", child:"853" },
  { theme:"Climate worry", parent:"834", child:"864" },
  { theme:"Helps protect environment", parent:"836", child:"876" },
];

// Lens dimensions used for intersectional breakdown
const LENS_KEYS = ["gender","ageGroup","income","urbanRural","disability","migration"];

// Map a short outcome id (e.g. "815") to the real English question id (e.g. "289909815").
// Screen-time is 289911742; all other survey questions are 289909xxx.
function engQuestionId(shortId) {
  if (shortId === "911742") return "289911742";
  return "289909" + shortId;
}

// ─── Question-by-question browser: substantive questions by module ──────────────
// Only the id->module mapping is hardcoded; labels, types and options are built at
// runtime from the English survey so wording is always current and untruncated.
// Excludes demographics, consent, section headers, free-text (open_ended), and CRG.
const CATALOG_MODULE = {
  // PREGNANT module
  "289909908":"pregnant","289909910":"pregnant","289909911":"pregnant","289909913":"pregnant",
  "289909915":"pregnant","289909916":"pregnant","289909918":"pregnant",
  // PARENT module
  "289909815":"parent","289909920":"parent","289909818":"parent","289909819":"parent","289909820":"parent",
  "289909821":"parent","289909823":"parent","289909825":"parent","289909826":"parent","289909827":"parent",
  "289909921":"parent","289909880":"parent","289909828":"parent","289909829":"parent","289909830":"parent",
  "289909831":"parent","289909832":"parent","289909834":"parent","289909835":"parent","289909836":"parent",
  "289909837":"parent",
  // UNDER-10 module (parent answering about a younger child)
  "289909887":"under10","289909889":"under10","289909891":"under10","289909893":"under10",
  "289909894":"under10","289909896":"under10",
  // CHILD module (10-17 self-report, plus the parent-proxy disability & wellbeing matrices about the child)
  "289909840":"child","292468426":"child","289909846":"child","289909847":"child","289909848":"child",
  "289909851":"child","289909852":"child","289909853":"child","289909854":"child","289909857":"child",
  "289909858":"child","289909881":"child","289909860":"child","289909861":"child","289911742":"child",
  "289909905":"child","289909865":"child","289909876":"child","289909864":"child","289909866":"child",
};
const CATALOG_MODULE_ORDER = ["parent","pregnant","under10","child"];

// Taxonomy: each question's Research Objective(s) and AFC Domain(s), from the agreed
// categorization. ro is an array (usually one); domains is an array (often several).
// Domain codes: OS=Outdoor Spaces & Buildings, TR=Transportation, HO=Housing,
// SP=Social Participation, RI=Respect & Social Inclusion, CP=Civic Participation & Employment,
// CI=Communication & Information, HS=Community Support & Health Services.
const QUESTION_TAXONOMY = {
  "289909815":{ro:[1],domains:["CI"]}, "289909920":{ro:[1],domains:["RI"]}, "289909887":{ro:[1],domains:["RI"]},
  "289909846":{ro:[1],domains:["CI"]}, "289909847":{ro:[1],domains:["RI"]},
  "289909822":{ro:[2],domains:["HS"]}, "289909880":{ro:[2],domains:["HS"]}, "289909908":{ro:[2],domains:["CI","HS"]},
  "289909910":{ro:[2],domains:["TR","HS"]}, "289909911":{ro:[2],domains:["HS"]}, "289909889":{ro:[2],domains:["HS"]},
  "289909848":{ro:[2],domains:["RI","HS"]}, "289909881":{ro:[2],domains:["HS"]},
  "289909818":{ro:[3],domains:["CP"]}, "289909819":{ro:[3],domains:["CP"]}, "289909913":{ro:[3],domains:["CP","HS"]},
  "289909851":{ro:[3],domains:["CP"]}, "289909852":{ro:[3],domains:["CP","CI"]}, "289909866":{ro:[3],domains:["CP"]},
  "289909837":{ro:[5,3],domains:["CP"]},
  "289909820":{ro:[4],domains:["SP"]}, "289909821":{ro:[4],domains:["SP","RI"]}, "289909823":{ro:[4],domains:["SP"]},
  "289909825":{ro:[4],domains:["OS"]}, "289909826":{ro:[4],domains:["OS"]}, "289909827":{ro:[4],domains:["OS"]},
  "289909921":{ro:[4],domains:["OS","RI"]}, "289909828":{ro:[4],domains:["OS","TR"]}, "289909829":{ro:[4],domains:["TR"]},
  "289909830":{ro:[4],domains:["OS","TR"]}, "289909831":{ro:[4],domains:["RI"]}, "289909832":{ro:[4],domains:["CI"]},
  "289909915":{ro:[4],domains:["HO"]}, "289909916":{ro:[4],domains:["HO","HS"]}, "289909891":{ro:[4],domains:["SP","OS"]},
  "289909893":{ro:[4],domains:["OS"]}, "289909894":{ro:[4],domains:["OS","TR"]}, "289909853":{ro:[4],domains:["SP"]},
  "289909854":{ro:[4],domains:["SP"]}, "289909857":{ro:[4],domains:["OS","RI"]}, "289909858":{ro:[4],domains:["OS"]},
  "289909860":{ro:[4],domains:["TR","RI"]}, "289909861":{ro:[4],domains:["CI"]}, "289909840":{ro:[4],domains:["RI"]},
  "292468426":{ro:[4],domains:["HS"]}, "289909905":{ro:[4],domains:["HS"]}, "289911742":{ro:[4],domains:["HS"]},
  "289909834":{ro:[5],domains:["HS"]}, "289909835":{ro:[5],domains:["OS","HO","HS"]}, "289909836":{ro:[5],domains:["CP"]},
  "289909918":{ro:[5],domains:["HS"]}, "289909896":{ro:[5],domains:["OS","HS"]}, "289909865":{ro:[5],domains:["OS","TR"]},
  "289909876":{ro:[5],domains:["CP"]}, "289909864":{ro:[5],domains:["HS"]},
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
const DOMAIN_ORDER = ["OS","TR","HO","SP","RI","CP","CI","HS"];

// Build the catalog (labels/type/options/rows) from the English survey question map.
function buildQuestionCatalog(engQMap) {
  const cat = {};
  for (const [engId, mod] of Object.entries(CATALOG_MODULE)) {
    const q = engQMap[engId];
    if (!q) continue;
    const fam = q.family || "";
    const choiceVals = Object.values(q.choices || {});
    const menuVals = Object.values(q.menuChoices || {});
    const rowVals = Object.values(q.rows || {});
    let type, options, rows = [];
    if (/matrix/i.test(fam)) {
      type = "matrix";
      options = menuVals.length ? menuVals : choiceVals;
      rows = rowVals;
    } else if (/multiple_choice/i.test(fam)) {
      type = "multi"; options = choiceVals;
    } else {
      type = "single"; options = choiceVals;
    }
    cat[engId] = { module: mod, heading: (q.heading || "").replace(/<[^>]+>/g, "").trim(), type, options, rows,
                   ro: (QUESTION_TAXONOMY[engId]?.ro) || [], domains: (QUESTION_TAXONOMY[engId]?.domains) || [] };
  }
  return cat;
}

// Per-survey index maps: choice_id/row_id -> position index (position-anchored to English order)
function buildIndexMaps(qMap, qid) {
  const q = qMap[qid] || {};
  const choiceIndexById = {}; Object.keys(q.choices || {}).forEach((id, i) => { choiceIndexById[id] = i; });
  const rowIndexById = {};    Object.keys(q.rows || {}).forEach((id, i) => { rowIndexById[id] = i; });
  const menuIndexById = {};   Object.keys(q.menuChoices || {}).forEach((id, i) => { menuIndexById[id] = i; });
  return { choiceIndexById, rowIndexById, menuIndexById };
}

// Code a response's answers for each catalog question into compact indices.
// catalogForSurvey: { engId: { qid, type, choiceIndexById, rowIndexById, menuIndexById } }
function codeAnswers(r, catalogForSurvey) {
  const qa = {};
  for (const [engId, c] of Object.entries(catalogForSurvey)) {
    if (!c.qid) continue;
    // gather this question's answer objects from the response
    let answers = null;
    for (const page of (r.pages || [])) {
      for (const q of (page.questions || [])) {
        if (q.id === c.qid) { answers = q.answers || []; break; }
      }
      if (answers) break;
    }
    if (!answers || !answers.length) continue;

    if (c.type === "single") {
      const idx = c.choiceIndexById[answers[0].choice_id];
      if (idx !== undefined) qa[engId] = idx;
    } else if (c.type === "multi") {
      const idxs = answers.map(a => c.choiceIndexById[a.choice_id]).filter(i => i !== undefined);
      if (idxs.length) qa[engId] = idxs;
    } else if (c.type === "matrix") {
      const rowMap = {};
      for (const a of answers) {
        const ri = c.rowIndexById[a.row_id];
        const ci = (c.menuIndexById && c.menuIndexById[a.choice_id] !== undefined)
          ? c.menuIndexById[a.choice_id]
          : c.choiceIndexById[a.choice_id];
        if (ri !== undefined && ci !== undefined) rowMap[ri] = ci;
      }
      if (Object.keys(rowMap).length) qa[engId] = rowMap;
    }
  }
  return qa;
}


function matchDUN(text) {
  if (!text) return null;
  let lower = text.toLowerCase().trim();
  // Normalise common spelling variants
  lower = lower
    .replace(/\blancang\b/g, "lanchang")
    .replace(/\bglugor\b/g, "gelugor")
    .replace(/\bbubuk\b/g, "bubok")
    .replace(/\btelok\b/g, "teluk")
    .replace(/\bayer\b/g, "air")
    .replace(/\btanjung\b/g, "tanjong")
    .replace(/\s+/g, " ");
  if (DUN_DISTRICT[lower]) return lower;
  // Exact match against normalised DUN keys
  for (const dun of Object.keys(DUN_DISTRICT)) {
    if (lower === dun) return dun;
  }
  // Containment match (DUN name appears within answer text)
  for (const dun of Object.keys(DUN_DISTRICT)) {
    if (lower.includes(dun)) return dun;
  }
  return null;
}

function matchPattern(text, map) {
  if (!text) return null;
  for (const { pattern, value } of map) {
    if (pattern.test(text)) return value;
  }
  return null;
}

function extractAge(text) {
  if (!text) return null;
  const m = text.match(/\b(1[0-7]|[0-9])\b/);
  if (!m) return null;
  const age = parseInt(m[1]);
  if (age >= 10 && age <= 12) return "10-12";
  if (age >= 13 && age <= 16) return "13-16";
  if (age === 17) return "17";
  return null;
}

// ─── Question identifier ───────────────────────────────────────────────────────
// Question IDs differ across the 4 language surveys, so identify by content.
// English IDs kept as fallback hints only.
const KNOWN_DUN_NAMES = /air itam|air putih|komtar|bayan lepas|tanjong bunga|bagan dalam|bagan jermal|seberang jaya|bukit tambun|machang bubuk|sungai bakap/i;

function identifyQuestions(qMap) {
  const ids = {
    dunIsland: null, dunSeberang: null,
    ethnicity: null, income: null, childAge: null,
    childGender: null, parentGender: null, marital: null,
    status: null, disability: [], crg: null,
  };

  const dunCandidates = [];

  for (const [qId, q] of Object.entries(qMap)) {
    const heading = (q.heading || "").toLowerCase();
    const choiceVals = Object.values(q.choices || {});
    const choiceText = choiceVals.join(" ").toLowerCase();

    // DUN questions: choices contain known romanised DUN names (same in all languages)
    if (choiceVals.length > 5 && KNOWN_DUN_NAMES.test(choiceText)) {
      // Island list contains AIR ITAM/KOMTAR; Seberang contains BAGAN DALAM/SEBERANG JAYA
      if (/air itam|komtar|bayan lepas|tanjong bunga|pulau tikus/i.test(choiceText)) {
        dunCandidates.push({ qId, type: "island", n: choiceVals.length });
      } else if (/bagan dalam|seberang jaya|bukit tambun|machang|sungai bakap/i.test(choiceText)) {
        dunCandidates.push({ qId, type: "seberang", n: choiceVals.length });
      }
      continue;
    }

    // Ethnicity: choices contain Malay/Chinese/Indian (romanised or local-language) 
    if (!ids.ethnicity && /\bmalay\b|melayu|chinese|cina|\bindian\b|\bindia\b|bumiputera|马来|华人|印度|மலாய்|சீன|இந்திய/i.test(choiceText) && choiceVals.length >= 3 && choiceVals.length <= 8) {
      ids.ethnicity = qId;
      continue;
    }

    // Income: choices contain RM amounts
    if (!ids.income && /rm\s*\d|rm2,4|rm2,5|less than rm|prefer not/i.test(choiceText)) {
      ids.income = qId;
      continue;
    }

    // Child gender: heading references child + gender (multilingual)
    if (!ids.childGender && /child.{0,12}(gender|sex)|anak.{0,12}jantina|jantina.{0,12}anak|孩子.{0,4}性别|குழந்தை.{0,8}பாலின/i.test(heading) && choiceVals.length >= 2 && choiceVals.length <= 4) {
      ids.childGender = qId;
      continue;
    }

    // Parent gender: heading is gender but not child
    if (!ids.parentGender && /\bgender\b|jantina|您的性别|性别|பாலினம்/i.test(heading) && !/child|anak|孩子|குழந்தை/i.test(heading) && choiceVals.length >= 2 && choiceVals.length <= 4) {
      ids.parentGender = qId;
      continue;
    }

    // Child age: heading references child age 10-17, choices are numbers
    if (!ids.childAge && /age.{0,15}child|child.{0,15}age|umur.{0,12}anak|anak.{0,12}umur|孩子.{0,6}(年龄|岁)|குழந்தை.{0,10}வய+/i.test(heading) && choiceVals.some(c => /^1[0-7]$/.test(String(c).trim()))) {
      ids.childAge = qId;
      continue;
    }

    // Household / marital: heading references household composition
    if (!ids.marital && /household|describes your (family|household)|isi rumah|keluarga|家庭|குடும்ப/i.test(heading) && /single|two.?parent|tunggal|dua ibu|单亲|双亲|தனி|இரு/i.test(choiceText)) {
      ids.marital = qId;
      continue;
    }

    // Status in Malaysia: refugee/stateless choices
    if (!ids.status && /refugee|stateless|pelarian|tanpa negara|难民|无国籍|அகதி/i.test(choiceText)) {
      ids.status = qId;
      continue;
    }

    // Child Reference Group question: distinctive heading (multilingual), free-text contact field.
    // Matches CRG naming across languages: EN "Child Reference Group", MS "Kumpulan Rujukan Kanak-Kanak",
    // ZH "儿童顾问小组"/"儿童参考小组", TA "குழந்தைகள்...குழு". Only accept open-ended (contact) questions.
    if (!ids.crg
        && /child reference group|reference group|kumpulan rujukan kanak|儿童顾问小组|儿童参考小组|குழந்தைகள்.{0,20}குழு/i.test(heading)
        && /open_ended/i.test(q.family || "")) {
      ids.crg = qId;
      continue;
    }

    // Disability: Washington Group Short Set. It's a matrix (often matrix/menu) whose
    // ROWS mention difficulty - the difficulty scale lives in the row menus, not the
    // heading, so detect by matrix family + rows containing "difficulty" (multilingual).
    const rowVals = Object.values(q.rows || {});
    const rowText = rowVals.join(" ").toLowerCase();
    if (/matrix/i.test(q.family || "") &&
        rowVals.length >= 2 &&
        (rowText.match(/difficulty|kesukaran|sukar|困难|难以|சிரமம்|கடினம்/g) || []).length >= 2) {
      ids.disability.push(qId);
      continue;
    }
  }

  // Resolve DUN candidates: pick the largest island list and largest Seberang list
  const islands = dunCandidates.filter(c => c.type === "island").sort((a,b) => b.n - a.n);
  const seberangs = dunCandidates.filter(c => c.type === "seberang").sort((a,b) => b.n - a.n);
  ids.dunIsland = islands[0]?.qId || null;
  ids.dunSeberang = seberangs[0]?.qId || null;
  ids.dun = ids.dunIsland;

  return ids;
}

// ─── SurveyMonkey API ──────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Minimum gap between API calls to stay under SurveyMonkey's per-minute limit (120/min).
const SM_CALL_SPACING_MS = 600;
let _lastSmCall = 0;

async function smGet(path, attempt = 1) {
  const MAX_ATTEMPTS = 5;

  // Space out calls so we don't burst past the per-minute limit
  const since = Date.now() - _lastSmCall;
  if (since < SM_CALL_SPACING_MS) await sleep(SM_CALL_SPACING_MS - since);
  _lastSmCall = Date.now();

  let res;
  try {
    res = await fetch(`${SM_BASE}${path}`, {
      headers: { Authorization: `Bearer ${SM_TOKEN}`, "Content-Type": "application/json" },
    });
  } catch (networkErr) {
    // Transient network failure - retry with backoff
    if (attempt < MAX_ATTEMPTS) {
      const wait = 1000 * Math.pow(2, attempt - 1);
      console.log(`  Network error on ${path} (attempt ${attempt}) - retrying in ${wait/1000}s`);
      await sleep(wait);
      return smGet(path, attempt + 1);
    }
    throw networkErr;
  }

  if (res.status === 429) {
    if (attempt < MAX_ATTEMPTS) {
      // Honour Retry-After header if present, else exponential backoff (longer for rate limits)
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : 5000 * Math.pow(2, attempt - 1);
      console.log(`  Rate limited on ${path} (attempt ${attempt}) - waiting ${Math.round(wait/1000)}s before retry`);
      await sleep(wait);
      return smGet(path, attempt + 1);
    }
    const body = await res.text();
    throw new Error(`SM API error 429 on ${path} after ${MAX_ATTEMPTS} attempts: ${body}`);
  }

  if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
    // Server-side hiccup - retry
    const wait = 2000 * Math.pow(2, attempt - 1);
    console.log(`  Server error ${res.status} on ${path} (attempt ${attempt}) - retrying in ${wait/1000}s`);
    await sleep(wait);
    return smGet(path, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SM API error ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

async function fetchSurveyDetails(surveyId) {
  return smGet(`/surveys/${surveyId}/details`);
}

function buildChoiceMap(details) {
  const qMap = {};
  let pos = 0;
  for (const page of (details.pages || [])) {
    for (const q of (page.questions || [])) {
      const entry = {
        heading: q.headings?.[0]?.heading || "",
        choices: {}, rows: {},
        family: q.family || "", subtype: q.subtype || "",
        position: pos,
      };
      pos++;
      const ans = q.answers || {};
      if (Array.isArray(ans.choices)) {
        for (const c of ans.choices) entry.choices[c.id] = c.text;
      }
      if (Array.isArray(ans.rows)) {
        for (const r of ans.rows) entry.rows[r.id] = r.text;
      }
      // matrix/menu: answer options live under cols[].choices (shared across rows)
      entry.menuChoices = {};
      if (Array.isArray(ans.cols)) {
        for (const col of ans.cols) {
          if (Array.isArray(col.choices)) for (const c of col.choices) entry.menuChoices[c.id] = c.text;
        }
      }
      if (ans.other) {
        const others = Array.isArray(ans.other) ? ans.other : [ans.other];
        for (const o of others) if (o.id) entry.choices[o.id] = o.text || "Other";
      }
      qMap[q.id] = entry;
    }
  }
  return qMap;
}

async function fetchAllResponses(surveyId) {
  const responses = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const data = await smGet(`/surveys/${surveyId}/responses/bulk?per_page=100&page=${page}`);
    responses.push(...(data.data || []));
    hasMore = data.links?.next != null;
    page++;
  }
  return responses;
}

// Fetch only responses modified at/after a timestamp (ISO string). Used for incremental runs.
async function fetchResponsesSince(surveyId, sinceISO) {
  const responses = [];
  let page = 1, hasMore = true;
  const q = `start_modified_at=${encodeURIComponent(sinceISO)}&sort_by=date_modified&sort_order=ASC`;
  while (hasMore) {
    const data = await smGet(`/surveys/${surveyId}/responses/bulk?per_page=100&page=${page}&${q}`);
    responses.push(...(data.data || []));
    hasMore = data.links?.next != null;
    page++;
  }
  return responses;
}

// Load the anonymised record cache. Returns { lastModified, records:{id->rec} } or null.
function loadCache() {
  const fs = require("fs");
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.records || !parsed.lastModified) return null;
    const count = Object.keys(parsed.records).length;
    if (count === 0) return null;
    console.log(`Loaded cache: ${count} records, last modified ${parsed.lastModified}`);
    return parsed;
  } catch (e) {
    console.log(`Cache unreadable (${e.message}) - will do a full fetch.`);
    return null;
  }
}

function saveCache(recordsById, lastModifiedISO) {
  const fs = require("fs");
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ version:2, lastModified:lastModifiedISO, records:recordsById }));
    console.log(`Saved cache: ${Object.keys(recordsById).length} records, lastModified ${lastModifiedISO}`);
  } catch (e) {
    console.log(`WARNING: could not save cache: ${e.message}`);
  }
}

function getAnswerText(response, questionId, qMap) {
  if (!questionId) return null;
  const qInfo = qMap[questionId] || {};
  for (const page of (response.pages || [])) {
    for (const q of (page.questions || [])) {
      if (q.id === questionId) {
        const texts = (q.answers || []).map(a => {
          if (a.choice_id && qInfo.choices?.[a.choice_id]) return qInfo.choices[a.choice_id];
          if (a.row_id && qInfo.rows?.[a.row_id]) return qInfo.rows[a.row_id];
          if (a.other_id && qInfo.choices?.[a.other_id]) return qInfo.choices[a.other_id];
          if (a.text) return a.text;
          // Fallback: choice_id present but not in map — return the raw id so we can debug
          if (a.choice_id) return `__unmapped_choice:${a.choice_id}`;
          return null;
        }).filter(Boolean);
        return texts.length ? texts.join(", ") : null;
      }
    }
  }
  return null;
}

// Washington Group standard cut-off: "a lot of difficulty" or "cannot do at all"
// on at least one functional domain. Matches answer TEXT across all four languages.
const WG_STD_CUTOFF = /a lot of difficulty|banyak kesukaran|很多困难|非常困难|மிகவும் சிரமம்|அதிக|cannot do at all|tidak boleh|tidak dapat|langsung tidak|完全无法|完全不能|முடியாது|செய்ய முடியாது/i;

function hasDisability(response, disabilityIds, qMap) {
  for (const qId of disabilityIds) {
    const qInfo = qMap[qId] || {};
    for (const page of (response.pages || [])) {
      for (const q of (page.questions || [])) {
        if (q.id !== qId) continue;
        for (const a of (q.answers || [])) {
          // matrix/menu answers: choice_id points into the shared menu choices
          const colText = (a.choice_id && qInfo.menuChoices?.[a.choice_id]) ? qInfo.menuChoices[a.choice_id]
                        : (a.choice_id && qInfo.choices?.[a.choice_id]) ? qInfo.choices[a.choice_id]
                        : (a.text || null);
          if (colText && WG_STD_CUTOFF.test(colText)) return true;
        }
      }
    }
  }
  return false;
}

// ─── Incremental architecture: classify ONE response into an anonymised record ──
// A record contains only classified categories + flags - no free text, no contact
// details, no names, no raw DUN text. Safe to cache. Returns null if not started.
function classifyOneResponse(r, language, qMap, questionIds, outcomeIds, catalogForSurvey) {
  const isStarted = r.response_status === "partial" || r.response_status === "completed";
  if (!isStarted) return null;
  const isCompleted = r.response_status === "completed";
  const dateStr = r.date_created ? r.date_created.split("T")[0] : null;

  const rec = { id: r.id, lang: language, status: r.response_status, date: dateStr };

  if (!isCompleted) {
    // Started-only: record furthest-answered question position for drop-off analysis.
    let maxPos = -1;
    const posById = {};
    let i = 0;
    for (const qId of Object.keys(qMap)) posById[qId] = i++;
    for (const page of (r.pages || [])) {
      for (const q of (page.questions || [])) {
        const pos = posById[q.id];
        if (pos !== undefined && pos > maxPos && (q.answers || []).length > 0) maxPos = pos;
      }
    }
    rec.dropPos = maxPos;
    return rec;
  }

  // Completed: full classification (identical logic to the original loop)
  const dunText = getAnswerText(r, questionIds.dunIsland, qMap) || getAnswerText(r, questionIds.dunSeberang, qMap);
  const dunKey = matchDUN(dunText);
  rec.hadDun = !!dunText;
  rec.district = dunKey ? DUN_DISTRICT[dunKey] : null;
  rec.dun = dunKey ? DUN_CANONICAL[dunKey] : null; // canonical DUN name for local-gaps analysis
  rec.urbanRural = dunKey ? DUN_URBAN[dunKey] : null;
  rec.unmatchedDun = (dunText && !rec.district) ? dunText : null; // transient; used for logging only, not aggregated

  const ethText = getAnswerText(r, questionIds.ethnicity, qMap);
  rec.ethnicity = matchPattern(ethText, ETH_MAP) || "Others";

  rec.income = matchIncome(getAnswerText(r, questionIds.income, qMap));
  rec.ageGroup = extractAge(getAnswerText(r, questionIds.childAge, qMap));
  rec.gender = matchPattern(getAnswerText(r, questionIds.childGender, qMap), GENDER_MAP);

  const maritalText = getAnswerText(r, questionIds.marital, qMap);
  rec.singleParent = !!(maritalText && /single.?parent|one.?parent|single|divorced|widowed|ibu tunggal|bapa tunggal|bercerai|balu|janda|单亲|离婚|丧偶|தனி|விவாகரத்து|விதவை/i.test(maritalText));

  rec.disabled = hasDisability(r, questionIds.disability, qMap);
  // Migration status from Q8 "status in Malaysia" (multi-select). Merged vulnerable group =
  // Refugee + Stateless + Undocumented. Excludes documented migrants, expats, PR, MM2H, spouses.
  const statusText = getAnswerText(r, questionIds.status, qMap);
  rec.refugee = !!(statusText && /refugee|stateless|undocumented|pelarian|tanpa negara|tanpa kewarganegaraan|tiada dokumen|tidak berdokumen|tanpa dokumen|难民|无国籍|无证|அகதி|நாடற்ற|ஆவணமற்ற|ஆவணமில/i.test(statusText));

  // CRG sign-up: presence/absence of contact text only, never the text itself.
  let crgSignup = false;
  if (questionIds.crg) {
    for (const page of (r.pages || [])) {
      for (const q of (page.questions || [])) {
        if (q.id === questionIds.crg) {
          for (const a of (q.answers || [])) {
            if (a.text && String(a.text).trim().length > 0) { crgSignup = true; break; }
          }
        }
      }
    }
  }
  rec.crg = crgSignup;

  // Outcome concerning flags for answered scored outcomes
  const o = {};
  for (const od of SCORED_OUTCOMES) {
    const qid = outcomeIds?.[od.id];
    if (!qid) continue;
    const ans = getAnswerText(r, qid, qMap);
    if (ans == null || ans === "") continue;
    o[od.id] = od.concerning(ans) ? 1 : 0;
  }
  rec.o = o;

  // Parent-child disparity flags per parallel theme
  const disp = {};
  for (const p of PARALLEL_PAIRS) {
    const entry = {};
    const parentQ = outcomeIds?.[p.parent], childQ = outcomeIds?.[p.child];
    if (parentQ) {
      const a = getAnswerText(r, parentQ, qMap);
      const def = SCORED_OUTCOMES.find(x => x.id === p.parent);
      if (a != null && a !== "" && def) entry.p = def.concerning(a) ? 1 : 0;
    }
    if (childQ) {
      const a = getAnswerText(r, childQ, qMap);
      const def = SCORED_OUTCOMES.find(x => x.id === p.child);
      if (a != null && a !== "" && def) entry.c = def.concerning(a) ? 1 : 0;
    }
    if (entry.p !== undefined || entry.c !== undefined) disp[p.theme] = entry;
  }
  rec.disp = disp;

  // Coded answers for the question-by-question browser (only if a catalog is supplied)
  if (catalogForSurvey) rec.qa = codeAnswers(r, catalogForSurvey);

  return rec;
}

// ─── Aggregate anonymised records into the data.json structure ──────────────────
// Arithmetic mirrors classifyAllResponses exactly, reading record fields instead of
// raw answers. qMapsByLang is used only to map drop-off positions to headings.
function aggregateRecords(records, qMapsByLang) {
  const result = buildEmptyResult();
  let completedWithDunAnswer = 0;
  const unmatchedDUN = {};
  // drop-off: per language, position -> count of partials whose furthest answer was there
  const dropByLang = {};

  for (const rec of records) {
    if (!rec) continue;
    result.totalStarted++;
    if (result.byLanguage[rec.lang]) result.byLanguage[rec.lang].started++;
    if (rec.date) {
      if (!result.byDate[rec.date]) result.byDate[rec.date] = { started:0, completed:0 };
      result.byDate[rec.date].started++;
    }

    if (rec.status !== "completed") {
      // drop-off accumulation for partials
      if (typeof rec.dropPos === "number" && rec.dropPos >= 0) {
        if (!dropByLang[rec.lang]) dropByLang[rec.lang] = {};
        dropByLang[rec.lang][rec.dropPos] = (dropByLang[rec.lang][rec.dropPos] || 0) + 1;
      }
      continue;
    }

    result.totalCompleted++;
    if (result.byLanguage[rec.lang]) result.byLanguage[rec.lang].completed++;
    if (rec.date) result.byDate[rec.date].completed++;

    const { district, urbanRural, ethnicity, income, ageGroup, gender } = rec;
    if (rec.hadDun) completedWithDunAnswer++;
    if (rec.unmatchedDun) unmatchedDUN[rec.unmatchedDun] = (unmatchedDUN[rec.unmatchedDun] || 0) + 1;

    if (district) {
      result.crossTab[district][ethnicity]++;
      if (income) result.incomeByDistrict[district][income]++;
      if (ageGroup) result.ageByDistrict[district][ageGroup]++;
      if (gender) result.genderByDistrict[district][gender]++;
    } else {
      result.noDistrict++;
    }
    if (rec.dun) result.byDUN[rec.dun] = (result.byDUN[rec.dun] || 0) + 1;

    if (gender) {
      result.byGender[gender]++;
      result.ethnicityByGender[ethnicity][gender]++;
      if (ageGroup) result.ageByGender[ageGroup][gender]++;
      if (income) result.incomeByGender[income][gender]++;
    }
    if (income) {
      result.byIncome[income]++;
      result.ethnicityByIncome[ethnicity][income]++;
      if (ageGroup) result.incomeByAge[income][ageGroup]++;
    }
    if (ageGroup) result.ethnicityByAge[ethnicity][ageGroup]++;
    if (urbanRural) result.byUrbanRural[urbanRural]++;
    if (rec.disabled) result.vulnerableGroups["Children with disability"]++;
    if (rec.singleParent) result.vulnerableGroups["Single-parent households"]++;
    if (rec.refugee) result.vulnerableGroups["Refugees / undocumented"]++;

    // Refugee/Stateless/Undocumented monitored count + single-lens breakdowns
    if (rec.refugee) {
      result.migration.total++;
      if (district) result.migration.byDistrict[district]++;
      if (gender) result.migration.byGender[gender]++;
      if (ageGroup) result.migration.byAge[ageGroup]++;
      result.migration.byIncome[income || "Not stated"]++;
    }

    if (rec.crg) {
      result.crg.total++;
      if (district) result.crg.byDistrict[district]++;
      result.crg.byEthnicity[ethnicity]++;
      result.crg.byIncome[income || "Not stated"]++;
      if (gender) result.crg.byGender[gender]++;
      if (urbanRural) result.crg.byUrbanRural[urbanRural]++;
      if (ageGroup) {
        result.crg.byAge[ageGroup]++;
        if (ageGroup === "13-16") result.crg.eligible1316++;
      }
    }

    // Outcomes
    const lensVals = {
      gender, ageGroup, income, urbanRural,
      disability: rec.disabled ? "Disabled" : "Not disabled",
      migration: rec.refugee ? "Migrant/refugee" : "Citizen",
    };
    const oflags = rec.o || {};
    for (const od of SCORED_OUTCOMES) {
      const f = oflags[od.id];
      if (f === undefined) continue;
      const acc = result.outcomes[od.id];
      acc.overall.n++; if (f === 1) acc.overall.c++;
      for (const lk of LENS_KEYS) {
        const v = lensVals[lk];
        if (v && acc.byLens[lk][v]) { acc.byLens[lk][v].n++; if (f === 1) acc.byLens[lk][v].c++; }
      }
    }
    if (Object.keys(oflags).length > 0) {
      result.outcomeRows.push({
        g: gender || null, a: ageGroup || null, i: income || null, u: urbanRural || null,
        d: rec.disabled ? 1 : 0, m: rec.refugee ? 1 : 0, o: oflags,
      });
    }

    // Question-by-question microdata (coded answers + lens values)
    if (rec.qa && Object.keys(rec.qa).length > 0) {
      result.questionRows.push({
        g: gender || null, a: ageGroup || null, i: income || null, u: urbanRural || null,
        d: rec.disabled ? 1 : 0, m: rec.refugee ? 1 : 0, q: rec.qa,
      });
    }

    // Disparity
    const disp = rec.disp || {};
    for (const p of PARALLEL_PAIRS) {
      const dd = disp[p.theme];
      if (!dd) continue;
      if (dd.p !== undefined) { result.disparity[p.theme].parent.n++; if (dd.p) result.disparity[p.theme].parent.c++; }
      if (dd.c !== undefined) { result.disparity[p.theme].child.n++; if (dd.c) result.disparity[p.theme].child.c++; }
    }

    // Daily breakdowns
    if (rec.date) {
      const bd = (obj, key) => { if (!obj[rec.date]) obj[rec.date] = {}; if (key) obj[rec.date][key] = (obj[rec.date][key] || 0) + 1; };
      if (district)   bd(result.byDateByDistrict, district);
      if (ethnicity)  bd(result.byDateByEthnicity, ethnicity);
      if (income)     bd(result.byDateByIncome, income);
      if (ageGroup)   bd(result.byDateByAge, ageGroup);
      if (gender)     bd(result.byDateByGender, gender);
      if (urbanRural) bd(result.byDateByUrbanRural, urbanRural);
    }
  }

  const dunCoverage = result.totalCompleted > 0 ? Math.round(completedWithDunAnswer / result.totalCompleted * 100) : 0;
  console.log(`DUN coverage: ${completedWithDunAnswer}/${result.totalCompleted} completed responses have district (${dunCoverage}%)`);
  if (Object.keys(unmatchedDUN).length > 0) console.log("Unmatched DUN values:", JSON.stringify(unmatchedDUN));

  // Drop-off print (position -> heading via each language's qMap)
  console.log("=== DROP-OFF ANALYSIS ===");
  for (const [lang, posCounts] of Object.entries(dropByLang)) {
    const qMap = qMapsByLang?.[lang];
    const headingByPos = {};
    if (qMap) { let i = 0; for (const qId of Object.keys(qMap)) { headingByPos[i] = (qMap[qId]?.heading || "").replace(/<[^>]+>/g, "").slice(0, 50); i++; } }
    const total = Object.values(posCounts).reduce((s, n) => s + n, 0);
    console.log(`\n${lang} - ${total} partial responses, top drop-off points:`);
    const sorted = Object.entries(posCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [pos, count] of sorted) {
      const pct = Math.round(count / total * 100);
      console.log(`  ${count} (${pct}%) last answered → pos${String(pos).padStart(3,"0")}: ${headingByPos[pos] || "(unknown)"}`);
    }
  }
  console.log("=== END DROP-OFF ===\n");

  return result;
}

// ─── Shared empty-result builder (used by both aggregation paths) ───────────────
function buildEmptyResult() {
  const result = {
    totalStarted: 0, totalCompleted: 0,
    byDate: {},
    byLanguage: { English:{started:0,completed:0}, Malay:{started:0,completed:0}, Mandarin:{started:0,completed:0}, Tamil:{started:0,completed:0} },
    crossTab: {},
    incomeByDistrict: {}, ageByDistrict: {}, genderByDistrict: {},
    ethnicityByGender: {}, ageByGender: {},
    byGender: { Male:0, Female:0, Other:0 },
    byIncome: { B40:0, M40:0, T20:0, "Not stated":0 },
    byUrbanRural: { Urban:0, "Peri-urban":0, Rural:0 },
    ethnicityByIncome: {}, ethnicityByAge: {}, incomeByAge: {}, incomeByGender: {},
    vulnerableGroups: { "Refugees / undocumented":0, "Children with disability":0, "Single-parent households":0, "Institutional care":0 },
    byDateByDistrict: {}, byDateByEthnicity: {}, byDateByIncome: {},
    byDateByAge: {}, byDateByGender: {}, byDateByUrbanRural: {},
    noDistrict: 0,
    crg: {
      total: 0, eligible1316: 0,
      byDistrict: {}, byEthnicity: { Malay:0, Chinese:0, Indian:0, Others:0 },
      byIncome: { B40:0, M40:0, T20:0, "Not stated":0 },
      byGender: { Male:0, Female:0 },
      byUrbanRural: { Urban:0, "Peri-urban":0, Rural:0 },
      byAge: { "10-12":0, "13-16":0, "17":0 },
    },
    outcomes: {},
    disparity: {},
    // Per-DUN completed-response counts for the Local Gaps tab
    byDUN: {},
    // Refugee/Stateless/Undocumented - monitored count with single-lens breakdowns (no quota)
    migration: {
      total: 0,
      byDistrict: { "Timur Laut":0,"Barat Daya":0,"SP Utara":0,"SP Tengah":0,"SP Selatan":0 },
      byGender: { Male:0, Female:0 },
      byAge: { "10-12":0, "13-16":0, "17":0 },
      byIncome: { B40:0, M40:0, T20:0, "Not stated":0 },
    },
    outcomeRows: [],
    // Per-response coded answers for the question-by-question browser (live lens filtering)
    questionRows: [],
    outcomeMeta: Object.fromEntries(SCORED_OUTCOMES.map(o => [o.id, { short:o.short, ro:o.ro, domain:o.domain, module:o.module }])),
  };
  const LENS_VALUES = {
    gender: ["Male","Female"], ageGroup: ["10-12","13-16","17"], income: ["B40","M40","T20"],
    urbanRural: ["Urban","Peri-urban","Rural"], disability: ["Disabled","Not disabled"], migration: ["Migrant/refugee","Citizen"],
  };
  for (const o of SCORED_OUTCOMES) {
    const byLens = {};
    for (const lk of LENS_KEYS) { byLens[lk] = {}; for (const v of LENS_VALUES[lk]) byLens[lk][v] = { c:0, n:0 }; }
    result.outcomes[o.id] = { meta:{ id:o.id, module:o.module, ro:o.ro, domain:o.domain, short:o.short }, overall:{ c:0, n:0 }, byLens };
  }
  for (const p of PARALLEL_PAIRS) result.disparity[p.theme] = { parent:{c:0,n:0}, child:{c:0,n:0} };
  for (const d of ["Timur Laut","Barat Daya","SP Utara","SP Tengah","SP Selatan"]) {
    result.crossTab[d] = { Malay:0, Chinese:0, Indian:0, Others:0 };
    result.incomeByDistrict[d] = { B40:0, M40:0, T20:0 };
    result.ageByDistrict[d] = { "10-12":0, "13-16":0, "17":0 };
    result.genderByDistrict[d] = { Male:0, Female:0 };
    result.crg.byDistrict[d] = 0;
  }
  for (const e of ["Malay","Chinese","Indian","Others"]) {
    result.ethnicityByGender[e] = { Male:0, Female:0 };
    result.ethnicityByIncome[e] = { B40:0, M40:0, T20:0 };
    result.ethnicityByAge[e] = { "10-12":0, "13-16":0, "17":0 };
  }
  for (const a of ["10-12","13-16","17"]) result.ageByGender[a] = { Male:0, Female:0 };
  for (const i of ["B40","M40","T20"]) { result.incomeByAge[i] = { "10-12":0, "13-16":0, "17":0 }; result.incomeByGender[i] = { Male:0, Female:0 }; }
  return result;
}

// ─── Classify all responses ────────────────────────────────────────────────────
function classifyAllResponses(surveyData) {
  // Full-fetch path: classify every raw response into records, then aggregate.
  // Kept as the fallback when no cache exists or incremental fetch is unavailable.
  const records = [];
  const qMapsByLang = {};
  for (const { language, responses, qMap, questionIds, outcomeIds, catalog } of surveyData) {
    qMapsByLang[language] = qMap;
    for (const r of responses) {
      const rec = classifyOneResponse(r, language, qMap, questionIds, outcomeIds, catalog);
      if (rec) records.push(rec);
    }
  }
  const result = aggregateRecords(records, qMapsByLang);
  result._records = records; // expose for cache building in full-fetch mode
  return result;
}

// ─── Report builder ────────────────────────────────────────────────────────────
function buildReport(data) {
  const today = new Date();
  const daysDiff = (a, b) => Math.floor((b - a) / 86400000);
  const de = Math.max(0, daysDiff(START_DATE, today));
  const dr = Math.max(0, daysDiff(today, END_DATE));
  const totalDays = daysDiff(START_DATE, END_DATE);
  const totalStarted = data.totalStarted || 0;
  const totalCompleted = data.totalCompleted || 0;
  const respPct = Math.min(100, Math.round(totalCompleted / TOTAL_TARGET * 100));
  const completionRate = totalStarted > 0 ? Math.round(totalCompleted / totalStarted * 100) : 0;
  const perDay = de > 0 ? Math.round(totalCompleted / de) : 0;
  const projected = de > 0 && dr > 0 ? totalCompleted + perDay * dr : null;

  const date = today.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
  const sep = "-".repeat(55);

  let body = `CHILD FRIENDLY PENANG - DAILY SURVEY UPDATE\n${date}\n${sep}\n\n`;
  body += `Survey day ${de} of ${totalDays} - ${dr} days remaining\n`;
  body += `Started: ${totalStarted.toLocaleString()} - Completed: ${totalCompleted.toLocaleString()} / ${TOTAL_TARGET.toLocaleString()} (${respPct}%)\n`;
  body += `Completion rate: ${completionRate}% - ~${perDay}/day`;
  if (projected) body += ` - Projected: ${projected.toLocaleString()}`;
  body += `\n\nTARGET TIERS:\n`;
  body += `  1D (${TOTAL_TARGET.toLocaleString()}): ${respPct}%\n`;
  body += `  2D (${STRETCH_2D.toLocaleString()}): ${Math.min(100, Math.round(totalCompleted / STRETCH_2D * 100))}%\n`;
  body += `  3D (${STRETCH_3D.toLocaleString()}): ${Math.min(100, Math.round(totalCompleted / STRETCH_3D * 100))}%\n\n`;

  // Active sub-target tier (Option A: locks to 3D once 2D reached)
  const mult = tierMultiplier(totalCompleted);
  const Q1 = scaleTable(Q_BASE, mult);
  const VG = { disability: VG_BASE.disability * mult, singleParent: VG_BASE.singleParent * mult };
  body += `Sub-targets tracking: ${mult === 2 ? "3D level (20,000)" : "2D level (10,000)"}\n\n`;

  body += `BY LANGUAGE:\n`;
  for (const [lang, ld] of Object.entries(data.byLanguage || {})) {
    const ls = ld.started || 0, lc = ld.completed || 0;
    body += `  ${lang}: ${lc} completed / ${ls} started (${ls>0?Math.round(lc/ls*100):0}%)\n`;
  }
  body += `\n`;

  const dims = [
    { label:"District", quotas:Q1.district, actions:ACTIONS.district,
      getActual:(cat)=>["Malay","Chinese","Indian","Others"].reduce((s,e)=>s+(data.crossTab?.[cat]?.[e]||0),0) },
    { label:"Ethnicity", quotas:Q1.ethnicity, actions:ACTIONS.ethnicity,
      getActual:(cat)=>["Timur Laut","Barat Daya","SP Utara","SP Tengah","SP Selatan"].reduce((s,d)=>s+(data.crossTab?.[d]?.[cat]||0),0) },
    { label:"Income", quotas:Q1.income, actions:ACTIONS.income,
      getActual:(cat)=>data.byIncome?.[cat]||0 },
    { label:"Gender", quotas:Q1.gender, actions:ACTIONS.gender,
      getActual:(cat)=>data.byGender?.[cat]||0 },
    { label:"Urban/Rural", quotas:Q1.urbanRural, actions:ACTIONS.urbanRural,
      getActual:(cat)=>data.byUrbanRural?.[cat]||0 },
  ];

  let anyBehind = false;
  for (const dim of dims) {
    const behind = [];
    for (const [cat, target] of Object.entries(dim.quotas)) {
      const actual = dim.getActual(cat);
      const pct = Math.round(actual / target * 100);
      if (pct < 75) behind.push({ cat, actual, target, pct, actions: dim.actions[cat] || [] });
    }
    if (behind.length > 0) {
      anyBehind = true;
      behind.sort((a,b) => a.pct - b.pct);
      body += `${dim.label.toUpperCase()} - ${behind.length} group(s) behind:\n`;
      for (const g of behind) {
        body += `  ${g.cat}: ${g.actual}/${g.target} (${g.pct}%)\n`;
        for (const a of g.actions.slice(0,2)) body += `    > ${a}\n`;
      }
      body += `\n`;
    }
  }
  if (!anyBehind) body += `All dimension groups currently on track.\n\n`;

  const vg = data.vulnerableGroups || {};
  body += `VULNERABLE GROUPS:\n`;
  body += `  Children with disability: ${vg["Children with disability"]||0} (target: ${VG.disability})\n`;
  body += `  Single-parent households: ${vg["Single-parent households"]||0} (target: ${VG.singleParent})\n`;
  body += `  Refugees / undocumented: ${vg["Refugees / undocumented"]||0}\n\n`;
  if (data.noDistrict > 0) body += `Note: ${data.noDistrict} responses missing district data.\n\n`;
  body += `${sep}\nAutomated daily report - Child Friendly Penang Survey Monitor\n`;
  return body;
}

// ─── Email ─────────────────────────────────────────────────────────────────────
async function sendEmail(body) {
  const shortDate = new Date().toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" });
  const transporter = nodemailer.createTransport({
    host: "smtp.office365.com", port: 587, secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_USER, to: EMAIL_TO.join(", "),
    subject: `CFP Survey Update - ${shortDate}`, text: body,
  });
  console.log(`Email sent to ${EMAIL_TO.join(", ")}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Starting daily report...`);

  console.log("Testing SM API connection...");
  await smGet("/surveys?per_page=1");
  console.log("SM API connected.");

  const surveyData = [];
  const statusCounts = {};
  const dunChoicesByLang = {}; // for spelling comparison
  for (const [lang, id] of Object.entries(SURVEY_IDS)) {
    console.log(`Reading ${lang} survey structure (${id})...`);
    const details = await fetchSurveyDetails(id);
    const qMap = buildChoiceMap(details);
    const questionIds = identifyQuestions(qMap);

    // Collect DUN dropdown choices for cross-survey spelling check
    dunChoicesByLang[lang] = {
      island: Object.values(qMap[questionIds.dunIsland]?.choices || {}),
      seberang: Object.values(qMap[questionIds.dunSeberang]?.choices || {}),
    };

    console.log(`  ${Object.keys(qMap).length} questions mapped`);
    console.log(`  Identified: islandDUN=${questionIds.dunIsland||"NO"} seberangDUN=${questionIds.dunSeberang||"NO"} eth=${questionIds.ethnicity||"NO"} inc=${questionIds.income||"NO"} age=${questionIds.childAge||"NO"} gen=${questionIds.childGender||questionIds.parentGender||"NO"} dis=${questionIds.disability.length} crg=${questionIds.crg||"NO"}`);
    surveyData.push({ language: lang, id, responses: [], qMap, questionIds });
  }

  // ── CRG cross-language anchoring ──
  // The four surveys share identical question structure, so the CRG question sits at
  // the same position in each. Use the English CRG position to fill any survey where
  // heading-based detection failed (translated wording the regex didn't catch).
  const engData = surveyData.find(s => s.language === "English");
  const engCrgPos = engData?.questionIds.crg ? engData.qMap[engData.questionIds.crg]?.position : null;
  console.log(`\n=== CRG DETECTION ===`);
  if (engCrgPos != null) {
    console.log(`English CRG question position: ${engCrgPos} (id ${engData.questionIds.crg})`);
    for (const sd of surveyData) {
      if (!sd.questionIds.crg) {
        // Find an open-ended (contact) question at or near the English position (±3),
        // never a presentation/descriptive_text block.
        let best = null;
        for (const [qId, q] of Object.entries(sd.qMap)) {
          if (!/open_ended/i.test(q.family || "")) continue;
          const dist = Math.abs((q.position ?? -999) - engCrgPos);
          if (dist <= 3 && (!best || dist < best.dist)) best = { qId, dist };
        }
        if (best) {
          sd.questionIds.crg = best.qId;
          console.log(`  ${sd.language}: CRG not found by heading - matched nearest open-ended question (within ${best.dist} of pos ${engCrgPos}) -> id ${best.qId}`);
        }
      }
    }
  } else {
    console.log(`WARNING: English CRG question not detected by heading. Check the heading regex.`);
  }
  // Report CRG question heading + family per survey for verification
  for (const sd of surveyData) {
    const q = sd.questionIds.crg ? sd.qMap[sd.questionIds.crg] : null;
    if (q) {
      console.log(`  ${sd.language}: crg id=${sd.questionIds.crg} family=${q.family}/${q.subtype} heading="${(q.heading||"").replace(/<[^>]+>/g,"").slice(0,55)}"`);
    } else {
      console.log(`  ${sd.language}: CRG QUESTION NOT FOUND`);
    }
  }
  console.log(`=== END CRG DETECTION ===\n`);

  // ── STATUS (Q8) CHOICE DUMP - to define refugee/stateless/undocumented merge ──
  console.log(`=== STATUS QUESTION (Q8) CHOICES ===`);
  for (const sd of surveyData) {
    const sid = sd.questionIds.status;
    if (!sid) { console.log(`  ${sd.language}: status question NOT identified`); continue; }
    const choices = Object.values(sd.qMap[sid]?.choices || {});
    console.log(`  ${sd.language} [${sid}] (${choices.length}): ${choices.join(" | ")}`);
  }
  console.log(`=== END STATUS CHOICES ===\n`);

  // ── DISABILITY QUESTION STRUCTURE DIAGNOSTIC ──
  // Current detection finds 0 disability questions (dis=0 in every run), so disabled
  // children are not being captured. Dump candidate questions to see the real structure.
  console.log(`=== DISABILITY STRUCTURE (English) ===`);
  if (engData) {
    let found = 0;
    for (const [qId, q] of Object.entries(engData.qMap)) {
      const h = (q.heading || "").toLowerCase();
      // Washington Group indicators: difficulty, or the function words, or "wear glasses"/"assistive"
      if (/difficult|seeing|hearing|walking|remember|self.?care|communicat|wash|dress|concentrat|glasses|aid/i.test(h)) {
        const rowVals = Object.values(q.rows || {});
        const choiceVals = Object.values(q.choices || {});
        console.log(`  [${qId}] fam=${q.family}/${q.subtype} pos=${q.position}`);
        console.log(`    heading: "${(q.heading||"").replace(/<[^>]+>/g,"").slice(0,70)}"`);
        if (rowVals.length) console.log(`    rows(${rowVals.length}): ${rowVals.slice(0,8).join(" | ").slice(0,120)}`);
        if (choiceVals.length) console.log(`    choices(${choiceVals.length}): ${choiceVals.slice(0,6).join(" | ").slice(0,120)}`);
        found++;
      }
    }
    if (!found) console.log(`  No disability-like questions found by keyword scan.`);
  }
  console.log(`=== END DISABILITY STRUCTURE ===\n`);

  // ── Resolve scored-outcome question IDs across all 4 surveys ──
  // English IDs are known; other surveys share structure, so map by position.
  // Build English position lookup for each outcome id, then find same-position id per survey.
  const engPosById = {};
  if (engData) {
    for (const [qId, q] of Object.entries(engData.qMap)) engPosById[qId] = q.position;
  }
  for (const sd of surveyData) {
    sd.outcomeIds = {}; // shortId -> this-survey questionId
    // position -> id lookup for this survey
    const idByPos = {};
    for (const [qId, q] of Object.entries(sd.qMap)) idByPos[q.position] = qId;
    for (const o of SCORED_OUTCOMES) {
      const engId = engQuestionId(o.id);
      const engPos = engPosById[engId];
      if (engPos == null) continue;
      // English survey: the real english id; others: same position
      sd.outcomeIds[o.id] = (sd.language === "English") ? engId : (idByPos[engPos] || null);
    }
    // Also resolve parallel-pair ids not in SCORED_OUTCOMES (e.g. 820)
    for (const p of PARALLEL_PAIRS) {
      for (const eid of [p.parent, p.child]) {
        if (sd.outcomeIds[eid] === undefined) {
          const engId = engQuestionId(eid);
          const engPos = engPosById[engId];
          sd.outcomeIds[eid] = engPos == null ? null : (sd.language === "English" ? engId : (idByPos[engPos] || null));
        }
      }
    }
  }
  const engOutcomeFound = SCORED_OUTCOMES.filter(o => engData?.outcomeIds?.[o.id]).length;
  console.log(`Scored outcomes resolved: ${engOutcomeFound}/${SCORED_OUTCOMES.length} in English; other surveys mapped by position.`);

  // ── Question-by-question catalog: build from English, resolve per survey by position ──
  const engQMap = engData?.qMap || {};
  const questionCatalog = buildQuestionCatalog(engQMap);
  // English position for each catalog question id
  const engPosByIdCat = {}; { let i = 0; for (const qId of Object.keys(engQMap)) { engPosByIdCat[qId] = i; i++; } }
  for (const sd of surveyData) {
    const idByPos = {}; { let i = 0; for (const qId of Object.keys(sd.qMap)) { idByPos[i] = qId; i++; } }
    const catalog = {};
    for (const engId of Object.keys(CATALOG_MODULE)) {
      const meta = questionCatalog[engId];
      if (!meta) continue;
      const engPos = engPosByIdCat[engId];
      const qid = (sd.language === "English") ? engId : (engPos != null ? idByPos[engPos] : null);
      if (!qid) continue;
      const maps = buildIndexMaps(sd.qMap, qid);
      catalog[engId] = { qid, type: meta.type, ...maps };
    }
    sd.catalog = catalog;
  }
  const catCount = Object.keys(questionCatalog).length;
  console.log(`Question catalog: ${catCount} substantive questions across modules (${CATALOG_MODULE_ORDER.join(", ")}).`);


  // ── DUN spelling check across all 4 surveys (uses question maps only) ──
  console.log("\n=== DUN SPELLING CHECK ===");
  for (const part of ["island", "seberang"]) {
    const base = (dunChoicesByLang.English?.[part] || []).map(s => s.toUpperCase().trim());
    console.log(`\n${part.toUpperCase()} - English baseline (${base.length}): ${base.join(" | ")}`);
    for (const lang of ["Malay", "Mandarin", "Tamil"]) {
      const other = (dunChoicesByLang[lang]?.[part] || []).map(s => s.toUpperCase().trim());
      const onlyBase = base.filter(x => !other.includes(x));
      const onlyOther = other.filter(x => !base.includes(x));
      if (!onlyBase.length && !onlyOther.length) console.log(`  ${lang}: identical ✓`);
      else {
        console.log(`  ${lang}: DIFFERS`);
        if (onlyOther.length) console.log(`    Only in ${lang}: ${onlyOther.join(", ")}`);
        if (onlyBase.length) console.log(`    Missing from ${lang}: ${onlyBase.join(", ")}`);
      }
    }
  }
  console.log("=== END DUN CHECK ===\n");

  // ── Cache-aware fetch + classify + aggregate ──
  // Incremental: only fetch responses modified since the last run, classify them into
  // anonymised records, merge into the cached record set, then aggregate everything.
  // Full fallback: if no valid cache, fetch everything once to build the cache.
  console.log("Classifying responses...");
  const runStartISO = new Date().toISOString();
  const cache = loadCache();
  let recordsById = {};
  let classified;
  const qMapsByLang = {};
  for (const sd of surveyData) qMapsByLang[sd.language] = sd.qMap;

  try {
    if (cache) {
      // INCREMENTAL: fetch only modified-since responses
      recordsById = { ...cache.records };
      const sinceISO = new Date(new Date(cache.lastModified).getTime() - CACHE_OVERLAP_MS).toISOString();
      console.log(`Incremental fetch: responses modified since ${sinceISO}`);
      let fetchedCount = 0;
      for (const sd of surveyData) {
        const fresh = await fetchResponsesSince(sd.id, sinceISO);
        fetchedCount += fresh.length;
        for (const r of fresh) {
          const st = r.response_status || "unknown";
          statusCounts[st] = (statusCounts[st] || 0) + 1;
          const rec = classifyOneResponse(r, sd.language, sd.qMap, sd.questionIds, sd.outcomeIds, sd.catalog);
          if (rec) recordsById[rec.id] = rec; // replace existing (handles partial->completed)
        }
        console.log(`  ${sd.language}: ${fresh.length} new/modified responses`);
      }
      console.log(`Incremental fetch complete: ${fetchedCount} responses pulled, ${Object.keys(recordsById).length} total in cache.`);
    } else {
      // FULL: fetch everything, build the cache from scratch
      console.log("No cache - performing a full fetch to build the record cache.");
      for (const sd of surveyData) {
        const responses = await fetchAllResponses(sd.id);
        for (const r of responses) {
          const st = r.response_status || "unknown";
          statusCounts[st] = (statusCounts[st] || 0) + 1;
          const rec = classifyOneResponse(r, sd.language, sd.qMap, sd.questionIds, sd.outcomeIds, sd.catalog);
          if (rec) recordsById[rec.id] = rec;
        }
        console.log(`  ${sd.language}: ${responses.length} responses classified`);
      }
    }
    // Persist the updated cache and aggregate
    saveCache(recordsById, runStartISO);
    classified = aggregateRecords(Object.values(recordsById), qMapsByLang);
  } catch (err) {
    // Safety net: if incremental fetch failed mid-way but we have a cache, aggregate
    // what we have so the dashboard still updates rather than the run dying.
    if (Object.keys(recordsById).length > 0) {
      console.log(`Fetch error (${err.message}) - aggregating records already in hand.`);
      classified = aggregateRecords(Object.values(recordsById), qMapsByLang);
    } else {
      throw err;
    }
  }
  classified.updatedAt = new Date().toISOString();
  classified.surveyQuestions = questionCatalog; // labels/type/options/rows/ro/domains for the browsers
  classified.questionModuleOrder = CATALOG_MODULE_ORDER;
  classified.roLabels = RO_LABELS;
  classified.domainLabels = DOMAIN_LABELS;
  classified.domainOrder = DOMAIN_ORDER;
  // DUN metadata for the Local Gaps tab: ordered list per district, with island/mainland flag
  classified.dunMeta = Object.entries(dunData).map(([district, info]) => ({
    district,
    island: ISLAND_DISTRICTS.has(district),
    duns: info.duns,
  }));
  console.log(`Response status breakdown (this run's fetch):`, JSON.stringify(statusCounts));

  console.log(`Classified: ${classified.totalStarted} started, ${classified.totalCompleted} completed`);
  console.log(`Districts:`, JSON.stringify(Object.fromEntries(Object.entries(classified.crossTab).map(([d,v])=>[d,Object.values(v).reduce((a,b)=>a+b,0)]))));
  console.log(`Ethnicity:`, JSON.stringify(Object.fromEntries(["Malay","Chinese","Indian","Others"].map(e=>[e,Object.values(classified.crossTab).reduce((s,d)=>s+(d[e]||0),0)]))));
  console.log(`noDistrict: ${classified.noDistrict}`);
  console.log(`CRG sign-ups: ${classified.crg.total} total (${classified.crg.eligible1316} aged 13-16, the eligible band) | by district: ${JSON.stringify(classified.crg.byDistrict)}`);

  // Intersectional outcomes summary (overall concerning rates)
  console.log(`\n=== INTERSECTIONAL OUTCOMES (overall concerning rate) ===`);
  for (const o of SCORED_OUTCOMES) {
    const acc = classified.outcomes[o.id];
    if (!acc || acc.overall.n === 0) { console.log(`  [RO${o.ro}] ${o.module}/${o.short}: no data`); continue; }
    const pct = Math.round(acc.overall.c / acc.overall.n * 100);
    console.log(`  [RO${o.ro}] ${o.module}/${o.short}: ${pct}% concerning (n=${acc.overall.n})`);
  }
  console.log(`=== PARENT-CHILD DISPARITY ===`);
  for (const [theme, d] of Object.entries(classified.disparity)) {
    const pp = d.parent.n>0?Math.round(d.parent.c/d.parent.n*100):null;
    const cp = d.child.n>0?Math.round(d.child.c/d.child.n*100):null;
    const gap = (pp!=null && cp!=null) ? `${Math.abs(pp-cp)}pt gap` : "incomplete";
    console.log(`  ${theme}: parent ${pp==null?"-":pp+"%"} vs child ${cp==null?"-":cp+"%"} (${gap})`);
  }
  console.log(`=== END OUTCOMES ===\n`);

  // Write data.json
  const fs = require("fs");
  const path = require("path");
  const docsDir = path.join(__dirname, "docs");
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "data.json"), JSON.stringify(classified, null, 2));
  console.log("Wrote docs/data.json");

  // Email (only at 9am MYT / 1am UTC)
  const report = buildReport(classified);
  console.log("\n--- REPORT PREVIEW ---\n" + report.slice(0, 600) + "...\n");

  const utcHour = new Date().getUTCHours();
  if (utcHour === 1) {
    await sendEmail(report);
  } else {
    console.log(`Skipping email (UTC hour ${utcHour}, only sends at 01:00 UTC / 9am MYT)`);
  }

  console.log(`[${new Date().toISOString()}] Done.`);
}

main().catch(err => {
  console.error("Report failed:", err.message || err);
  process.exit(1);
});
