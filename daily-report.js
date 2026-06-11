// CFP Survey – Daily Report Scheduler
// Runs via GitHub Actions at 9am MYT (01:00 UTC)
// Requires env vars: ANTHROPIC_API_KEY, SM_ACCESS_TOKEN, SMTP_USER, SMTP_PASS

const nodemailer = require("nodemailer");

// ── Config ────────────────────────────────────────────────────────────────────
const START_DATE   = new Date("2026-06-15");
const END_DATE     = new Date("2026-07-20");
const TOTAL_TARGET = 2200;
const EMAIL_TO     = ["yancheng.tan@thinkcity.com.my", "hana.zulkifli@thinkcity.com.my"];
const SM_API       = "https://api.surveymonkey.com/v3";
const SURVEY_TITLES = [
  "Child Friendly Penang v3 (English)",
  "Child Friendly Penang v3 (Malay)",
  "Child Friendly Penang v3 (Mandarin)",
  "Child Friendly Penang v3 (Tamil)",
];

// ── Quota tables ──────────────────────────────────────────────────────────────
const Q1 = {
  district:  { "Timur Laut":450, "Barat Daya":425, "SP Utara":425, "SP Tengah":450, "SP Selatan":450 },
  ethnicity: { Malay:625, Chinese:625, Indian:575, Others:375 },
  income:    { B40:675, M40:550, T20:300 },
  age:       { "10-12":550, "13-16":550, "17-18":425 },
  gender:    { Male:1100, Female:1100 },
};
const EQ = {
  "Timur Laut":{ Malay:125, Chinese:125, Indian:125, Others:75 },
  "Barat Daya":{ Malay:125, Chinese:125, Indian:100, Others:75 },
  "SP Utara":  { Malay:125, Chinese:125, Indian:100, Others:75 },
  "SP Tengah": { Malay:125, Chinese:125, Indian:125, Others:75 },
  "SP Selatan":{ Malay:125, Chinese:125, Indian:125, Others:75 },
};

