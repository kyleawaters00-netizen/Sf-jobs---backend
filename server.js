/**
 * SF.JOBS — Backend Server
 * Proxy + Scheduler + API
 * Node.js / Express
 */

import express from "express";
import cors from "cors";
import cron from "node-cron";
import fetch from "node-fetch";
import { readFileSync, writeFileSync, existsSync } from "fs";

const app = express();
const PORT = process.env.PORT || 3001;
const DB_FILE = "./data/jobs.json"; // simple flat-file store; swap for Postgres/Supabase later

app.use(cors()); // allow your PWA origin
app.use(express.json());

// ─── KEYWORDS ────────────────────────────────────────────────────────────────
const SF_KEYWORDS = [
  "salesforce","sfdc","sales cloud","service cloud","marketing cloud",
  "pardot","account engagement","einstein","apex","visualforce","lightning",
  "soql","cpq","mulesoft","tableau crm","experience cloud","field service",
  "revenue cloud","data cloud","lwc",
];
const UK_KEYWORDS = [
  "uk","united kingdom","england","scotland","wales","london","manchester",
  "birmingham","bristol","leeds","edinburgh","remote","hybrid","nationwide","gb",
];
const AGENCY_SIGNALS = [
  "our client","my client","on behalf of","day rate","umbrella company",
  "recruitment consultancy","staffing","we are recruiting on behalf",
];

function isSF(title="",desc="")   { const t=(title+" "+desc).toLowerCase(); return SF_KEYWORDS.some(k=>t.includes(k)); }
function isUK(loc="",desc="")    { const t=(loc+" "+desc).toLowerCase(); return UK_KEYWORDS.some(k=>t.includes(k)); }
function isAgency(desc="")       { const t=desc.toLowerCase(); return AGENCY_SIGNALS.some(k=>t.includes(k)); }
function contractType(title="",desc="") {
  const t=(title+" "+desc).toLowerCase();
  if(t.includes("contract")||t.includes("day rate")||t.includes("interim")||t.includes("fixed term")) return "Contract";
  return "Permanent";
}
function seniority(title="") {
  const t=title.toLowerCase();
  if(t.includes("head of")||t.includes("vp")||t.includes("director")||t.includes("principal")) return "Leadership";
  if(t.includes("senior")||t.includes("lead")||t.includes("staff")||t.includes("architect")) return "Senior";
  if(t.includes("junior")||t.includes("graduate")||t.includes("entry")) return "Junior";
  return "Mid";
}
function stripHtml(h="") { return h.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim(); }
function excerpt(s="",n=300) { return s.length>n ? s.slice(0,n)+"…" : s; }

// ─── ENTERPRISE SEED LIST ─────────────────────────────────────────────────────
const ENTERPRISE_SEED = [
  { name:"BT Group",        size:"Enterprise", workday:"bt" },
  { name:"Sky",             size:"Enterprise", workday:"sky" },
  { name:"Aviva",           size:"Enterprise", workday:"aviva" },
  { name:"Centrica",        size:"Enterprise", workday:"centrica" },
  { name:"John Lewis",      size:"Enterprise", workday:"johnlewis" },
  { name:"Marks & Spencer", size:"Enterprise", workday:"marksandspencer" },
  { name:"THG",             size:"Enterprise", workday:"thg" },
  { name:"News UK",         size:"Enterprise", smart:"news-uk" },
  { name:"Direct Line",     size:"Enterprise", greenhouse:"directlinegroup" },
  { name:"Ocado",           size:"Enterprise", greenhouse:"ocado" },
  { name:"Auto Trader",     size:"Mid-Market", greenhouse:"autotrader" },
  { name:"Sage",            size:"Enterprise", greenhouse:"sage" },
];

// ─── LAYER 1: ATS-FIRST GLOBAL SEARCH ────────────────────────────────────────
async function layer1_greenhouse() {
  const results = [];
  const queries = ["salesforce+developer","salesforce+administrator","salesforce+architect","salesforce+consultant"];
  for (const q of queries) {
    try {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/jobs?q=${q}`);
      if (!r.ok) continue;
      const d = await r.json();
      for (const j of (d.jobs||[])) {
        const desc = stripHtml(j.content||"");
        if (!isSF(j.title,desc) || !isUK(j.location?.name,desc) || isAgency(desc)) continue;
        results.push({
          id:`gh-${j.id}`, source:"Layer 1 · ATS Search",
          company:j.company?.name||"Unknown", size:"Unknown",
          title:j.title, location:j.location?.name||"UK",
          url:j.absolute_url, postedAt:j.updated_at||new Date().toISOString(),
          ats:"Greenhouse", contractType:contractType(j.title,desc),
          seniority:seniority(j.title), description:excerpt(desc),
        });
      }
    } catch(e) { console.error("GH layer1 error:", e.message); }
  }
  return results;
}

async function layer1_lever() {
  const results = [];
  const queries = ["salesforce","apex developer","sfdc"];
  for (const q of queries) {
    try {
      const r = await fetch(`https://api.lever.co/v0/postings?mode=json&text=${encodeURIComponent(q)}&limit=100`);
      if (!r.ok) continue;
      const d = await r.json();
      for (const j of (d||[])) {
        const desc = j.descriptionPlain||"";
        if (!isSF(j.text,desc) || !isUK(j.categories?.location||"",desc) || isAgency(desc)) continue;
        results.push({
          id:`lv-${j.id}`, source:"Layer 1 · ATS Search",
          company:j.company||j.categories?.team||"Unknown", size:"Unknown",
          title:j.text, location:j.categories?.location||"UK",
          url:j.hostedUrl, postedAt:new Date(j.createdAt).toISOString(),
          ats:"Lever", contractType:contractType(j.text,desc),
          seniority:seniority(j.text), description:excerpt(desc),
        });
      }
    } catch(e) { console.error("Lever layer1 error:", e.message); }
  }
  return results;
}

