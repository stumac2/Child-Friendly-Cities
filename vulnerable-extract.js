#!/usr/bin/env node
/**
 * CFP Vulnerable Groups Extract - Disability & Migration Status
 * ------------------------------------------------------------
 * Standalone, run on demand (not part of the daily pipeline).
 *
 * DISABILITY: reads the Washington Group question(s) by matrix STRUCTURE (row/column
 * content), not by heading - because heading-based detection in the main pipeline
 * finds nothing. Counts children at two thresholds:
 *   - Standard WG cut-off:  "a lot of difficulty" OR "cannot do at all" (>=1 function)
 *   - Broader:              "some difficulty" or worse (>=1 function)
 *
 * MIGRATION STATUS: reads Q8 "How would you describe your status in Malaysia" directly,
 * shows the full answer distribution, and counts the merged
 * Refugee + Stateless + Undocumented group.
 *
 * Both broken down by district, gender, age, income, urban/rural.
 *
 * Run:  node vulnerable-extract.js
 * Output: docs/vulnerable-groups.xlsx
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

// English anchor question IDs
const STATUS_Q_ENG = "289909841";   // Q8 status in Malaysia
const DUN_ISLAND_ENG = "289909870";
const DUN_SEBERANG_ENG = "289909884";
const CHILD_GENDER_ENG = "289909839";
const CHILD_AGE_ENG = "289909924";
const ETHNICITY_ENG = "289909807";
const INCOME_ENG = "289909904";

// ─── API helpers with rate-limit backoff ────────────────────────────────────────
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
    console.log(`  Rate limited (attempt ${attempt}) - waiting ${Math.round(wait/1000)}s`);
    await sleep(wait); return smGet(path, attempt + 1);
  }
  if (res.status >= 500 && attempt < MAX) { await sleep(2000 * 2 ** (attempt - 1)); return smGet(path, attempt + 1); }
  if (!res.ok) throw new Error(`SM API error ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}
async function fetchDetails(id) { return smGet(`/surveys/${id}/details`); }
async function fetchAllResponses(id) {
  const out = []; let page = 1, more = true;
  while (more) {
    const d = await smGet(`/surveys/${id}/responses/bulk?per_page=100&page=${page}`);
    out.push(...(d.data || []));
    more = d.links?.next != null; page++;
  }
  return out;
}

// ─── Question map with positions, rows, and choices ─────────────────────────────
function buildQMap(details) {
  const qMap = {}; let pos = 0;
  for (const page of (details.pages || [])) {
    for (const q of (page.questions || [])) {
      const entry = { heading:q.headings?.[0]?.heading || "", family:q.family||"", subtype:q.subtype||"",
                      position:pos, choices:{}, rows:{} };
      pos++;
      const ans = q.answers || {};
      if (Array.isArray(ans.choices)) for (const c of ans.choices) entry.choices[c.id] = c.text;
      if (Array.isArray(ans.rows)) for (const r of ans.rows) entry.rows[r.id] = r.text;
      qMap[q.id] = entry;
    }
  }
  return qMap;
}
function idAtPos(qMap, pos) {
  for (const [qId, q] of Object.entries(qMap)) if (q.position === pos) return qId;
  return null;
}

// Single-answer text (choice/other/text)
function getText(response, qid, qMap) {
  if (!qid) return null;
  const qInfo = qMap[qid] || {};
  for (const page of (response.pages || [])) {
    for (const q of (page.questions || [])) {
      if (q.id === qid) {
        const parts = (q.answers || []).map(a => {
          if (a.choice_id && qInfo.choices?.[a.choice_id]) return qInfo.choices[a.choice_id];
          if (a.text) return a.text;
          return null;
        }).filter(Boolean);
        return parts.length ? parts.join(", ") : null;
      }
    }
  }
  return null;
}

// Matrix answers: return array of {row, col} text pairs
function getMatrixAnswers(response, qid, qMap) {
  if (!qid) return [];
  const qInfo = qMap[qid] || {};
  const out = [];
  for (const page of (response.pages || [])) {
    for (const q of (page.questions || [])) {
      if (q.id === qid) {
        for (const a of (q.answers || [])) {
          const rowText = a.row_id && qInfo.rows?.[a.row_id] ? qInfo.rows[a.row_id] : null;
          const colText = a.choice_id && qInfo.choices?.[a.choice_id] ? qInfo.choices[a.choice_id] : null;
          if (rowText || colText) out.push({ row: rowText, col: colText });
        }
      }
    }
  }
  return out;
}

// ─── District from DUN ──────────────────────────────────────────────────────────
const DUN_DISTRICT = {};
const DISTRICT_DUNS = {
  "Timur Laut": ["air itam","air putih","batu lanchang","kebun bunga","komtar","padang kota","pengkalan kota","pulau tikus","seri delima","sungai pinang","tanjong bunga","batu uban","datok keramat","paya terubong","bukit gelugor"],
  "Barat Daya": ["batu maung","bayan lepas","pantai jerejak","pulau betong","teluk bahang","balik pulau"],
  "SP Utara":   ["penaga","bertam","pinang tunggal","permatang berangan","sungai dua","teluk air tawar","sungai puyu","bagan jermal","bagan dalam"],
  "SP Tengah":  ["seberang jaya","permatang pasir","penanti","berapit","machang bubok","padang lalang","perai","bukit tengah"],
  "SP Selatan": ["bukit tambun","jawi","sungai bakap","sungai acheh"],
};
for (const [d, duns] of Object.entries(DISTRICT_DUNS)) for (const x of duns) DUN_DISTRICT[x] = d;
function dunToDistrict(text) {
  if (!text) return "Unknown";
  let s = text.toLowerCase().trim()
    .replace(/\blancang\b/g,"lanchang").replace(/\bglugor\b/g,"gelugor").replace(/\bbubuk\b/g,"bubok")
    .replace(/\btelok\b/g,"teluk").replace(/\bayer\b/g,"air").replace(/\btanjung\b/g,"tanjong").replace(/\s+/g," ");
  for (const dun of Object.keys(DUN_DISTRICT)) if (s.includes(dun)) return DUN_DISTRICT[dun];
  return "Unknown";
}

// ─── Lens classifiers ───────────────────────────────────────────────────────────
function classGender(t){ if(!t)return null; if(/female|perempuan|女|பெண்/i.test(t))return"Female"; if(/male|lelaki|男|ஆண்/i.test(t))return"Male"; return null; }
function classAge(t){ if(!t)return null; const m=t.match(/\b(1[0-7]|[0-9])\b/); if(!m)return null; const a=+m[1]; if(a>=10&&a<=12)return"10-12"; if(a>=13&&a<=16)return"13-16"; if(a===17)return"17"; return null; }
function classIncome(t){ if(!t)return null; const s=t.toLowerCase();
  if(/prefer not|enggan|不愿|விரும்பவில/i.test(s))return"Not stated";
  const nums=(s.match(/\d[\d,]*/g)||[]).map(n=>+n.replace(/,/g,"")); const max=nums.length?Math.max(...nums):null;
  if(max==null)return null; if(max<=4849)return"B40"; if(max<=10970)return"M40"; return"T20"; }

