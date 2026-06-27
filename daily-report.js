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
const dunData = {
  "Timur Laut": {
    duns: ["Tanjong Bunga","Air Putih","Air Itam","Kebun Bunga","Pulau Tikus","Padang Kota","Pengkalan Kota","Komtar","Datok Keramat","Sungai Pinang","Batu Lanchang","Seri Delima","Bukit Gelugor","Paya Terubong","Batu Uban"],
    urban: ["Tanjong Bunga","Air Putih","Air Itam","Kebun Bunga","Pulau Tikus","Padang Kota","Pengkalan Kota","Komtar","Datok Keramat","Sungai Pinang","Batu Lanchang","Seri Delima","Bukit Gelugor","Batu Uban"],
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
    DUN_DISTRICT[dun.toLowerCase()] = district;
    if (info.urban?.includes(dun)) DUN_URBAN[dun.toLowerCase()] = "Urban";
    else if (info.periurban?.includes(dun)) DUN_URBAN[dun.toLowerCase()] = "Peri-urban";
    else if (info.rural?.includes(dun)) DUN_URBAN[dun.toLowerCase()] = "Rural";
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

    // Disability: Washington Group - heading mentions difficulty + a function
    if (/difficulty|kesukaran|sukar|困难|难以|சிரமம்/i.test(heading) && /seeing|hearing|walking|remember|melihat|mendengar|berjalan|看|听|走|பார்|கேட்/i.test(heading)) {
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

function hasDisability(response, disabilityIds, qMap) {
  for (const qId of disabilityIds) {
    const text = getAnswerText(response, qId, qMap);
    if (text && DISABILITY_PATTERN.test(text)) return true;
  }
  return false;
}

// ─── Classify all responses ────────────────────────────────────────────────────
function classifyAllResponses(surveyData) {
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
    // CRG sign-ups (contact details left on the Child Reference Group question; 13-16 eligible)
    crg: {
      total: 0,                       // total sign-ups
      eligible1316: 0,                // sign-ups who are 13-16 (the eligible band)
      byDistrict: {}, byEthnicity: { Malay:0, Chinese:0, Indian:0, Others:0 },
      byIncome: { B40:0, M40:0, T20:0, "Not stated":0 },
      byGender: { Male:0, Female:0 },
      byUrbanRural: { Urban:0, "Peri-urban":0, Rural:0 },
      byAge: { "10-12":0, "13-16":0, "17":0 },
    },
    // Intersectional outcomes: per scored outcome, concerning + total counts overall and per lens value.
    // Structure: outcomes[englishId] = { meta, overall:{c,n}, byLens:{ gender:{Male:{c,n},...}, ... } }
    outcomes: {},
    // Parent-child disparity: per theme, the concerning-rate for each module
    disparity: {},
  };

  // Initialise outcome accumulators
  const LENS_VALUES = {
    gender: ["Male","Female"],
    ageGroup: ["10-12","13-16","17"],
    income: ["B40","M40","T20"],
    urbanRural: ["Urban","Peri-urban","Rural"],
    disability: ["Disabled","Not disabled"],
    migration: ["Migrant/refugee","Citizen"],
  };
  for (const o of SCORED_OUTCOMES) {
    const byLens = {};
    for (const lk of LENS_KEYS) {
      byLens[lk] = {};
      for (const v of LENS_VALUES[lk]) byLens[lk][v] = { c:0, n:0 };
    }
    result.outcomes[o.id] = {
      meta: { id:o.id, module:o.module, ro:o.ro, domain:o.domain, short:o.short },
      overall: { c:0, n:0 },
      byLens,
    };
  }
  for (const p of PARALLEL_PAIRS) {
    result.disparity[p.theme] = { parent:{c:0,n:0}, child:{c:0,n:0} };
  }

  // Init cross-tab structures
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
  for (const a of ["10-12","13-16","17"]) {
    result.ageByGender[a] = { Male:0, Female:0 };
  }
  for (const i of ["B40","M40","T20"]) {
    result.incomeByAge[i] = { "10-12":0, "13-16":0, "17":0 };
    result.incomeByGender[i] = { Male:0, Female:0 };
  }

  const unmatchedDUN = {};
  let completedWithDunAnswer = 0;

  for (const { language, responses, qMap, questionIds, outcomeIds } of surveyData) {
    for (const r of responses) {
      const isStarted = r.response_status === "partial" || r.response_status === "completed";
      const isCompleted = r.response_status === "completed";
      if (!isStarted) continue;

      result.totalStarted++;
      result.byLanguage[language].started++;

      const dateStr = r.date_created ? r.date_created.split("T")[0] : null;
      if (dateStr) {
        if (!result.byDate[dateStr]) result.byDate[dateStr] = { started:0, completed:0 };
        result.byDate[dateStr].started++;
      }

      if (!isCompleted) continue;
      result.totalCompleted++;
      result.byLanguage[language].completed++;
      if (dateStr) result.byDate[dateStr].completed++;

      // Extract demographics — DUN may be in island OR Seberang Perai question
      const dunText = getAnswerText(r, questionIds.dunIsland, qMap) || getAnswerText(r, questionIds.dunSeberang, qMap);
      if (dunText) completedWithDunAnswer++;
      const dunKey = matchDUN(dunText);
      const district = dunKey ? DUN_DISTRICT[dunKey] : null;
      const urbanRural = dunKey ? DUN_URBAN[dunKey] : null;
      if (dunText && !district) unmatchedDUN[dunText] = (unmatchedDUN[dunText] || 0) + 1;

      const ethText = getAnswerText(r, questionIds.ethnicity, qMap);
      const ethnicity = matchPattern(ethText, ETH_MAP) || "Others";

      const incText = getAnswerText(r, questionIds.income, qMap);
      const income = matchIncome(incText);

      const ageText = getAnswerText(r, questionIds.childAge, qMap);
      const ageGroup = extractAge(ageText);

      const genderText = getAnswerText(r, questionIds.childGender, qMap);
      const gender = matchPattern(genderText, GENDER_MAP);

      const maritalText = getAnswerText(r, questionIds.marital, qMap);
      const isSingleParent = maritalText && /single.?parent|one.?parent|single|divorced|widowed|ibu tunggal|bapa tunggal|bercerai|balu|janda|单亲|离婚|丧偶|தனி|விவாகரத்து|விதவை/i.test(maritalText);

      const isDisabled = hasDisability(r, questionIds.disability, qMap);
      const isRefugee = ethText && /refugee|undocumented|pelarian|难民|அகதி/i.test(ethText);

      // Count
      if (district) {
        result.crossTab[district][ethnicity]++;
        if (income) result.incomeByDistrict[district][income]++;
        if (ageGroup) result.ageByDistrict[district][ageGroup]++;
        if (gender) result.genderByDistrict[district][gender]++;
      } else {
        result.noDistrict++;
      }

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
      if (isDisabled) result.vulnerableGroups["Children with disability"]++;
      if (isSingleParent) result.vulnerableGroups["Single-parent households"]++;
      if (isRefugee) result.vulnerableGroups["Refugees / undocumented"]++;

      // CRG sign-up: contact details left on the Child Reference Group question.
      // Privacy: we only record presence/absence of contact text, never the text itself.
      // The field may be multi-textbox (email + WhatsApp), so check for any non-empty text.
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
      if (crgSignup) {
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

      // ── Intersectional outcome tabulation ──
      // Lens values for this respondent
      const lensVals = {
        gender,
        ageGroup,
        income,
        urbanRural,
        disability: isDisabled ? "Disabled" : "Not disabled",
        migration: isRefugee ? "Migrant/refugee" : "Citizen",
      };
      for (const o of SCORED_OUTCOMES) {
        const qid = outcomeIds?.[o.id];
        if (!qid) continue;
        const ans = getAnswerText(r, qid, qMap);
        if (ans == null || ans === "") continue; // unanswered - not in denominator
        const isConcerning = o.concerning(ans);
        const acc = result.outcomes[o.id];
        acc.overall.n++;
        if (isConcerning) acc.overall.c++;
        for (const lk of LENS_KEYS) {
          const v = lensVals[lk];
          if (v && acc.byLens[lk][v]) {
            acc.byLens[lk][v].n++;
            if (isConcerning) acc.byLens[lk][v].c++;
          }
        }
      }

      // Parent-child disparity (same concerning tests, by module side)
      for (const p of PARALLEL_PAIRS) {
        const side = (function(){
          // Determine which side this response can answer: try parent id then child id
          const parentQ = outcomeIds?.[p.parent], childQ = outcomeIds?.[p.child];
          return { parentQ, childQ };
        })();
        // Parent side
        if (side.parentQ) {
          const a = getAnswerText(r, side.parentQ, qMap);
          if (a != null && a !== "") {
            const def = SCORED_OUTCOMES.find(o => o.id === p.parent);
            const test = def ? def.concerning : null;
            if (test) { result.disparity[p.theme].parent.n++; if (test(a)) result.disparity[p.theme].parent.c++; }
          }
        }
        // Child side
        if (side.childQ) {
          const a = getAnswerText(r, side.childQ, qMap);
          if (a != null && a !== "") {
            const def = SCORED_OUTCOMES.find(o => o.id === p.child);
            const test = def ? def.concerning : null;
            if (test) { result.disparity[p.theme].child.n++; if (test(a)) result.disparity[p.theme].child.c++; }
          }
        }
      }

      // Daily breakdowns
      if (dateStr) {
        if (district) {
          if (!result.byDateByDistrict[dateStr]) result.byDateByDistrict[dateStr] = {};
          result.byDateByDistrict[dateStr][district] = (result.byDateByDistrict[dateStr][district] || 0) + 1;
        }
        if (ethnicity) {
          if (!result.byDateByEthnicity[dateStr]) result.byDateByEthnicity[dateStr] = {};
          result.byDateByEthnicity[dateStr][ethnicity] = (result.byDateByEthnicity[dateStr][ethnicity] || 0) + 1;
        }
        if (income) {
          if (!result.byDateByIncome[dateStr]) result.byDateByIncome[dateStr] = {};
          result.byDateByIncome[dateStr][income] = (result.byDateByIncome[dateStr][income] || 0) + 1;
        }
        if (ageGroup) {
          if (!result.byDateByAge[dateStr]) result.byDateByAge[dateStr] = {};
          result.byDateByAge[dateStr][ageGroup] = (result.byDateByAge[dateStr][ageGroup] || 0) + 1;
        }
        if (gender) {
          if (!result.byDateByGender[dateStr]) result.byDateByGender[dateStr] = {};
          result.byDateByGender[dateStr][gender] = (result.byDateByGender[dateStr][gender] || 0) + 1;
        }
        if (urbanRural) {
          if (!result.byDateByUrbanRural[dateStr]) result.byDateByUrbanRural[dateStr] = {};
          result.byDateByUrbanRural[dateStr][urbanRural] = (result.byDateByUrbanRural[dateStr][urbanRural] || 0) + 1;
        }
      }
    }
  }

  // Data quality note
  const dunCoverage = result.totalCompleted > 0 ? Math.round(completedWithDunAnswer / result.totalCompleted * 100) : 0;
  console.log(`DUN coverage: ${completedWithDunAnswer}/${result.totalCompleted} completed responses have district (${dunCoverage}%)`);
  if (Object.keys(unmatchedDUN).length > 0) {
    console.log("Unmatched DUN values:", JSON.stringify(unmatchedDUN));
  }

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
    console.log(`Fetching ${lang} survey (${id})...`);
    const details = await fetchSurveyDetails(id);
    const qMap = buildChoiceMap(details);
    const questionIds = identifyQuestions(qMap);

    // Collect DUN dropdown choices for cross-survey spelling check
    dunChoicesByLang[lang] = {
      island: Object.values(qMap[questionIds.dunIsland]?.choices || {}),
      seberang: Object.values(qMap[questionIds.dunSeberang]?.choices || {}),
    };

    const responses = await fetchAllResponses(id);
    for (const r of responses) {
      const st = r.response_status || "unknown";
      statusCounts[st] = (statusCounts[st] || 0) + 1;
    }
    console.log(`  ${responses.length} responses, ${Object.keys(qMap).length} questions mapped`);
    console.log(`  Identified: islandDUN=${questionIds.dunIsland||"NO"} seberangDUN=${questionIds.dunSeberang||"NO"} eth=${questionIds.ethnicity||"NO"} inc=${questionIds.income||"NO"} age=${questionIds.childAge||"NO"} gen=${questionIds.childGender||questionIds.parentGender||"NO"} dis=${questionIds.disability.length} crg=${questionIds.crg||"NO"}`);
    surveyData.push({ language: lang, responses, qMap, questionIds });
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


  const totalRaw = surveyData.reduce((s, d) => s + d.responses.length, 0);
  console.log(`Total raw responses: ${totalRaw}`);
  console.log(`Response status breakdown:`, JSON.stringify(statusCounts));

  // ── DUN spelling check across all 4 surveys ──
  console.log("\n=== DUN SPELLING CHECK ===");
  for (const part of ["island", "seberang"]) {
    const base = (dunChoicesByLang.English?.[part] || []).map(s => s.toUpperCase().trim());
    console.log(`\n${part.toUpperCase()} - English baseline (${base.length}): ${base.join(" | ")}`);
    for (const lang of ["Malay", "Mandarin", "Tamil"]) {
      const other = (dunChoicesByLang[lang]?.[part] || []).map(s => s.toUpperCase().trim());
      const onlyBase = base.filter(x => !other.includes(x));
      const onlyOther = other.filter(x => !base.includes(x));
      if (!onlyBase.length && !onlyOther.length) {
        console.log(`  ${lang}: identical ✓`);
      } else {
        console.log(`  ${lang}: DIFFERS`);
        if (onlyOther.length) console.log(`    Only in ${lang}: ${onlyOther.join(", ")}`);
        if (onlyBase.length) console.log(`    Missing from ${lang}: ${onlyBase.join(", ")}`);
      }
    }
  }
  console.log("=== END DUN CHECK ===\n");

  // ── DROP-OFF ANALYSIS ──
  // Build a question-order + heading map from the English survey (structure is shared)
  console.log("=== DROP-OFF ANALYSIS ===");
  const engSurvey = surveyData.find(s => s.language === "English");
  if (engSurvey) {
    // Build ordered list of question IDs with short headings, per survey
    for (const { language, responses, qMap } of surveyData) {
      // Order questions by their appearance in qMap (insertion order = survey order)
      const orderedQ = Object.keys(qMap);
      const qPosition = {};
      orderedQ.forEach((qId, i) => { qPosition[qId] = i; });

      // For each partial response, find the furthest-position question answered
      const dropAtHeading = {};
      let partialCount = 0;
      for (const r of responses) {
        if (r.response_status !== "partial") continue;
        partialCount++;
        let maxPos = -1, lastQId = null;
        for (const page of (r.pages || [])) {
          for (const q of (page.questions || [])) {
            const pos = qPosition[q.id];
            if (pos !== undefined && pos > maxPos && (q.answers || []).length > 0) {
              maxPos = pos; lastQId = q.id;
            }
          }
        }
        if (lastQId) {
          const heading = (qMap[lastQId]?.heading || "(unknown)").replace(/<[^>]+>/g, "").slice(0, 50);
          const key = `pos${String(maxPos).padStart(3,"0")}: ${heading}`;
          dropAtHeading[key] = (dropAtHeading[key] || 0) + 1;
        }
      }

      if (partialCount > 0) {
        console.log(`\n${language} - ${partialCount} partial responses, top drop-off points:`);
        const sorted = Object.entries(dropAtHeading).sort((a,b) => b[1]-a[1]).slice(0, 8);
        for (const [key, count] of sorted) {
          const pct = Math.round(count / partialCount * 100);
          console.log(`  ${count} (${pct}%) last answered → ${key}`);
        }
      }
    }
  }
  console.log("=== END DROP-OFF ===\n");

  // Classify in Node.js - no AI dependency
  console.log("Classifying responses...");
  const classified = classifyAllResponses(surveyData);
  classified.updatedAt = new Date().toISOString();

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
