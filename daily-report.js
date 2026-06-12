#!/usr/bin/env node
// CFP Survey Daily Report — matches cfp_booster_monitor.jsx (June 2026)
// Runs via GitHub Actions at 9am MYT (1am UTC)

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
const ANTH_KEY   = process.env.ANTHROPIC_API_KEY;
const START_DATE = new Date("2026-06-15");
const END_DATE   = new Date("2026-07-31");
const TOTAL_TARGET  = 2500;
const STRETCH_2D    = 10000;
const STRETCH_3D    = 20000;
const EMAIL_TO   = ["yancheng.tan@thinkcity.com.my", "hana.zulkifli@thinkcity.com.my"];

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
  income: {
    B40:["QR code in PPR noticeboards via MBPP/MBSP housing unit"],
    M40:["Check if school WhatsApp groups need a resend"],
    T20:["Private/international schools — contact admin directly"],
  },
  age: {
    "10-12":["Year 4-6 class teacher reminder to parent WhatsApp groups"],
    "13-16":["PRIORITY — Form 1-3 class teacher reminder for CRG recruitment"],
    "17-18":["Form 4-5 school counsellor outreach to upper secondary parents"],
  },
  gender: {
    Male:["Audit co-ed vs boys-only school distribution — call PPD if gap"],
    Female:["Contact girls-only secondary schools directly"],
  },
  urbanRural: {
    Urban:["PPD digital channels — check completion rate by school"],
    "Peri-urban":["Contact PPD offices for Bukit Mertajam, Bayan Baru, Kepala Batas"],
    Rural:["URGENT — printed QR codes and mosque/surau announcements via JAIPP for rural DUNs"],
  },
};

// ─── Classification prompt for Anthropic ───────────────────────────────────────
const CLASSIFY_PROMPT = `You are a data-processing assistant. Classify the SurveyMonkey response data provided below.

ETHNICITY: Melayu/Bumiputera|马来人|மலாய் → Malay; Cina|华人|சீனர் → Chinese; India|印度人|இந்தியர் → Indian; Others/Lain-lain/Refugee/Non-citizen → Others
DISTRICT: Map DUN name (case-insensitive) to district:
SP Utara: Penaga, Bertam, Pinang Tunggal, Permatang Berangan, Sungai Dua, Telok Ayer Tawar, Sungai Puyu, Bagan Jermal, Bagan Dalam
SP Tengah: Seberang Jaya, Permatang Pasir, Penanti, Berapit, Machang Bubok, Padang Lalang, Perai, Bukit Tengah, Bukit Tambun
SP Selatan: Jawi, Sungai Bakap, Sungai Acheh
Timur Laut: Tanjong Bunga, Air Putih, Kebun Bunga, Pulau Tikus, Padang Kota, Pengkalan Kota, Komtar, Datok Keramat, Sungai Pinang, Batu Lanchang, Seri Delima, Bukit Glugor, Paya Terubong, Batu Uban
Barat Daya: Pantai Jerejak, Batu Maung, Bayan Lepas, Pulau Betong, Telok Bahang
URBAN/RURAL:
Urban: Tanjong Bunga, Air Putih, Kebun Bunga, Pulau Tikus, Padang Kota, Pengkalan Kota, Komtar, Datok Keramat, Sungai Pinang, Batu Lanchang, Seri Delima, Bukit Glugor, Batu Uban, Seberang Jaya, Perai, Sungai Puyu, Bagan Jermal, Bagan Dalam, Pantai Jerejak, Batu Maung, Bayan Lepas
Peri-urban: Paya Terubong, Bertam, Pinang Tunggal, Permatang Berangan, Sungai Dua, Permatang Pasir, Berapit, Padang Lalang, Bukit Tengah, Bukit Tambun, Jawi, Sungai Bakap, Sungai Acheh
Rural: Penaga, Telok Ayer Tawar, Penanti, Machang Bubok, Pulau Betong, Telok Bahang
INCOME: ≤RM4,849 → B40; RM4,850-10,970 → M40; >RM10,970 → T20
AGE: 10/11/12 → 10-12; 13/14/15/16 → 13-16; 17/18 → 17-18
DISABILITY: any "some difficulty" or worse on Washington Group questions → true
VULNERABLE: ethnicity="Refugee/Undocumented" → Refugees; marital=single/divorced/widowed → Single-parent; school contains "Children's Home"/"Tunas Bakti" → Institutional

COMPLETION: status=partial or complete → started; status=complete → completed.

Return ONLY valid JSON:
{"totalStarted":0,"totalCompleted":0,"byLanguage":{"English":{"started":0,"completed":0},"Malay":{"started":0,"completed":0},"Mandarin":{"started":0,"completed":0},"Tamil":{"started":0,"completed":0}},"crossTab":{"Timur Laut":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"Barat Daya":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"SP Utara":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"SP Tengah":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"SP Selatan":{"Malay":0,"Chinese":0,"Indian":0,"Others":0}},"incomeByDistrict":{"Timur Laut":{"B40":0,"M40":0,"T20":0},"Barat Daya":{"B40":0,"M40":0,"T20":0},"SP Utara":{"B40":0,"M40":0,"T20":0},"SP Tengah":{"B40":0,"M40":0,"T20":0},"SP Selatan":{"B40":0,"M40":0,"T20":0}},"byGender":{"Male":0,"Female":0},"byUrbanRural":{"Urban":0,"Peri-urban":0,"Rural":0},"vulnerableGroups":{"Refugees / undocumented":0,"Children with disability":0,"Single-parent households":0,"Institutional care":0},"noDistrict":0}`;

