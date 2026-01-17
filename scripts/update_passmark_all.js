import fs from "fs";
import path from "path";
import cheerio from "cheerio";

const OUTDIR = path.join("public", "data");

const PC_TARGETS = [
  {
    key: "pc_cpu",
    url: "https://www.cpubenchmark.net/cpu_list.php",
    out: path.join(OUTDIR, "pc_cpu.json"),
    nameNeedle: "CPU Name",
    scoreNeedle: "CPU Mark",
    suite: "passmark_cpu"
  },
  {
    key: "pc_gpu",
    url: "https://www.videocardbenchmark.net/gpu_list.php",
    out: path.join(OUTDIR, "pc_gpu.json"),
    nameNeedle: "Videocard Name",
    scoreNeedle: "G3D Mark",
    suite: "passmark_g3d"
  }
];

const MOBILE_SOURCES = [
  { key: "android", url: "https://www.androidbenchmark.net/cpumark_chart.html", suite: "passmark_mobile_cpu" },
  { key: "ios", url: "https://www.iphonebenchmark.net/cpumark_chart.html", suite: "passmark_mobile_cpu" }
];

const MOBILE_OUT = path.join(OUTDIR, "mobile.json");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function loadExisting(outFile) {
  if (!fs.existsSync(outFile)) return { cpus: [] };
  try { return JSON.parse(fs.readFileSync(outFile, "utf-8")); }
  catch { return { cpus: [] }; }
}

function parseLastUpdated(bodyText) {
  const m = bodyText.match(/Last updated on the\s+(\d{1,2})(?:st|nd|rd|th)\s+of\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = m[2].toLowerCase();
  const year = Number(m[3]);
  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  const month = months[mon];
  if (!month) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": "cpucompare/1.0 (internal)" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}

function pickTableByHeaders($, mustA, mustB) {
  const tables = $("table").toArray();
  for (const t of tables) {
    const headers = $(t).find("tr").first().find("th")
      .map((_, th) => $(th).text().trim()).get().join(" | ");
    if (headers.includes(mustA) && headers.includes(mustB)) return t;
  }
  return null;
}

function parseTableList($, table, nameNeedle, scoreNeedle) {
  if (!table) throw new Error("Expected table not found (HTML may have changed)");

  const headerCells = $(table).find("tr").first().find("th").toArray();
  const headers = headerCells.map(h => $(h).text().trim());
  const nameIdx = headers.findIndex(h => h.includes(nameNeedle));
  const scoreIdx = headers.findIndex(h => h.includes(scoreNeedle));
  if (nameIdx < 0 || scoreIdx < 0) throw new Error("Expected headers not found");

  const items = new Map();
  $(table).find("tr").slice(1).each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length <= Math.max(nameIdx, scoreIdx)) return;
    const name = $(tds[nameIdx]).text().trim().replace(/\s+/g, " ");
    const scoreStr = $(tds[scoreIdx]).text().trim().replace(/,/g, "");
    const score = Number(scoreStr);
    if (name && Number.isFinite(score)) items.set(name, score);
  });
  return items;
}

function parseBulletsChart($) {
  const items = new Map();
  $("a").each((_, a) => {
    const aText = $(a).text().trim();
    if (!aText) return;

    const parentText = $(a).parent().text().replace(/\s+/g, " ").trim();
    const m = parentText.match(/(\d[\d,]*)\s*$/);
    if (!m) return;

    const score = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(score)) return;

    const name = aText.replace(/\(\d+%\)\s*$/g, "").trim();
    if (!name) return;

    items.set(name, score);
  });
  return items;
}

function mergeUpsert(existingList, incomingNameToBenchObj) {
  const oldByName = new Map(existingList.map(x => [x.name, x]));
  let nextId = existingList.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  const today = todayISO();

  const merged = [];
  for (const [name, benchObj] of incomingNameToBenchObj.entries()) {
    const old = oldByName.get(name);
    merged.push({
      id: old?.id ?? nextId++,
      name,
      vendor: old?.vendor ?? null,
      first_seen_at: old?.first_seen_at ?? today,
      released_at: old?.released_at ?? null,
      bench: { ...(old?.bench ?? {}), ...(benchObj ?? {}) }
    });
  }
  return merged;
}

async function updatePcTarget(t) {
  const existing = loadExisting(t.out);
  const html = await fetchHtml(t.url);
  const $ = cheerio.load(html);

  const table = pickTableByHeaders($, t.nameNeedle, t.scoreNeedle);
  const nameToScore = parseTableList($, table, t.nameNeedle, t.scoreNeedle);

  const incoming = new Map();
  for (const [name, score] of nameToScore.entries()) {
    incoming.set(name, { [t.suite]: score });
  }

  const lastUpdated = parseLastUpdated($("body").text());
  const cpus = mergeUpsert(existing.cpus ?? [], incoming);

  fs.writeFileSync(
    t.out,
    JSON.stringify({ meta: { key: t.key, source: t.url, fetched_at: todayISO(), passmark_last_updated: lastUpdated }, cpus }, null, 2),
    "utf-8"
  );
  console.log(`[OK] ${t.key}: ${cpus.length} -> ${t.out}`);
}

async function updateMobileMerged() {
  const existing = loadExisting(MOBILE_OUT);
  const incoming = new Map();

  const meta = { key: "mobile", sources: [], fetched_at: todayISO(), passmark_last_updated: {} };

  for (const s of MOBILE_SOURCES) {
    const html = await fetchHtml(s.url);
    const $ = cheerio.load(html);

    const nameToScore = parseBulletsChart($);
    for (const [name, score] of nameToScore.entries()) {
      const cur = incoming.get(name) ?? {};
      cur[s.suite] = score; // Android+iOS統合（同じ軸として扱う）
      incoming.set(name, cur);
    }

    meta.sources.push({ key: s.key, url: s.url });
    meta.passmark_last_updated[s.key] = parseLastUpdated($("body").text());
  }

  const cpus = mergeUpsert(existing.cpus ?? [], incoming);
  fs.writeFileSync(MOBILE_OUT, JSON.stringify({ meta, cpus }, null, 2), "utf-8");
  console.log(`[OK] mobile: ${cpus.length} -> ${MOBILE_OUT}`);
}

async function main() {
  ensureDir(OUTDIR);
  for (const t of PC_TARGETS) await updatePcTarget(t);
  await updateMobileMerged();
}

main().catch(e => { console.error(e); process.exit(1); });
