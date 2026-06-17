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

const Q1 = {
  district:  { "Timur Laut":510, "Barat Daya":485, "SP Utara":485, "SP Tengah":510, "SP Selatan":510 },
  ethnicity: { Malay:710, Chinese:710, Indian:655, Others:425 },
  income:    { B40:770, M40:625, T20:340 },
  age:       { "10-12":625, "13-16":625, "17-18":480 },
  gender:    { Male:1250, Female:1250 },
  urbanRural:{ Urban:570, "Peri-urban":340, Rural:230 },
};

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
  age: { "10-12":["Year 4-6 class teacher reminder"], "13-16":["PRIORITY — Form 1-3 class teacher reminder"], "17-18":["Form 4-5 school counsellor outreach"] },
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
    duns: ["Seberang Jaya","Permatang Pasir","Penanti","Berapit","Machang Bubok","Padang Lalang","Perai","Bukit Tengah","Bukit Tambun"],
    urban: ["Seberang Jaya","Perai"],
    periurban: ["Permatang Pasir","Berapit","Padang Lalang","Bukit Tengah","Bukit Tambun"],
    rural: ["Penanti","Machang Bubok"],
  },
  "SP Selatan": {
    duns: ["Jawi","Sungai Bakap","Sungai Acheh"],
    periurban: ["Jawi","Sungai Bakap","Sungai Acheh"],
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

function matchDUN(text) {
  if (!text) return null;
  let lower = text.toLowerCase().trim();
  // Normalise common spelling variants
  lower = lower
    .replace(/\blancang\b/g, "lanchang")
    .replace(/\bglugor\b/g, "gelugor")
    .replace(/\bbubuk\b/g, "bubok")
    .replace(/\btelok\b/g, "teluk")
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
  const m = text.match(/\b(1[0-8]|[0-9])\b/);
  if (!m) return null;
  const age = parseInt(m[1]);
  if (age >= 10 && age <= 12) return "10-12";
  if (age >= 13 && age <= 16) return "13-16";
  if (age >= 17 && age <= 18) return "17-18";
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
    status: null, disability: [],
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
async function smGet(path) {
  const res = await fetch(`${SM_BASE}${path}`, {
    headers: { Authorization: `Bearer ${SM_TOKEN}`, "Content-Type": "application/json" },
  });
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
  for (const page of (details.pages || [])) {
    for (const q of (page.questions || [])) {
      const entry = { heading: q.headings?.[0]?.heading || "", choices: {}, rows: {} };
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
  };

  // Init cross-tab structures
  for (const d of ["Timur Laut","Barat Daya","SP Utara","SP Tengah","SP Selatan"]) {
    result.crossTab[d] = { Malay:0, Chinese:0, Indian:0, Others:0 };
    result.incomeByDistrict[d] = { B40:0, M40:0, T20:0 };
    result.ageByDistrict[d] = { "10-12":0, "13-16":0, "17-18":0 };
    result.genderByDistrict[d] = { Male:0, Female:0 };
  }
  for (const e of ["Malay","Chinese","Indian","Others"]) {
    result.ethnicityByGender[e] = { Male:0, Female:0 };
    result.ethnicityByIncome[e] = { B40:0, M40:0, T20:0 };
    result.ethnicityByAge[e] = { "10-12":0, "13-16":0, "17-18":0 };
  }
  for (const a of ["10-12","13-16","17-18"]) {
    result.ageByGender[a] = { Male:0, Female:0 };
  }
  for (const i of ["B40","M40","T20"]) {
    result.incomeByAge[i] = { "10-12":0, "13-16":0, "17-18":0 };
    result.incomeByGender[i] = { Male:0, Female:0 };
  }

  const unmatchedDUN = {};
  let completedWithDunAnswer = 0;

  for (const { language, responses, qMap, questionIds } of surveyData) {
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
  body += `  Children with disability: ${vg["Children with disability"]||0} (target: 50)\n`;
  body += `  Single-parent households: ${vg["Single-parent households"]||0} (target: 150)\n`;
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
    console.log(`  Identified: islandDUN=${questionIds.dunIsland||"NO"} seberangDUN=${questionIds.dunSeberang||"NO"} eth=${questionIds.ethnicity||"NO"} inc=${questionIds.income||"NO"} age=${questionIds.childAge||"NO"} gen=${questionIds.childGender||questionIds.parentGender||"NO"} dis=${questionIds.disability.length}`);
    surveyData.push({ language: lang, responses, qMap, questionIds });
  }

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

  // Classify in Node.js - no AI dependency
  console.log("Classifying responses...");
  const classified = classifyAllResponses(surveyData);
  classified.updatedAt = new Date().toISOString();

  console.log(`Classified: ${classified.totalStarted} started, ${classified.totalCompleted} completed`);
  console.log(`Districts:`, JSON.stringify(Object.fromEntries(Object.entries(classified.crossTab).map(([d,v])=>[d,Object.values(v).reduce((a,b)=>a+b,0)]))));
  console.log(`Ethnicity:`, JSON.stringify(Object.fromEntries(["Malay","Chinese","Indian","Others"].map(e=>[e,Object.values(classified.crossTab).reduce((s,d)=>s+(d[e]||0),0)]))));
  console.log(`noDistrict: ${classified.noDistrict}`);

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