// ─── SurveyMonkey fetch ────────────────────────────────────────────────────────
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

// ─── Anthropic classify ────────────────────────────────────────────────────────
async function classifyResponses(allResponses) {
  // Trim response data to reduce token usage — only send answers and metadata
  const trimmed = Object.entries(allResponses).map(([lang, responses]) => ({
    language: lang,
    count: responses.length,
    responses: responses.map(r => ({
      status: r.response_status,
      date_created: r.date_created,
      pages: (r.pages || []).map(p => ({
        questions: (p.questions || []).map(q => ({
          id: q.id,
          answers: q.answers,
        })),
      })),
    })),
  }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTH_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 5000,
      system: CLASSIFY_PROMPT,
      messages: [{ role: "user", content: `Classify these survey responses:\n${JSON.stringify(trimmed)}` }],
    }),
  });

  const result = await res.json();
  if (result.error) throw new Error(`Anthropic API error: ${result.error.message}`);
  const text = result.content.filter(b => b.type === "text").map(b => b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse Anthropic classification response");
  return JSON.parse(match[0]);
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

  const date = today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const sep = "─".repeat(55);

  let body = `CHILD FRIENDLY PENANG - DAILY SURVEY UPDATE\n${date}\n${sep}\n\n`;
  body += `Survey day ${de} of ${totalDays} · ${dr} days remaining\n`;
  body += `Started: ${totalStarted.toLocaleString()} · Completed: ${totalCompleted.toLocaleString()} / ${TOTAL_TARGET.toLocaleString()} (${respPct}%)\n`;
  body += `Completion rate: ${completionRate}% · ~${perDay}/day`;
  if (projected) body += ` · Projected: ${projected.toLocaleString()}`;
  body += `\n\n`;

  // Tier progress
  body += `TARGET TIERS:\n`;
  body += `  1D (${TOTAL_TARGET.toLocaleString()}): ${respPct}%\n`;
  body += `  2D (${STRETCH_2D.toLocaleString()}): ${Math.min(100, Math.round(totalCompleted / STRETCH_2D * 100))}%\n`;
  body += `  3D (${STRETCH_3D.toLocaleString()}): ${Math.min(100, Math.round(totalCompleted / STRETCH_3D * 100))}%\n\n`;

  // Language breakdown
  body += `BY LANGUAGE:\n`;
  for (const [lang, ld] of Object.entries(data.byLanguage || {})) {
    const ls = ld.started || 0, lc = ld.completed || 0;
    const lPct = ls > 0 ? Math.round(lc / ls * 100) : 0;
    body += `  ${lang}: ${lc} completed / ${ls} started (${lPct}%)\n`;
  }
  body += `\n`;

  // Dimension gaps
  const dims = [
    { label: "District", quotas: Q1.district, actions: ACTIONS.district,
      getActual: (cat) => ["Malay","Chinese","Indian","Others"].reduce((s,e) => s + (data.crossTab?.[cat]?.[e] || 0), 0) },
    { label: "Ethnicity", quotas: Q1.ethnicity, actions: ACTIONS.ethnicity,
      getActual: (cat) => ["Timur Laut","Barat Daya","SP Utara","SP Tengah","SP Selatan"].reduce((s,d) => s + (data.crossTab?.[d]?.[cat] || 0), 0) },
    { label: "Income", quotas: Q1.income, actions: ACTIONS.income,
      getActual: (cat) => ["Timur Laut","Barat Daya","SP Utara","SP Tengah","SP Selatan"].reduce((s,d) => s + (data.incomeByDistrict?.[d]?.[cat] || 0), 0) },
    { label: "Gender", quotas: Q1.gender, actions: ACTIONS.gender,
      getActual: (cat) => data.byGender?.[cat] || 0 },
    { label: "Urban/Rural", quotas: Q1.urbanRural, actions: ACTIONS.urbanRural,
      getActual: (cat) => data.byUrbanRural?.[cat] || 0 },
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
      behind.sort((a, b) => a.pct - b.pct);
      body += `${dim.label.toUpperCase()} - ${behind.length} group(s) behind:\n`;
      for (const g of behind) {
        body += `  ${g.cat}: ${g.actual}/${g.target} (${g.pct}%)\n`;
        for (const a of g.actions.slice(0, 2)) {
          body += `    > ${a}\n`;
        }
      }
      body += `\n`;
    }
  }

  if (!anyBehind) body += `All dimension groups currently on track.\n\n`;

  // Vulnerable groups
  const vg = data.vulnerableGroups || {};
  body += `VULNERABLE GROUPS:\n`;
  body += `  Refugees / undocumented: ${vg["Refugees / undocumented"] || 0}\n`;
  body += `  Children with disability: ${vg["Children with disability"] || 0} (target: 50)\n`;
  body += `  Single-parent households: ${vg["Single-parent households"] || 0} (target: 150)\n`;
  body += `  Institutional care: ${vg["Institutional care"] || 0}\n\n`;

  if (data.noDistrict > 0) body += `Note: ${data.noDistrict} responses missing district data.\n\n`;

  body += `${sep}\nAutomated daily report - Child Friendly Penang Survey Monitor\n`;

  return body;
}

