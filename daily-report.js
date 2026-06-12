// CFP Survey – Daily Report Scheduler
// Email via SendGrid REST API (no extra dependencies needed)

const START_DATE   = new Date("2026-06-15");
const END_DATE     = new Date("2026-07-20");
const TOTAL_TARGET = 2200;
const EMAIL_TO     = ["yancheng.tan@thinkcity.com.my", "hana.zulkifli@thinkcity.com.my"];
const SM_API       = "https://api.surveymonkey.com/v3";

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

function daysDiff(a, b) { return Math.floor((b - a) / 86400000); }
function pct(actual, target) { return target > 0 ? Math.round(actual / target * 100) : 0; }
function flag(p) { return p >= 100 ? "✓" : p >= 75 ? "~" : "⚠"; }

async function smGet(path) {
  const token = process.env.SM_ACCESS_TOKEN;
  console.log(`SM token length: ${token ? token.length : 'MISSING'}, first 8: ${token ? token.substring(0,8) : 'N/A'}`);
  const res = await fetch(`${SM_API}${path}`, {
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SM API error ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

async function fetchSurveyData() {
  console.log("Testing SM API connection...");
  const list = await smGet("/surveys?per_page=10");
  console.log(`SM API OK - found ${list.total} surveys`);

  // Find surveys by title
  const SURVEYS = {};
  let page = 1;
  while (true) {
    console.log(`Searching page ${page}...`);
    const data = await smGet(`/surveys?per_page=50&page=${page}`);
    for (const s of data.data || []) {
      if (page === 1) console.log("  API title: " + JSON.stringify(s.title));
      const CFP_TITLES = {
        'Child Friendly Penang v3 (English)': 'English',
        'Child Friendly Penang v3 (Malay)': 'Malay',
        'Child Friendly Penang v3 (Mandarin)': 'Mandarin',
        '槟城亲子友好': 'Mandarin',
        'Child Friendly Penang v3 (Tamil)': 'Tamil',
        'Pulau Pinang Mesra Kanak-Kanak': 'Malay',
        'பினாங்கு குழந்தைகள் நேச நகரம்': 'Tamil',
      };
      if (CFP_TITLES[s.title]) {
        SURVEYS[CFP_TITLES[s.title]] = s.id;
        console.log(`Found ${CFP_TITLES[s.title]}: ${s.id}`);
      } else if (s.title === 'Child Friendly Penang' && !SURVEYS['English']) {
        SURVEYS['English'] = s.id;
        console.log(`Found English (plain title): ${s.id}`);
      } else if (s.title === 'Child Friendly Penang' && !SURVEYS['Mandarin']) {
        SURVEYS['Mandarin'] = s.id;
        console.log(`Found Mandarin (plain title): ${s.id}`);
      }
    }
    if (!data.links?.next) break;
    page++;
  }
  console.log(`Located ${Object.keys(SURVEYS).length} surveys`);

  let allResponses = [], startedTotal = 0;
  const byLanguage = {};

  for (const [lang, id] of Object.entries(SURVEYS)) {
    try {
      const completed = await smGet(`/surveys/${id}/responses/bulk?per_page=100&status=completed`);
      const started = await smGet(`/surveys/${id}/responses/bulk?per_page=1`);
      byLanguage[lang] = { started: started.total || 0, completed: completed.total || 0 };
      startedTotal += started.total || 0;
      allResponses = allResponses.concat((completed.data || []).map(r => ({ ...r, _lang: lang })));
      console.log(`${lang}: ${completed.total} completed, ${started.total} started`);
    } catch (e) {
      console.warn(`Warning - ${lang}: ${e.message}`);
      byLanguage[lang] = { started: 0, completed: 0 };
    }
  }

  // Process via Anthropic
  const data = await processResponses({ total: allResponses.length, started: startedTotal, sample: allResponses.slice(0, 200) });
  data.byLanguage = byLanguage;
  data.totalStarted = startedTotal;
  data.totalCompleted = allResponses.length;
  return data;
}

async function processResponses(allResponses) {
  const prompt = `Aggregate this SurveyMonkey response data using these rules:
ETHNICITY: Melayu/Bumiputera|马来人|மலாய் → Malay; Cina|华人|சீனர் → Chinese; India|印度人|இந்தியர் → Indian; Others/Lain-lain/Refugee → Others
DISTRICT: SP Utara: Penaga,Bertam,Pinang Tunggal,Permatang Berangan,Sungai Dua,Telok Ayer Tawar,Sungai Puyu,Bagan Jermal,Bagan Dalam. SP Tengah: Seberang Jaya,Permatang Pasir,Penanti,Berapit,Machang Bubok,Padang Lalang,Perai,Bukit Tengah,Bukit Tambun. SP Selatan: Jawi,Sungai Bakap,Sungai Acheh. Timur Laut: Tanjong Bunga,Air Putih,Kebun Bunga,Pulau Tikus,Padang Kota,Pengkalan Kota,Komtar,Datok Keramat,Sungai Pinang,Batu Lanchang,Seri Delima,Bukit Glugor,Paya Terubong,Batu Uban. Barat Daya: Pantai Jerejak,Batu Maung,Bayan Lepas,Pulau Betong,Telok Bahang
INCOME: ≤RM4,849→B40; RM4,850–10,970→M40; >RM10,970→T20
AGE: 10/11/12→10-12; 13/14/15/16→13-16; 17/18→17-18
Data: ${JSON.stringify(allResponses.sample)}
Return ONLY valid JSON: {"totalStarted":${allResponses.started},"totalCompleted":${allResponses.total},"byLanguage":{"English":{"started":0,"completed":0},"Malay":{"started":0,"completed":0},"Mandarin":{"started":0,"completed":0},"Tamil":{"started":0,"completed":0}},"crossTab":{"Timur Laut":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"Barat Daya":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"SP Utara":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"SP Tengah":{"Malay":0,"Chinese":0,"Indian":0,"Others":0},"SP Selatan":{"Malay":0,"Chinese":0,"Indian":0,"Others":0}},"incomeByDistrict":{"Timur Laut":{"B40":0,"M40":0,"T20":0},"Barat Daya":{"B40":0,"M40":0,"T20":0},"SP Utara":{"B40":0,"M40":0,"T20":0},"SP Tengah":{"B40":0,"M40":0,"T20":0},"SP Selatan":{"B40":0,"M40":0,"T20":0}},"ageByDistrict":{"Timur Laut":{"10-12":0,"13-16":0,"17-18":0},"Barat Daya":{"10-12":0,"13-16":0,"17-18":0},"SP Utara":{"10-12":0,"13-16":0,"17-18":0},"SP Tengah":{"10-12":0,"13-16":0,"17-18":0},"SP Selatan":{"10-12":0,"13-16":0,"17-18":0}},"byGender":{"Male":0,"Female":0},"byIncome":{"B40":0,"M40":0,"T20":0},"vulnerableGroups":{"Children with disability":0,"Single-parent households":0},"noDistrict":0}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 3000, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`Anthropic error: ${res.status} - ${e}`); }
  const result = await res.json();
  const text = result.content.filter(b => b.type === "text").map(b => b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse Anthropic JSON response");
  return JSON.parse(match[0]);
}

function buildEmail(data) {
  const today = new Date();
  const daysElapsed = Math.max(0, daysDiff(START_DATE, today));
  const daysRemaining = Math.max(0, daysDiff(today, END_DATE));
  const totalDays = daysDiff(START_DATE, END_DATE);
  const completed = data.totalCompleted || 0, started = data.totalStarted || 0;
  const respPct = pct(completed, TOTAL_TARGET);
  const compRate = started > 0 ? Math.round(completed / started * 100) : 0;
  const dailyRate = daysElapsed > 0 ? Math.round(completed / daysElapsed) : 0;
  const projected = completed + (dailyRate * daysRemaining);
  const date = today.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
  const shortDate = today.toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" });

  let body = `CHILD FRIENDLY PENANG – DAILY SURVEY UPDATE\n${date}\n${"─".repeat(52)}\n\n`;
  body += `Survey day ${daysElapsed} of ${totalDays}  ·  ${daysRemaining} days remaining\n\n`;
  body += `  Started:         ${started.toLocaleString()}\n`;
  body += `  Completed:       ${completed.toLocaleString()} / ${TOTAL_TARGET.toLocaleString()} (${respPct}%)\n`;
  body += `  Completion rate: ${compRate}%\n`;
  body += `  Daily pace:      ~${dailyRate}/day  ·  Projected: ${projected.toLocaleString()}\n\n`;

  body += `BY LANGUAGE\n`;
  ["English","Malay","Mandarin","Tamil"].forEach(l => {
    const ld = data.byLanguage?.[l] || {};
    const lc = ld.completed||0, ls = ld.started||0;
    body += `  ${l.padEnd(10)} ${String(lc).padStart(4)} completed / ${String(ls).padStart(4)} started\n`;
  });

  body += `\nDISTRICT × ETHNICITY GAPS (< 75%)\n`;
  let anyGap = false;
  DISTRICTS.forEach(dx => ETHNICITIES.forEach(e => {
    const actual = data.crossTab?.[dx]?.[e]||0, target = EQ[dx]?.[e]||75, p = pct(actual,target);
    if (p < 75) { body += `  ${flag(p)} ${dx} / ${e}: ${actual}/${target} (${p}%)\n`; anyGap = true; }
  }));
  if (!anyGap) body += `  ✓ All cells on track\n`;

  body += `\n1D SUMMARY\n  District:\n`;
  DISTRICTS.forEach(x => { const a=ETHNICITIES.reduce((s,e)=>s+(data.crossTab?.[x]?.[e]||0),0); body+=`    ${flag(pct(a,Q1.district[x]))} ${x.padEnd(14)} ${a}/${Q1.district[x]} (${pct(a,Q1.district[x])}%)\n`; });
  body += `  Ethnicity:\n`;
  ETHNICITIES.forEach(x => { const a=DISTRICTS.reduce((s,dx)=>s+(data.crossTab?.[dx]?.[x]||0),0); body+=`    ${flag(pct(a,Q1.ethnicity[x]))} ${x.padEnd(10)} ${a}/${Q1.ethnicity[x]} (${pct(a,Q1.ethnicity[x])}%)\n`; });
  body += `  Age:\n`;
  AGE_GRP.forEach(x => { const a=DISTRICTS.reduce((s,dx)=>s+(data.ageByDistrict?.[dx]?.[x]||0),0); body+=`    ${flag(pct(a,Q1.age[x]))} Age ${x}  ${a}/${Q1.age[x]} (${pct(a,Q1.age[x])}%)\n`; });
  body += `  Income:\n`;
  INCOME_GRP.forEach(x => { const a=DISTRICTS.reduce((s,dx)=>s+(data.incomeByDistrict?.[dx]?.[x]||0),0); body+=`    ${flag(pct(a,Q1.income[x]))} ${x.padEnd(6)} ${a}/${Q1.income[x]} (${pct(a,Q1.income[x])}%)\n`; });

  body += `\n${"─".repeat(52)}\nLegend: ✓ on track  ~ close (75-99%)  ⚠ behind (<75%)\nAutomated daily report — Child Friendly Penang Survey Monitor.\n`;
  return { subject: `CFP Survey Update – ${shortDate} (${completed}/${TOTAL_TARGET}, ${respPct}%)`, body };
}

async function sendEmail(subject, body) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: EMAIL_TO.map(e => ({ email: e })) }],
      from: { email: process.env.SENDGRID_FROM_EMAIL, name: 'CFP Monitor' },
      subject,
      content: [{ type: 'text/plain', value: body }]
    })
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`SendGrid error: ${res.status} - ${e}`); }
  console.log('Email sent via SendGrid');
}

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