const DISTRICTS   = ["Timur Laut","Barat Daya","SP Utara","SP Tengah","SP Selatan"];
const ETHNICITIES = ["Malay","Chinese","Indian","Others"];
const INCOME_GRP  = ["B40","M40","T20"];
const AGE_GRP     = ["10-12","13-16","17-18"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function daysDiff(a, b) { return Math.floor((b - a) / 86400000); }
function pct(actual, target) { return target > 0 ? Math.round(actual / target * 100) : 0; }
function flag(p) { return p >= 100 ? "✓" : p >= 75 ? "~" : "⚠"; }

// ── SurveyMonkey REST API helpers ─────────────────────────────────────────────
async function smGet(path) {
  const res = await fetch(`${SM_API}${path}`, {
    headers: { "Authorization": `Bearer ${process.env.SM_ACCESS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`SM API error ${res.status} on ${path}`);
  return res.json();
}

async function getSurveyIds() {
  const data = await smGet("/surveys?per_page=50");
  const ids = {};
  for (const s of data.data || []) {
    const lang = SURVEY_TITLES.find(t => s.title === t);
    if (lang) ids[lang] = s.id;
  }
  return ids;
}

async function getAllResponses(surveyId) {
  let responses = [], page = 1;
  while (true) {
    const data = await smGet(`/surveys/${surveyId}/responses/bulk?per_page=100&page=${page}&status=completed`);
    responses = responses.concat(data.data || []);
    if (!data.links?.next) break;
    page++;
  }
  return responses;
}

// ── Process responses via Anthropic ──────────────────────────────────────────
async function processResponses(allResponses) {
  // Send a sample + summary to Anthropic for aggregation
  const prompt = `You are a data-processing assistant. Aggregate the following SurveyMonkey response data.

MAPPING RULES:
ETHNICITY: Melayu/Bumiputera|马来人|மலாய் → Malay; Cina|华人|சீனர் → Chinese; India|印度人|இந்தியர் → Indian; Others/Lain-lain/Refugee → Others
DISTRICT: Map DUN name to district (case-insensitive):
  SP Utara: Penaga, Bertam, Pinang Tunggal, Permatang Berangan, Sungai Dua, Telok Ayer Tawar, Sungai Puyu, Bagan Jermal, Bagan Dalam
  SP Tengah: Seberang Jaya, Permatang Pasir, Penanti, Berapit, Machang Bubok, Padang Lalang, Perai, Bukit Tengah, Bukit Tambun
  SP Selatan: Jawi, Sungai Bakap, Sungai Acheh
  Timur Laut: Tanjong Bunga, Air Putih, Kebun Bunga, Pulau Tikus, Padang Kota, Pengkalan Kota, Komtar, Datok Keramat, Sungai Pinang, Batu Lanchang, Seri Delima, Bukit Glugor, Paya Terubong, Batu Uban
  Barat Daya: Pantai Jerejak, Batu Maung, Bayan Lepas, Pulau Betong, Telok Bahang
INCOME: ≤RM4,849 → B40; RM4,850–10,970 → M40; >RM10,970 → T20
AGE: 10/11/12 → 10-12; 13/14/15/16 → 13-16; 17/18 → 17-18

RESPONSE DATA (${allResponses.total} total completed responses across 4 surveys):
${JSON.stringify(allResponses.sample)}

Return ONLY valid JSON:
{"totalStarted":${allResponses.started},"totalCompleted":${allResponses.total},"byLanguage":{"English":{"started":0,"completed":0},"Malay":{"started":0,"completed":0},"Mandarin":{"started":0,"completed":0},"Tamil":{"started":0,"completed":0}},"crossTab":{"Timur Laut":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"Barat Daya":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"SP Utara":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"SP Tengah":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"SP Selatan":{"Malay":0,"Chinese":0,"Indian":0,"Others":0}},"incomeByDistrict":{"Timur Laut":{"B40":0,"M40":0,"T20":0},"Barat Daya":{"B40":0,"M40":0,"T20":0},"SP Utara":{"B40":0,"M40":0,"T20":0},"SP Tengah":{"B40":0,"M40":0,"T20":0},"SP Selatan":{"B40":0,"M40":0,"T20":0}},"ageByDistrict":{"Timur Laut":{"10-12":0,"13-16":0,"17-18":0},"Barat Daya":{"10-12":0,"13-16":0,"17-18":0},"SP Utara":{"10-12":0,"13-16":0,"17-18":0},"SP Tengah":{"10-12":0,"13-16":0,"17-18":0},"SP Selatan":{"10-12":0,"13-16":0,"17-18":0}},"byGender":{"Male":0,"Female":0},"byIncome":{"B40":0,"M40":0,"T20":0},"vulnerableGroups":{"Children with disability":0,"Single-parent households":0},"noDistrict":0}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) { const e = await res.text(); throw new Error(`Anthropic API error: ${res.status} - ${e}`); }
  const result = await res.json();
  const text = result.content.filter(b => b.type === "text").map(b => b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse JSON from Anthropic response");
  return JSON.parse(match[0]);
}

// ── Fetch and aggregate all survey data ───────────────────────────────────────
async function fetchSurveyData() {
  const ids = await getSurveyIds();
  console.log(`Found surveys: ${Object.keys(ids).join(", ")}`);

  let allResponses = [], startedTotal = 0;
  const byLanguage = {};

  for (const [title, id] of Object.entries(ids)) {
    const lang = title.match(/\((\w+)\)$/)?.[1] || title;
    const completed = await getAllResponses(id);
    // Get started count separately
    const startedData = await smGet(`/surveys/${id}/responses/bulk?per_page=1`);
    const started = startedData.total || completed.length;
    startedTotal += started;
    byLanguage[lang] = { started, completed: completed.length };
    allResponses = allResponses.concat(completed.map(r => ({ ...r, _lang: lang })));
    console.log(`${lang}: ${completed.length} completed, ${started} started`);
  }

  const data = await processResponses({
    total: allResponses.length,
    started: startedTotal,
    sample: allResponses.slice(0, 200) // send sample to Anthropic for processing
  });

  // Override language counts with accurate SM data
  data.byLanguage = byLanguage;
  data.totalStarted = startedTotal;
  data.totalCompleted = allResponses.length;
  return data;
}

// ── Build email body ──────────────────────────────────────────────────────────
function buildEmail(data) {
  const today         = new Date();
  const daysElapsed   = Math.max(0, daysDiff(START_DATE, today));
  const daysRemaining = Math.max(0, daysDiff(today, END_DATE));
  const totalDays     = daysDiff(START_DATE, END_DATE);
  const completed     = data.totalCompleted || 0;
  const started       = data.totalStarted   || 0;
  const respPct       = pct(completed, TOTAL_TARGET);
  const compRate      = started > 0 ? Math.round(completed / started * 100) : 0;
  const dailyRate     = daysElapsed > 0 ? Math.round(completed / daysElapsed) : 0;
  const projected     = completed + (dailyRate * daysRemaining);

  const date      = today.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
  const shortDate = today.toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" });

  let body = `CHILD FRIENDLY PENANG – DAILY SURVEY UPDATE\n`;
  body += `${date}\n${"─".repeat(52)}\n\n`;
  body += `Survey day ${daysElapsed} of ${totalDays}  ·  ${daysRemaining} days remaining\n\n`;
  body += `  Started:         ${started.toLocaleString()}\n`;
  body += `  Completed:       ${completed.toLocaleString()} / ${TOTAL_TARGET.toLocaleString()} (${respPct}%)\n`;
  body += `  Completion rate: ${compRate}%  (started → submitted)\n`;
  body += `  Daily pace:      ~${dailyRate}/day  ·  Projected total: ${projected.toLocaleString()}\n\n`;

  body += `BY LANGUAGE\n`;
  ["English","Malay","Mandarin","Tamil"].forEach(l => {
    const ld = data.byLanguage?.[l] || {};
    const lc = ld.completed || 0, ls = ld.started || 0;
    const lp = ls > 0 ? Math.round(lc/ls*100) : 0;
    body += `  ${l.padEnd(10)} ${String(lc).padStart(4)} completed  /  ${String(ls).padStart(4)} started  (${lp}%)\n`;
  });

  body += `\nDISTRICT × ETHNICITY — GAPS (< 75% of quota)\n`;
  let anyGap = false;
  DISTRICTS.forEach(dx => {
    ETHNICITIES.forEach(e => {
      const actual = data.crossTab?.[dx]?.[e] || 0;
      const target = EQ[dx]?.[e] || 75;
      const p = pct(actual, target);
      if (p < 75) { body += `  ${flag(p)} ${dx} / ${e}: ${actual}/${target} (${p}%)\n`; anyGap = true; }
    });
  });
  if (!anyGap) body += `  ✓ All cells on track\n`;

  body += `\n1D QUOTA SUMMARY\n  District:\n`;
  DISTRICTS.forEach(x => {
    const actual = ETHNICITIES.reduce((s,e) => s + (data.crossTab?.[x]?.[e]||0), 0);
    body += `    ${flag(pct(actual,Q1.district[x]))} ${x.padEnd(14)} ${actual}/${Q1.district[x]} (${pct(actual,Q1.district[x])}%)\n`;
  });
  body += `  Ethnicity:\n`;
  ETHNICITIES.forEach(x => {
    const actual = DISTRICTS.reduce((s,dx) => s + (data.crossTab?.[dx]?.[x]||0), 0);
    body += `    ${flag(pct(actual,Q1.ethnicity[x]))} ${x.padEnd(10)} ${actual}/${Q1.ethnicity[x]} (${pct(actual,Q1.ethnicity[x])}%)\n`;
  });
  body += `  Age:\n`;
  AGE_GRP.forEach(x => {
    const actual = DISTRICTS.reduce((s,dx) => s + (data.ageByDistrict?.[dx]?.[x]||0), 0);
    body += `    ${flag(pct(actual,Q1.age[x]))} Age ${x}    ${actual}/${Q1.age[x]} (${pct(actual,Q1.age[x])}%)\n`;
  });
  body += `  Income:\n`;
  INCOME_GRP.forEach(x => {
    const actual = DISTRICTS.reduce((s,dx) => s + (data.incomeByDistrict?.[dx]?.[x]||0), 0);
    body += `    ${flag(pct(actual,Q1.income[x]))} ${x.padEnd(6)} ${actual}/${Q1.income[x]} (${pct(actual,Q1.income[x])}%)\n`;
  });

  if (data.noDistrict > 0) body += `\n⚠ ${data.noDistrict} responses missing district.\n`;
  body += `\n${"─".repeat(52)}\nLegend: ✓ on track (≥100%)  ~ close (75–99%)  ⚠ behind (<75%)\nAutomated daily report — Child Friendly Penang Survey Monitor.\n`;

  return { subject: `CFP Survey Update – ${shortDate} (${completed}/${TOTAL_TARGET}, ${respPct}%)`, body };
}

// ── Send via Office 365 SMTP ──────────────────────────────────────────────────
async function sendEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    host: "smtp.office365.com", port: 587, secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { ciphers: "SSLv3" }
  });
  await transporter.sendMail({
    from: `"CFP Monitor" <${process.env.SMTP_USER}>`,
    to: EMAIL_TO.join(", "), subject, text: body,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[${new Date().toISOString()}] Starting daily report...`);
  try {
    const data = await fetchSurveyData();
    console.log(`Fetched: ${data.totalCompleted} completed, ${data.totalStarted} started`);
    const { subject, body } = buildEmail(data);
    await sendEmail(subject, body);
    console.log(`Report sent to: ${EMAIL_TO.join(", ")}`);
  } catch (err) {
    console.error("Report failed:", err.message);
    process.exit(1);
  }
})();