// ─── Email ─────────────────────────────────────────────────────────────────────
async function sendEmail(body) {
  const shortDate = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  const transporter = nodemailer.createTransport({
    host: "smtp.office365.com",
    port: 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: EMAIL_TO.join(", "),
    subject: `CFP Survey Update - ${shortDate}`,
    text: body,
  });

  console.log(`Email sent to ${EMAIL_TO.join(", ")}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Starting daily report...`);

  // 1. Test SM API connection
  console.log("Testing SM API connection...");
  await smGet("/surveys?per_page=1");
  console.log("SM API connected.");

  // 2. Fetch all responses from all 4 surveys
  const allResponses = {};
  for (const [lang, id] of Object.entries(SURVEY_IDS)) {
    console.log(`Fetching ${lang} survey (${id})...`);
    allResponses[lang] = await fetchAllResponses(id);
    console.log(`  ${allResponses[lang].length} responses`);
  }

  const totalRaw = Object.values(allResponses).reduce((s, r) => s + r.length, 0);
  console.log(`Total raw responses: ${totalRaw}`);

  if (totalRaw === 0) {
    console.log("No responses yet - sending skeleton report.");
    const emptyData = { totalStarted: 0, totalCompleted: 0, byLanguage: {}, crossTab: {}, incomeByDistrict: {}, byGender: {}, byUrbanRural: {}, vulnerableGroups: {}, noDistrict: 0 };
    const report = buildReport(emptyData);
    await sendEmail(report);
    return;
  }

  // 3. Classify via Anthropic
  console.log("Sending to Anthropic for classification...");
  const classified = await classifyResponses(allResponses);
  console.log(`Classified: ${classified.totalStarted} started, ${classified.totalCompleted} completed`);

  // 4. Build and send report
  const report = buildReport(classified);
  console.log("\n--- REPORT PREVIEW ---\n" + report.slice(0, 500) + "...\n");
  await sendEmail(report);

  console.log(`[${new Date().toISOString()}] Done.`);
}

main().catch(err => {
  console.error("Report failed:", err.message || err);
  process.exit(1);
});
