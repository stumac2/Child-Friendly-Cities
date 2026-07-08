#!/usr/bin/env node
/**
 * One-off diagnostic: dump every question in the English survey with its family,
 * subtype, heading, row count and choice sample. Purpose: locate the disability
 * (Washington Group) questions, whose structure neither heading nor matrix
 * detection has found. Writes a text file (no API-heavy response fetch).
 *
 * Run: node dump-questions.js
 * Output: docs/question-dump.txt
 */
const fs = require("fs");
const SM_BASE  = "https://api.surveymonkey.com/v3";
const SM_TOKEN = process.env.SM_MCP_TOKEN;
const ENGLISH_ID = "422468336";

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0;
async function smGet(path, attempt = 1) {
  const MAX = 5;
  const since = Date.now() - lastCall;
  if (since < 600) await sleep(600 - since);
  lastCall = Date.now();
  const res = await fetch(`${SM_BASE}${path}`, { headers: { Authorization: `Bearer ${SM_TOKEN}` } });
  if (res.status === 429 && attempt < MAX) { await sleep(5000 * 2 ** (attempt-1)); return smGet(path, attempt+1); }
  if (!res.ok) throw new Error(`SM API ${res.status}: ${await res.text()}`);
  return res.json();
}

(async () => {
  const details = await smGet(`/surveys/${ENGLISH_ID}/details`);
  const lines = [];
  let pos = 0;
  for (const page of (details.pages || [])) {
    for (const q of (page.questions || [])) {
      const heading = (q.headings?.[0]?.heading || "").replace(/<[^>]+>/g, "").slice(0, 90);
      const rows = (q.answers?.rows || []).map(r => (r.text||"").slice(0,40));
      const cols = (q.answers?.choices || []).map(c => (c.text||"").slice(0,30));
      lines.push(`[pos ${pos}] id=${q.id} family=${q.family}/${q.subtype}`);
      lines.push(`   heading: ${heading}`);
      if (rows.length) lines.push(`   rows(${rows.length}): ${rows.join(" | ")}`);
      if (cols.length) lines.push(`   choices(${cols.length}): ${cols.join(" | ")}`);
      lines.push("");
      pos++;
    }
  }
  if (!fs.existsSync("docs")) fs.mkdirSync("docs");
  fs.writeFileSync("docs/question-dump.txt", lines.join("\n"));
  console.log(`Wrote docs/question-dump.txt (${pos} questions)`);

  // ── Deep dump of the disability matrix/menu question (id 289909840) ──
  // matrix/menu stores answer options differently: rows + per-question "cols"/"other",
  // and each row's menu choices live under answers.cols[].choices or similar.
  console.log("\n=== DISABILITY QUESTION RAW STRUCTURE (289909840) ===");
  for (const page of (details.pages || [])) {
    for (const q of (page.questions || [])) {
      if (q.id === "289909840") {
        console.log(JSON.stringify(q.answers, null, 2));
      }
    }
  }
  console.log("=== END DISABILITY RAW ===");

  // Also print the difficulty-neighbourhood summary
  console.log("\n=== Questions mentioning difficulty/function words ===");
  const kw = /difficult|seeing|hearing|walking|remember|concentrat|self.?care|wash|dress|communicat|glasses|disab/i;
  pos = 0;
  for (const page of (details.pages || [])) {
    for (const q of (page.questions || [])) {
      const heading = (q.headings?.[0]?.heading || "").replace(/<[^>]+>/g, "");
      const rowText = (q.answers?.rows || []).map(r=>r.text||"").join(" ");
      if (kw.test(heading) || kw.test(rowText)) {
        console.log(`  [pos ${pos}] id=${q.id} fam=${q.family}/${q.subtype} heading="${heading.slice(0,70)}" rows=${(q.answers?.rows||[]).length} choices=${(q.answers?.choices||[]).length}`);
      }
      pos++;
    }
  }
})().catch(e => { console.error("Dump failed:", e.message); process.exit(1); });