async function layer1_smartrecruiters() {
  try {
    const r = await fetch(`https://api.smartrecruiters.com/v1/postings?q=salesforce&country=GB&limit=100`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.content||[]).reduce((acc,j) => {
      const desc = stripHtml(j.jobAd?.sections?.jobDescription?.text||"");
      if (isAgency(desc)) return acc;
      const loc = `${j.location?.city||""} ${j.location?.country||""}`;
      if (!isUK(loc,"")) return acc;
      acc.push({
        id:`sr-${j.id}`, source:"Layer 1 · ATS Search",
        company:j.company?.name||"Unknown", size:"Unknown",
        title:j.name, location:loc,
        url:`https://jobs.smartrecruiters.com/${j.company?.identifier}/${j.id}`,
        postedAt:j.releasedDate||new Date().toISOString(),
        ats:"SmartRecruiters", contractType:contractType(j.name,desc),
        seniority:seniority(j.name), description:excerpt(desc),
      });
      return acc;
    }, []);
  } catch(e) { console.error("SR layer1 error:", e.message); return []; }
}

// ─── LAYER 2: ENTERPRISE SEED LIST ───────────────────────────────────────────
async function layer2_workday(company) {
  try {
    const url = `https://${company.workday}.wd3.myworkdayjobs.com/wday/cxs/${company.workday}/External/jobs`;
    const r = await fetch(url, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ limit:20, offset:0, searchText:"salesforce" }),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.jobPostings||[]).reduce((acc,j) => {
      const loc = j.locationsText||"";
      if (!isUK(loc,"")) return acc;
      acc.push({
        id:`wd-${j.externalPath}`, source:"Layer 2 · Seed List",
        company:company.name, size:company.size,
        title:j.title, location:loc, ats:"Workday",
        url:`https://${company.workday}.wd3.myworkdayjobs.com${j.externalPath}`,
        postedAt:j.postedOn||new Date().toISOString(),
        contractType:contractType(j.title,""), seniority:seniority(j.title),
        description:j.shortDescription||"View full role on Workday.",
      });
      return acc;
    }, []);
  } catch(e) { console.error(`Workday ${company.name} error:`, e.message); return []; }
}

async function layer2_greenhouse(company) {
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${company.greenhouse}/jobs?content=true`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.jobs||[]).reduce((acc,j) => {
      const desc = stripHtml(j.content||"");
      if (!isSF(j.title,desc)||!isUK(j.location?.name||"",desc)||isAgency(desc)) return acc;
      acc.push({
        id:`gh2-${j.id}`, source:"Layer 2 · Seed List",
        company:company.name, size:company.size,
        title:j.title, location:j.location?.name||"UK",
        url:j.absolute_url, postedAt:j.updated_at||new Date().toISOString(),
        ats:"Greenhouse", contractType:contractType(j.title,desc),
        seniority:seniority(j.title), description:excerpt(desc),
      });
      return acc;
    }, []);
  } catch(e) { console.error(`GH seed ${company.name} error:`, e.message); return []; }
}

// ─── LAYER 3: GOOGLE CUSTOM SEARCH ───────────────────────────────────────────
const GOOGLE_QUERIES = [
  `"salesforce developer" "united kingdom" -site:linkedin.com -site:indeed.com -site:reed.co.uk`,
  `"salesforce administrator" "uk" careers -site:linkedin.com -site:indeed.com`,
  `"salesforce architect" "united kingdom" -site:linkedin.com -site:indeed.com`,
  `"apex developer" "uk" careers -site:linkedin.com`,
];

async function layer3_google() {
  const { GOOGLE_API_KEY, GOOGLE_CSE_ID } = process.env;
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
    console.log("Layer 3: Google CSE not configured — skipping");
    return [];
  }
  const results = [];
  for (const q of GOOGLE_QUERIES) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(q)}&num=10`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const d = await r.json();
      for (const item of (d.items||[])) {
        // Skip known job boards — we only want direct employer career pages
        const boardDomains = ["linkedin.com","indeed.com","reed.co.uk","totaljobs.com","cv-library.co.uk","glassdoor.com","cwjobs.co.uk","jobserve.com","monster.co.uk","jobsite.co.uk"];
        if (boardDomains.some(bd => item.link.includes(bd))) continue;
        results.push({
          id:`g3-${Buffer.from(item.link).toString("base64").slice(0,16)}`,
          source:"Layer 3 · Careers Page",
          company: item.displayLink.replace("www.","").split(".")[0],
          size:"Unknown",
          title: item.title.replace(/\s*[-|].*$/, "").trim(),
          location: "UK", ats:"Custom Page",
          url: item.link,
          postedAt: new Date().toISOString(),
          contractType:"Permanent", seniority: seniority(item.title),
          description: item.snippet||"",
        });
      }
    } catch(e) { console.error("Google CSE error:", e.message); }
  }
  return results;
}

