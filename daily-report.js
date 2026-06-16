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
    duns: ["Tanjong Bunga","Air Putih","Kebun Bunga","Pulau Tikus","Padang Kota","Pengkalan Kota","Komtar","Datok Keramat","Sungai Pinang","Batu Lanchang","Seri Delima","Bukit Glugor","Paya Terubong","Batu Uban"],
    urban: ["Tanjong Bunga","Air Putih","Kebun Bunga","Pulau Tikus","Padang Kota","Pengkalan Kota","Komtar","Datok Keramat","Sungai Pinang","Batu Lanchang","Seri Delima","Bukit Glugor","Batu Uban"],
    periurban: ["Paya Terubong"],
  },
  "Barat Daya": {
    duns: ["Pantai Jerejak","Batu Maung","Bayan Lepas","Pulau Betong","Telok Bahang"],
    urban: ["Pantai Jerejak","Batu Maung","Bayan Lepas"],
    rural: ["Pulau Betong","Telok Bahang"],
  },
  "SP Utara": {
    duns: ["Penaga","Bertam","Pinang Tunggal","Permatang Berangan","Sungai Dua","Telok Ayer Tawar","Sungai Puyu","Bagan Jermal","Bagan Dalam"],
    urban: ["Sungai Puyu","Bagan Jermal","Bagan Dalam"],
    periurban: ["Bertam","Pinang Tunggal","Permatang Berangan","Sungai Dua"],
    rural: ["Penaga","Telok Ayer Tawar"],
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

const INCOME_MAP = [
  { pattern: /b40|rm\s*4[,.]?849|below|bawah|以下|கீழ்/i, value: "B40" },
  { pattern: /t20|rm\s*10[,.]?97[01]|above|atas|以上|மேல்/i, value: "T20" },
  { pattern: /m40|rm\s*4[,.]?850|rm\s*10[,.]?970|middle|sederhana|中等|நடுத்தர/i, value: "M40" },
];

const GENDER_MAP = [
  { pattern: /^male$|^lelaki$|^男$|^ஆண்$/i, value: "Male" },
  { pattern: /^female$|^perempuan$|^女$|^பெண்$/i, value: "Female" },
];

const DISABILITY_PATTERN = /some difficulty|a lot of difficulty|cannot do at all|sukar|kesukaran|困难|难以|சிரமம்/i;

function matchDUN(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  if (DUN_DISTRICT[lower]) return lower;
  // Fuzzy: check if any DUN name is contained in the text
  for (const dun of Object.keys(DUN_DISTRICT)) {
    if (lower.includes(dun) || dun.includes(lower)) return dun;
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
// Scans qMap choices to identify which question ID maps to which field
function identifyQuestions(qMap) {
  const ids = { dun: null, ethnicity: null, income: null, childAge: null, childGender: null, parentGender: null, marital: null, disability: [] };

  for (const [qId, q] of Object.entries(qMap)) {
    const heading = (q.heading || "").toLowerCase();
    const choiceTexts = Object.values(q.choices).map(c => c.toLowerCase());
    const allText = choiceTexts.join(" ");

    // DUN: has DUN names as choices
    if (!ids.dun && choiceTexts.some(c => DUN_DISTRICT[c.trim()])) {
      ids.dun = qId;
      continue;
    }

    // Ethnicity: choices contain Malay/Chinese/Indian or equivalents
    if (!ids.ethnicity && (allText.match(/malay|melayu|华人|马来|சீனர்|cina/i))) {
      ids.ethnicity = qId;
      continue;
    }

    // Income: choices contain B40/M40/T20 or RM amounts
    if (!ids.income && (allText.match(/b40|m40|t20|rm\s*4[,.]?849|rm\s*10[,.]?970/i))) {
      ids.income = qId;
      continue;
    }

    // Child gender: heading contains "child" + "gender" or "anak" + "jantina"
    if (!ids.childGender && heading.match(/child.*(gender|sex)|gender.*child|jantina.*anak|anak.*jantina|孩子.*性别|性别.*孩子|குழந்தை.*பாலினம்/i)) {
      ids.childGender = qId;
      continue;
    }

    // Parent gender (fallback): heading has gender but not child
    if (!ids.parentGender && heading.match(/gender|jantina|性别|பாலினம்/i) && !heading.match(/child|anak|孩子|குழந்தை/i)) {
      ids.parentGender = qId;
      continue;
    }

    // Child age: heading mentions child + age, or choices have numbers 10-18
    if (!ids.childAge && heading.match(/child.*(age|old)|age.*child|umur.*anak|anak.*umur|孩子.*年龄|年龄.*孩子|குழந்தை.*வயது/i)) {
      ids.childAge = qId;
      continue;
    }
    if (!ids.childAge && choiceTexts.some(c => /^1[0-8]$/.test(c.trim()))) {
      ids.childAge = qId;
      continue;
    }

    // Marital: heading mentions marital/marriage/perkahwinan
    if (!ids.marital && heading.match(/marital|marriage|status.*perkahwinan|perkahwinan|婚姻|திருமண/i)) {
      ids.marital = qId;
      continue;
    }

    // Disability: Washington Group questions - heading mentions difficulty + activity
    if (heading.match(/difficulty|kesukaran|困难|சிரமம்/i) && heading.match(/seeing|hearing|walking|remembering|self.?care|communicat/i)) {
      ids.disability.push(qId);
      continue;
    }
  }

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
          if (a.text) return a.text;
          return null;
        }).filter(Boolean);
        return texts.join(", ");
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

      // Extract demographics
      const dunText = getAnswerText(r, questionIds.dun, qMap);
      const dunKey = matchDUN(dunText);
      const district = dunKey ? DUN_DISTRICT[dunKey] : null;
      const urbanRural = dunKey ? DUN_URBAN[dunKey] : null;

      const ethText = getAnswerText(r, questionIds.ethnicity, qMap);
      const ethnicity = matchPattern(ethText, ETH_MAP) || "Others";

      const incText = getAnswerText(r, questionIds.income, qMap);
      const income = matchPattern(incText, INCOME_MAP);

      const ageText = getAnswerText(r, questionIds.childAge, qMap);
      const ageGroup = extractAge(ageText);

      const genderText = getAnswerText(r, questionIds.childGender, qMap) || getAnswerText(r, questionIds.parentGender, qMap);
      const gender = matchPattern(genderText, GENDER_MAP);

      const maritalText = getAnswerText(r, questionIds.marital, qMap);
      const isSingleParent = maritalText && /single|divorced|widowed|bercerai|balu|janda|离婚|丧偶|விவாகரத்து|விதவை/i.test(maritalText);

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
  for (const [lang, id] of Object.entries(SURVEY_IDS)) {
    console.log(`Fetching ${lang} survey (${id})...`);
    const details = await fetchSurveyDetails(id);
    const qMap = buildChoiceMap(details);
    const questionIds = identifyQuestions(qMap);
    const responses = await fetchAllResponses(id);
    console.log(`  ${responses.length} responses, ${Object.keys(qMap).length} questions mapped`);
    console.log(`  Identified: DUN=${questionIds.dun?"yes":"NO"} eth=${questionIds.ethnicity?"yes":"NO"} inc=${questionIds.income?"yes":"NO"} age=${questionIds.childAge?"yes":"NO"} gen=${questionIds.childGender||questionIds.parentGender?"yes":"NO"} dis=${questionIds.disability.length}`);
    surveyData.push({ language: lang, responses, qMap, questionIds });
  }

  const totalRaw = surveyData.reduce((s, d) => s + d.responses.length, 0);
  console.log(`Total raw responses: ${totalRaw}`);

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
