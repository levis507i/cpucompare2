import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";

const OUTDIR = path.join("public", "data");

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

const MOBILE_SOURCES = [
  { key: "android", url: "https://www.androidbenchmark.net/cpumark_chart.html", suite: "passmark_mobile_cpu", itemType: "mobile" },
  { key: "ios", url: "https://www.iphonebenchmark.net/cpumark_chart.html", suite: "passmark_mobile_cpu", itemType: "mobile" }
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

/**
 * ベンダー推定（漏れなく: 判別不能は Unknown）
 * PC CPUに Snapdragon 等が混ざっても Qualcomm として拾う。
 */
function inferVendor(name, itemType) {
  const n = name.toLowerCase();

  // GPU優先
  if (itemType === "pc_gpu") {
    if (n.includes("nvidia") || n.includes("geforce") || n.includes("quadro") || n.includes("rtx") || n.includes("gtx"))
      return "NVIDIA";
    if (n.includes("radeon") || n.includes("rx ") || n.includes("ryzen") || n.includes("firepro") || n.includes("firegl"))
      return "AMD";
    if (n.includes("intel") || n.includes("arc") || n.includes("iris") || n.includes("uhd graphics"))
      return "Intel";
    if (n.includes("apple") || n.includes("m1") || n.includes("m2") || n.includes("m3") || n.includes("m4"))
      return "Apple";
    return "Other/Unknown";
  }

  // CPU / SoC
  if (n.includes("intel") || n.includes("core i") || n.includes("xeon") || n.includes("pentium") || n.includes("celeron") || n.includes("atom"))
    return "Intel";
  if (n.includes("amd") || n.includes("ryzen") || n.includes("threadripper") || n.includes("epyc") || n.includes("athlon"))
    return "AMD";
  if (n.includes("apple") || /\bm[1-9]\b/.test(n) || n.includes("a1") || n.includes("bionic"))
    return "Apple";
  if (n.includes("snapdragon") || n.includes("qualcomm") || n.includes("8cx") || n.includes("x elite") || n.includes("x plus"))
    return "Qualcomm";
  if (n.includes("mediatek") || n.includes("dimensity") || n.includes("helio"))
    return "MediaTek";
  if (n.includes("samsung") || n.includes("exynos"))
    return "Samsung";
  if (n.includes("kirin") || n.includes("huawei") || n.includes("hisilicon"))
    return "HiSilicon";
  if (n.includes("unisoc") || n.includes("spreadtrum") || n.includes("tiger t"))
    return "UNISOC";
  if (n.includes("rockchip"))
    return "Rockchip";
  if (n.includes("nvidia") || n.includes("tegra"))
    return "NVIDIA";

  return "Other/Unknown";
}

/**
 * シリーズ（family）推定：絞り込み用（漏れなく: Unknown）
 */
function inferFamily(name, vendor, itemType) {
  const n = name;

  if (itemType === "pc_gpu") {
    const low = n.toLowerCase();
    if (low.includes("geforce")) return "GeForce";
    if (low.includes("rtx")) return "GeForce RTX";
    if (low.includes("gtx")) return "GeForce GTX";
    if (low.includes("quadro")) return "Quadro";
    if (low.includes("arc")) return "Intel Arc";
    if (low.includes("radeon")) return "Radeon";
    return "GPU (Other)";
  }

  // CPU/SoC
  if (vendor === "Intel") {
    if (/core i[3579]/i.test(n)) return "Core i";
    if (/core ultra/i.test(n)) return "Core Ultra";
    if (/xeon/i.test(n)) return "Xeon";
    if (/pentium/i.test(n)) return "Pentium";
    if (/celeron/i.test(n)) return "Celeron";
    if (/atom/i.test(n)) return "Atom";
    return "Intel (Other)";
  }
  if (vendor === "AMD") {
    if (/ryzen\s+9/i.test(n)) return "Ryzen 9";
    if (/ryzen\s+7/i.test(n)) return "Ryzen 7";
    if (/ryzen\s+5/i.test(n)) return "Ryzen 5";
    if (/ryzen\s+3/i.test(n)) return "Ryzen 3";
    if (/threadripper/i.test(n)) return "Threadripper";
    if (/epyc/i.test(n)) return "EPYC";
    return "AMD (Other)";
  }
  if (vendor === "Apple") {
    if (/\bm[1-9]\b/i.test(n) || /\bm[1-9]\s*(pro|max|ultra)?\b/i.test(n)) return "Apple M";
    if (/\ba\d{1,2}\b/i.test(n) || /bionic/i.test(n)) return "Apple A";
    return "Apple (Other)";
  }
  if (vendor === "Qualcomm") {
    if (/snapdragon\s*8/i.test(n)) return "Snapdragon 8";
    if (/snapdragon\s*7/i.test(n)) return "Snapdragon 7";
    if (/snapdragon\s*6/i.test(n)) return "Snapdragon 6";
    if (/8cx/i.test(n)) return "Snapdragon 8cx";
    if (/x elite/i.test(n) || /x plus/i.test(n)) return "Snapdragon X";
    return "Qualcomm (Other)";
  }
  if (vendor === "MediaTek") {
    if (/dimensity/i.test(n)) return "Dimensity";
    if (/helio/i.test(n)) return "Helio";
    return "MediaTek (Other)";
  }
  if (vendor === "Samsung") {
    if (/exynos/i.test(n)) return "Exynos";
    return "Samsung (Other)";
  }
  if (vendor === "HiSilicon") return "Kirin";
  if (vendor === "UNISOC") return "UNISOC";

  return "Other/Unknown";
}

/**
 * 短縮名（short_name）：スマホでも見やすい表示名
 */
function makeShortName(name, vendor, family, itemType) {
  let s = name.replace(/\s+/g, " ").trim();

  // 共通：余計な語尾
  s = s.replace(/\bprocessor\b/ig, "").replace(/\bcpu\b/ig, "").replace(/\bapu\b/ig, "").trim();

  if (itemType === "pc_cpu") {
    // Intel: "Intel Core i7-12700K" → "Core i7-12700K"
    if (vendor === "Intel") {
      s = s.replace(/^intel\s+/i, "");
      s = s.replace(/^intel®\s*/i, "");
    }
    // AMD: "AMD Ryzen 7 5800X" → "Ryzen 7 5800X"
    if (vendor === "AMD") {
      s = s.replace(/^amd\s+/i, "");
    }
  }

  if (itemType === "mobile") {
    // Apple: "Apple A16 Bionic" → "A16"
    if (vendor === "Apple") {
      const m = s.match(/\b(a\d{1,2})\b/i);
      if (m) return m[1].toUpperCase();
      const mm = s.match(/\b(m\d)\b/i);
      if (mm) return mm[1].toUpperCase();
    }
    // Snapdragon: "Qualcomm Snapdragon 8 Gen 2" → "Snapdragon 8 Gen 2"
    if (vendor === "Qualcomm") {
      s = s.replace(/^qualcomm\s+/i, "");
    }
  }

  if (itemType === "pc_gpu") {
    // "NVIDIA GeForce RTX 4070" → "RTX 4070" / "GeForce RTX 4070"のままでもOK
    if (vendor === "NVIDIA") {
      s = s.replace(/^nvidia\s+/i, "");
      s = s.replace(/^geforce\s+/i, "GeForce ");
    }
    if (vendor === "AMD") {
      s = s.replace(/^amd\s+/i, "");
    }
  }

  // 先頭にfamilyを強制しない。短く保つ
  return s.trim();
}

function normalizeItem(old, name, itemType) {
  const vendor = old?.vendor ?? inferVendor(name, itemType);
  const family = old?.family ?? inferFamily(name, vendor, itemType);
  const short_name = old?.short_name ?? makeShortName(name, vendor, family, itemType);

  return { vendor, family, short_name };
}

function mergeUpsert(existingList, incomingNameToBenchObj, itemType) {
  const oldByName = new Map(existingList.map(x => [x.name, x]));
  let nextId = existingList.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  const today = todayISO();

  const merged = [];
  for (const [name, benchObj] of incomingNameToBenchObj.entries()) {
    const old = oldByName.get(name);

    const norm = normalizeItem(old, name, itemType);

    merged.push({
      id: old?.id ?? nextId++,
      name,
      short_name: norm.short_name,
      vendor: norm.vendor,
      family: norm.family,
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
  const cpus = mergeUpsert(existing.cpus ?? [], incoming, t.itemType);

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
      cur[s.suite] = score;
      incoming.set(name, cur);
    }
    meta.sources.push({ key: s.key, url: s.url });
    meta.passmark_last_updated[s.key] = parseLastUpdated($("body").text());
  }

  const cpus = mergeUpsert(existing.cpus ?? [], incoming, "mobile");
  fs.writeFileSync(MOBILE_OUT, JSON.stringify({ meta, cpus }, null, 2), "utf-8");
  console.log(`[OK] mobile: ${cpus.length} -> ${MOBILE_OUT}`);
}

async function main() {
  ensureDir(OUTDIR);
  for (const t of PC_TARGETS) await updatePcTarget(t);
  await updateMobileMerged();
}

main().catch(e => { console.error(e); process.exit(1); });