// ─── DEDUPLICATION ───────────────────────────────────────────────────────────
function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const key = `${j.title.toLowerCase().trim()}-${j.company.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function runScan() {
  console.log(`[${new Date().toISOString()}] Starting scan…`);
  const all = [];

  // Layer 1
  console.log("  Layer 1: ATS global search…");
  const [gh1, lv1, sr1] = await Promise.allSettled([
    layer1_greenhouse(), layer1_lever(), layer1_smartrecruiters(),
  ]);
  [gh1, lv1, sr1].forEach(r => { if(r.status==="fulfilled") all.push(...r.value); });
  console.log(`  Layer 1 complete: ${all.length} roles`);

  // Layer 2
  console.log("  Layer 2: Enterprise seed list…");
  const seedJobs = await Promise.allSettled(
    ENTERPRISE_SEED.map(c => {
      if (c.workday)    return layer2_workday(c);
      if (c.greenhouse) return layer2_greenhouse(c);
      return Promise.resolve([]);
    })
  );
  seedJobs.forEach(r => { if(r.status==="fulfilled") all.push(...r.value); });
  console.log(`  Layer 2 complete: ${all.length} roles total`);

  // Layer 3
  console.log("  Layer 3: Google Custom Search…");
  const g3 = await layer3_google();
  all.push(...g3);
  console.log(`  Layer 3 complete: ${all.length} roles total`);

  const final = dedupe(all);
  const result = {
    jobs: final,
    lastScan: new Date().toISOString(),
    stats: {
      total: final.length,
      layer1: final.filter(j=>j.source.startsWith("Layer 1")).length,
      layer2: final.filter(j=>j.source.startsWith("Layer 2")).length,
      layer3: final.filter(j=>j.source.startsWith("Layer 3")).length,
    }
  };

  // Detect new jobs vs previous scan
  const prev = loadDB();
  const prevIds = new Set((prev.jobs||[]).map(j=>j.id));
  result.newSinceLastScan = final.filter(j=>!prevIds.has(j.id)).length;

  saveDB(result);
  console.log(`[${new Date().toISOString()}] Scan complete. ${final.length} roles (${result.newSinceLastScan} new)`);
  return result;
}

// ─── FLAT FILE DB ─────────────────────────────────────────────────────────────
function loadDB() {
  if (!existsSync(DB_FILE)) return { jobs:[], lastScan:null, stats:{} };
  try { return JSON.parse(readFileSync(DB_FILE,"utf8")); }
  catch { return { jobs:[], lastScan:null, stats:{} }; }
}
function saveDB(data) {
  writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// GET /api/jobs — return cached jobs
app.get("/api/jobs", (req, res) => {
  const db = loadDB();
  res.json(db);
});

// POST /api/scan — trigger a manual scan
app.post("/api/scan", async (req, res) => {
  try {
    const result = await runScan();
    res.json({ ok:true, stats:result.stats, newSinceLastScan:result.newSinceLastScan });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// GET /api/status — health check + last scan info
app.get("/api/status", (req, res) => {
  const db = loadDB();
  res.json({
    status:"ok",
    lastScan: db.lastScan,
    totalJobs: db.jobs?.length||0,
    stats: db.stats||{},
    newSinceLastScan: db.newSinceLastScan||0,
    googleCseConfigured: !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID),
  });
});

// ─── SCHEDULER ───────────────────────────────────────────────────────────────
// Runs once a day at 07:00 UK time
cron.schedule("0 7 * * *", () => {
  console.log("Scheduled daily scan starting…");
  runScan().catch(console.error);
}, { timezone:"Europe/London" });

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SF.JOBS backend running on port ${PORT}`);
  console.log(`Google CSE: ${process.env.GOOGLE_API_KEY ? "✓ configured" : "✗ not configured (Layer 3 disabled)"}`);

  // Run an initial scan on startup if no cached data exists
  const db = loadDB();
  if (!db.lastScan) {
    console.log("No cached data — running initial scan…");
    runScan().catch(console.error);
  }
});