// Washington Group difficulty levels
const WG_ALOT = /a lot of difficulty|cannot do at all|banyak kesukaran|tidak boleh|langsung tidak|很难|完全不能|மிகவும் சிரமம்|முடியாது/i;
const WG_SOME = /some difficulty|sedikit kesukaran|ada kesukaran|有些困难|一些困难|சற்று சிரமம்|கொஞ்சம் சிரமம்/i;
// Row content that identifies a WG functional domain
const WG_ROW = /seeing|sight|hearing|walking|climbing|remember|concentrat|self.?care|washing|dressing|communicat|understood|melihat|mendengar|berjalan|mengingat|penjagaan diri|berkomunikasi|看|听|行走|记忆|自理|沟通|பார்|கேட்|நடக்க|நினைவு|தொடர்பு/i;

// Is a question the WG disability matrix? (rows look like functional domains, cols like difficulty)
function isDisabilityMatrix(q) {
  const rowVals = Object.values(q.rows || {});
  const colVals = Object.values(q.choices || {});
  if (rowVals.length < 2 || colVals.length < 2) return false;
  const rowsLookWG = rowVals.filter(r => WG_ROW.test(r)).length >= 1;
  const colsLookDifficulty = colVals.some(c => WG_ALOT.test(c) || WG_SOME.test(c) || /no difficulty|tiada kesukaran|没有困难|சிரமம் இல்லை/i.test(c));
  return rowsLookWG && colsLookDifficulty;
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log("CFP Vulnerable Groups Extract (Disability + Migration status)");

  const engDetails = await fetchDetails(SURVEY_IDS.English);
  const engQMap = buildQMap(engDetails);
  const pos = {
    status: engQMap[STATUS_Q_ENG]?.position,
    island: engQMap[DUN_ISLAND_ENG]?.position,
    seberang: engQMap[DUN_SEBERANG_ENG]?.position,
    gender: engQMap[CHILD_GENDER_ENG]?.position,
    age: engQMap[CHILD_AGE_ENG]?.position,
    eth: engQMap[ETHNICITY_ENG]?.position,
    income: engQMap[INCOME_ENG]?.position,
  };

  // Find disability matrix positions in English (may be more than one question)
  const engDisabilityIds = Object.entries(engQMap).filter(([,q]) => isDisabilityMatrix(q)).map(([id])=>id);
  const engDisabilityPositions = engDisabilityIds.map(id => engQMap[id].position);
  console.log(`Disability matrix questions found in English: ${engDisabilityIds.length ? engDisabilityIds.join(", ") : "NONE"}`);
  if (engDisabilityIds.length) {
    for (const id of engDisabilityIds) {
      console.log(`  [${id}] rows: ${Object.values(engQMap[id].rows).slice(0,8).join(" | ").slice(0,140)}`);
      console.log(`        cols: ${Object.values(engQMap[id].choices).slice(0,6).join(" | ").slice(0,120)}`);
    }
  }

  // Accumulators
  const blankLens = () => ({ byDistrict:{}, byGender:{}, byAge:{}, byIncome:{}, byUrban:{} });
  const disStd = { total:0, ...blankLens() };   // standard WG cut-off
  const disBroad = { total:0, ...blankLens() }; // some difficulty or worse
  const statusDist = {};                        // raw Q8 answer -> count
  const migMerged = { total:0, ...blankLens() };// refugee+stateless+undocumented

  const addLens = (acc, district, gender, age, income) => {
    acc.total++;
    acc.byDistrict[district]=(acc.byDistrict[district]||0)+1;
    if(gender)acc.byGender[gender]=(acc.byGender[gender]||0)+1;
    if(age)acc.byAge[age]=(acc.byAge[age]||0)+1;
    if(income)acc.byIncome[income]=(acc.byIncome[income]||0)+1;
  };

  const MIGRANT = /refugee|stateless|undocumented|non.?citizen|pelarian|tanpa negara|tanpa kewarganegaraan|tidak berdokumen|难民|无国籍|无证|அகதி|நாடற்ற|ஆவணமற்ற/i;

  for (const [lang, id] of Object.entries(SURVEY_IDS)) {
    console.log(`  ${lang}...`);
    const details = (lang==="English") ? engDetails : await fetchDetails(id);
    const qMap = (lang==="English") ? engQMap : buildQMap(details);
    const q = {
      status: lang==="English"?STATUS_Q_ENG:idAtPos(qMap,pos.status),
      island: lang==="English"?DUN_ISLAND_ENG:idAtPos(qMap,pos.island),
      seberang: lang==="English"?DUN_SEBERANG_ENG:idAtPos(qMap,pos.seberang),
      gender: lang==="English"?CHILD_GENDER_ENG:idAtPos(qMap,pos.gender),
      age: lang==="English"?CHILD_AGE_ENG:idAtPos(qMap,pos.age),
      income: lang==="English"?INCOME_ENG:idAtPos(qMap,pos.income),
    };
    // Disability questions in this survey: same positions as English matrix questions
    const disIds = (lang==="English") ? engDisabilityIds
      : engDisabilityPositions.map(p => idAtPos(qMap,p)).filter(Boolean);

    const responses = await fetchAllResponses(id);
    for (const r of responses) {
      const district = dunToDistrict(getText(r,q.island,qMap) || getText(r,q.seberang,qMap));
      const gender = classGender(getText(r,q.gender,qMap));
      const age = classAge(getText(r,q.age,qMap));
      const income = classIncome(getText(r,q.income,qMap));

      // Disability: examine all WG matrix answers
      let anyAlot=false, anySome=false;
      for (const did of disIds) {
        for (const {col} of getMatrixAnswers(r,did,qMap)) {
          if (!col) continue;
          if (WG_ALOT.test(col)) anyAlot=true;
          else if (WG_SOME.test(col)) anySome=true;
        }
      }
      if (anyAlot) addLens(disStd, district, gender, age, income);
      if (anyAlot || anySome) addLens(disBroad, district, gender, age, income);

      // Migration status (Q8)
      const statusText = getText(r,q.status,qMap);
      if (statusText) {
        statusDist[statusText] = (statusDist[statusText]||0)+1;
        if (MIGRANT.test(statusText)) addLens(migMerged, district, gender, age, income);
      }
    }
  }

  console.log(`Disability (standard WG cut-off): ${disStd.total}`);
  console.log(`Disability (some difficulty or worse): ${disBroad.total}`);
  console.log(`Migration merged (refugee/stateless/undocumented): ${migMerged.total}`);

  // ── Build workbook ──
  const wb = XLSX.utils.book_new();
  const lensToRows = (acc, groupLabel) => {
    const rows = [];
    rows.push({ Group:groupLabel, Breakdown:"TOTAL", Category:"", Count:acc.total });
    const dump = (obj, bd) => Object.entries(obj).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>rows.push({ Group:"", Breakdown:bd, Category:k, Count:v }));
    dump(acc.byDistrict,"District"); dump(acc.byGender,"Gender"); dump(acc.byAge,"Age"); dump(acc.byIncome,"Income");
    return rows;
  };

  const overview = [
    ["CFP Vulnerable Groups Extract - Disability & Migration Status"],
    [`Generated: ${new Date().toISOString().slice(0,19).replace("T"," ")} UTC`],
    [],
    ["DISABILITY - Washington Group questions, two thresholds:"],
    ["  Standard WG cut-off = 'a lot of difficulty' OR 'cannot do at all' on >=1 function"],
    ["    (the internationally comparable disability definition)"],
    ["  Broader = 'some difficulty' or worse on >=1 function (captures more, less comparable)"],
    [],
    ["MIGRATION STATUS - from Q8 'How would you describe your status in Malaysia'."],
    ["  Merged group = Refugee + Stateless + Undocumented/Non-citizen."],
    ["  See 'Status distribution' sheet for the full raw answer breakdown."],
    [],
    [`Disability (standard WG): ${disStd.total}`],
    [`Disability (broader): ${disBroad.total}`],
    [`Migration merged: ${migMerged.total}`],
    [],
    ["Disability matrix questions detected (English):"],
    ...(engDisabilityIds.length ? engDisabilityIds.map(id=>["  "+id+": "+Object.values(engQMap[id].rows).slice(0,6).join(", ").slice(0,90)]) : [["  NONE - detection failed, check survey structure"]]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overview), "Overview");

  const disSheet = [...lensToRows(disStd,"Disability - standard WG cut-off"), {Group:"",Breakdown:"",Category:"",Count:""}, ...lensToRows(disBroad,"Disability - broader (some difficulty+)")];
  const wsDis = XLSX.utils.json_to_sheet(disSheet);
  wsDis["!cols"]=[{wch:38},{wch:14},{wch:16},{wch:8}];
  XLSX.utils.book_append_sheet(wb, wsDis, "Disability");

  const statusRows = Object.entries(statusDist).sort((a,b)=>b[1]-a[1]).map(([Status,Count])=>({ Status, Count, "In merged group": MIGRANT.test(Status)?"YES":"" }));
  const wsStatus = XLSX.utils.json_to_sheet(statusRows.length?statusRows:[{Status:"(none)",Count:0,"In merged group":""}]);
  wsStatus["!cols"]=[{wch:45},{wch:8},{wch:16}];
  XLSX.utils.book_append_sheet(wb, wsStatus, "Status distribution");

  const wsMig = XLSX.utils.json_to_sheet(lensToRows(migMerged,"Refugee/Stateless/Undocumented"));
  wsMig["!cols"]=[{wch:38},{wch:14},{wch:16},{wch:8}];
  XLSX.utils.book_append_sheet(wb, wsMig, "Migration merged");

  if (!fs.existsSync("docs")) fs.mkdirSync("docs");
  const outPath = "docs/vulnerable-groups.xlsx";
  XLSX.writeFile(wb, outPath);
  console.log(`Wrote ${outPath}`);
}

main().catch(e => { console.error("Extract failed:", e.message); process.exit(1); });
