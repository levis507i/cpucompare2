// scripts/update_passmark_all.js
// PassMark から PC CPU / PC GPU / Mobile CPU を取得して public/data/*.json を生成

import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";

const OUTDIR = path.join("public", "data");

// PC: CSV優先
const PC_TARGETS = [
  {
    key: "pc_cpu",
    url: "https://www.cpubenchmark.net/cpu_list.php?download=1",
    out: path.join(OUTDIR, "pc_cpu.json"),
    nameNeedle: "CPU Name",
    scoreNeedle: "CPU Mark",
    suite: "passmark_cpu",
    itemType: "pc_cpu"
  },
  {
    key: "pc_gpu",
    url: "https://www.videocardbenchmark.net/gpu_list.php?download=1",
    out: path.join(OUTDIR, "pc_gpu.json"),
    nameNeedle: "Videocard Name",
    scoreNeedle: "G3D Mark",
    suite: "passmark_g3d",
    itemType: "pc_gpu"
  }
];

// Mobile
const MOBILE_SOURCES = [
  { key: "android", url: "https://www.androidbenchmark.net/cpumark_chart.html", suite: "passmark_mobile_cpu", itemType: "mobile" },
  { key: "ios", url: "https://www.iphonebenchmark.net/cpumark_chart.html", suite: "passmark_mobile_cpu", itemType: "mobile" }
];

const MOBILE_OUT = path.join(OUTDIR, "mobile.json");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function loadExisting(outFile) {
  if (!fs.existsSync(outFile)) return { cpus: [] };
  try {
    return JSON.parse(fs.readFileSync(outFile, "utf-8"));
  } catch {
    return { cpus: [] };
  }
}

// =======================
// ★★★ 重要修正ポイント ★★★
// =======================
async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "cpucompare/1.0 (internal)",
        "Accept": "text/html,text/csv"
      }
    });

    if (!res.ok) {
      console.warn(`[WARN] Fetch failed ${res.status}: ${url}`);
      return null; // ← 落とさない
    }

    return await res.text();
  } catch (e) {
    console.warn(`[WARN] Fetch error: ${url}`, e.message);
    return null;
  }
}

// ---------- CSV ----------
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];

  for (const line of lines) {
    const cols = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (ch === "," && !inQ) {
        cols.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur);
    rows.push(cols.map(c => c.replace(/^"(.*)"$/, "$1").trim()));
  }
  return rows;
}

// ---------- HTML ----------
function pickTableByHeaders($, mustA, mustB) {
  for (const t of $("table").toArray()) {
    const headers = $(t).find("tr").first().find("th")
      .map((_, th) => $(th).text()).get().join("|");
    if (headers.includes(mustA) && headers.includes(mustB)) return t;
  }
  return null;
}

function parseTableList($, table, nameNeedle, scoreNeedle) {
  if (!table) return new Map();

  const headers = $(table).find("tr").first().find("th")
    .map((_, th) => $(th).text()).get();

  const nameIdx = headers.findIndex(h => h.includes(nameNeedle));
  const scoreIdx = headers.findIndex(h => h.includes(scoreNeedle));
  if (nameIdx < 0 || scoreIdx < 0) return new Map();

  const items = new Map();
  $(table).find("tr").slice(1).each((_, tr) => {
    const tds = $(tr).find("td");
    const name = $(tds[nameIdx]).text().trim();
    const score = Number($(tds[scoreIdx]).text().replace(/,/g, ""));
    if (name && Number.isFinite(score)) items.set(name, score);
  });
  return items;
}

// ---------- PC ----------
async function updatePcTarget(t) {
  const text = await fetchText(t.url);
  if (!text) {
    console.log(`[SKIP] ${t.key} (source unavailable)`);
    return;
  }

  const existing = loadExisting(t.out);
  const incoming = new Map();

  const looksCsv = text.toLowerCase().includes(t.scoreNeedle.toLowerCase());

  if (looksCsv) {
    const rows = parseCsv(text);
    const header = rows[0].map(h => h.toLowerCase());
    const nameIdx = header.findIndex(h => h.includes(t.nameNeedle.toLowerCase()));
    const scoreIdx = header.findIndex(h => h.includes(t.scoreNeedle.toLowerCase()));

    for (let i = 1; i < rows.length; i++) {
      const name = rows[i][nameIdx];
      const score = Number(rows[i][scoreIdx]?.replace(/,/g, ""));
      if (name && Number.isFinite(score)) {
        incoming.set(name, { [t.suite]: score });
      }
    }
  } else {
    const $ = cheerio.load(text);
    const table = pickTableByHeaders($, t.nameNeedle, t.scoreNeedle);
    const map = parseTableList($, table, t.nameNeedle, t.scoreNeedle);
    for (const [n, s] of map.entries()) incoming.set(n, { [t.suite]: s });
  }

  fs.writeFileSync(
    t.out,
    JSON.stringify(
      {
        meta: { key: t.key, source: t.url, fetched_at: todayISO() },
        cpus: Array.from(incoming, ([name, bench], i) => ({
          id: i + 1,
          name,
          bench
        }))
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`[OK] ${t.key}: ${incoming.size}`);
}

// ---------- Mobile ----------
async function updateMobileMerged() {
  const incoming = new Map();

  for (const s of MOBILE_SOURCES) {
    const html = await fetchText(s.url);
    if (!html) continue;

    const $ = cheerio.load(html);
    $("a").each((_, a) => {
      const name = $(a).text().trim();
      const m = $(a).parent().text().match(/(\d[\d,]*)$/);
      if (!name || !m) return;

      const score = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(score)) return;

      const cur = incoming.get(name) ?? {};
      cur[s.suite] = score;
      incoming.set(name, cur);
    });
  }

  fs.writeFileSync(
    MOBILE_OUT,
    JSON.stringify(
      {
        meta: { key: "mobile", fetched_at: todayISO() },
        cpus: Array.from(incoming, ([name, bench], i) => ({
          id: i + 1,
          name,
          bench
        }))
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`[OK] mobile: ${incoming.size}`);
}

// ---------- main ----------
async function main() {
  ensureDir(OUTDIR);
  for (const t of PC_TARGETS) await updatePcTarget(t);
  await updateMobileMerged();
}

main();
