// scripts/update_passmark_all.js
// PassMark から PC CPU / PC GPU / Mobile CPU を取得して public/data/*.json を生成
// PC CPU/GPU は download=1 の CSV を優先（HTML構造変更の影響を受けにくい）
// Mobile は既存のチャートページ（HTML）をパース

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

// Mobile: Android+iOSを同じタブで扱う（統合）
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
  try {
    return JSON.parse(fs.readFileSync(outFile, "utf-8"));
  } catch {
    return { cpus: [] };
  }
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

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "cpucompare/1.0 (internal)" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}

/**
 * シンプルCSVパーサ（PassMarkのdownload=1で十分な形式を想定）
 * - ダブルクォート内のカンマは保護
 * - "" のエスケープは最低限対応
 */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const rows = [];

  for (const line of lines) {
    const cols = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        // "" → " を扱う
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

    rows.push(cols.map(c => c.trim()));
  }

  // 外側のクォート除去
  return rows.map(r => r.map(c => c.replace(/^"(.*)"$/s, "$1").trim()));
}

// ---- HTML fallback utilities (万一CSVが取れない場合) ----
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

// Mobile chart parse
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
 * ベンダー推定（漏れなく：不明は Other/Unknown）
 * PC CPUに Snapdragon 等が混ざっても Qualcomm として拾う。
 */
function inferVendor(name, itemType) {
  const n = name.toLowerCase();

  // GPU
  if (itemType === "pc_gpu") {
    if (n.includes("nvidia") || n.includes("geforce") || n.includes("quadro") || n.includes("rtx") || n.includes("gtx"))
      return "NVIDIA";
    if (n.includes("radeon") || n.includes("rx ") || n.includes("firepro") || n.includes("firegl"))
      return "AMD";
    if (n.includes("intel") || n.includes("arc") || n.includes("iris") || n.includes("uhd graphics"))
      return "Intel";
    if (n.includes("apple") || n.includes("m1") || n.includes("m2") || n.includes("m3") || n.includes("m4"))
      return "Apple";
    return "Other/Unknown";
  }

  // CPU/SoC
  if (n.includes("intel") || n.includes("core i") || n.includes("xeon") || n.includes("pentium") || n.includes("celeron") || n.includes("atom") || n.includes("core ultra"))
    return "Intel";
  if (n.includes("amd") || n.includes("ryzen") || n.includes("threadripper") || n.includes("epyc") || n.includes("athlon"))
    return "AMD";
  if (n.includes("apple") || /\bm[1-9]\b/.test(n) || /\ba\d{1,2}\b/.test(n) || n.includes("bionic"))
    return "Apple";

  // Qualcomm / Snapdragon（PC含む）
  if (
    n.includes("snapdragon") ||
    n.includes("qualcomm") ||
    n.includes("8cx") ||
    n.includes("x elite") ||
    n.includes("x plus") ||
    /\bx1e-\d+/.test(n) ||
    /\bx1p-\d+/.test(n) ||
    n.includes("oryon") ||
    n.includes("microsoft sq")
  ) return "Qualcomm";

  if (n.includes("mediatek") || n.includes("dimensity") || n.includes("helio"))
    return "MediaTek";
  if (n.includes("samsung") || n.includes("exynos"))
    return "Samsung";
  if (n.includes("kirin") || n.includes("huawei") || n.includes("hisilicon"))
    return "HiSilicon";
  if (n.includes("unisoc") || n.includes("spreadtrum"))
    return "UNISOC";
  if (n.includes("rockchip"))
    return "Rockchip";
  if (n.includes("nvidia") || n.includes("tegra"))
    return "NVIDIA";

  return "Other/Unknown";
}

/**
 * シリーズ（family）推定：絞り込み用（漏れなく：Unknownに落とす）
 */
function inferFamily(name, vendor, itemType) {
  const n = name;

  if (itemType === "pc_gpu") {
    const low = n.toLowerCase();
    if (low.includes("rtx")) return "GeForce RTX";
    if (low.includes("gtx")) return "GeForce GTX";
    if (low.includes("geforce")) return "GeForce";
    if (low.includes("quadro")) return "Quadro";
    if (low.includes("arc")) return "Intel Arc";
    if (low.includes("radeon")) return "Radeon";
    return "GPU (Other)";
  }

  if (vendor === "Intel") {
    if (/core ultra/i.test(n)) return "Core Ultra";
    if (/core i[3579]/i.test(n)) return "Core i";
    if (/xeon/i.test(n)) return "Xeon";
    if (/pentium/i.test(n)) return "Pentium";
    if (/celeron/i.test(n)) return "Celeron";
    if (/atom/i.test(n)) return "Atom";
    return "Intel (Other)";
  }

  if (vendor === "AMD") {
    if (/ryzen\s*9/i.test(n)) return "Ryzen 9";
    if (/ryzen\s*7/i.test(n)) return "Ryzen 7";
    if (/ryzen\s*5/i.test(n)) return "Ryzen 5";
    if (/ryzen\s*3/i.test(n)) return "Ryzen 3";
    if (/ryzen/i.test(n)) return "Ryzen";
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
    if (/x elite/i.test(n) || /x plus/i.test(n) || /\bx1e-\d+/.test(n) || /\bx1p-\d+/.test(n)) return "Snapdragon X";
    if (/microsoft sq/i.test(n)) return "Surface SQ";
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
  s = s.replace(/\bprocessor\b/ig, "").replace(/\bcpu\b/ig, "").replace(/\bapu\b/ig, "").trim();

  if (itemType === "pc_cpu") {
    if (vendor === "Intel") {
      s = s.replace(/^intel\s+/i, "");
      s = s.replace(/^intel®\s*/i, "");
    }
    if (vendor === "AMD") {
      s = s.replace(/^amd\s+/i, "");
      // Ryzen表記が落ちないように保険
      if (/ryzen/i.test(name) && !/ryzen/i.test(s)) s = `Ryzen ${s}`;
    }
    if (vendor === "Qualcomm") {
      s = s.replace(/^qualcomm\s+/i, "");
    }
  }

  if (itemType === "mobile") {
    if (vendor === "Apple") {
      const mA = s.match(/\b(a\d{1,2})\b/i);
      if (mA) return mA[1].toUpperCase();
      const mM = s.match(/\b(m\d)\b/i);
      if (mM) return mM[1].toUpperCase();
    }
    if (vendor === "Qualcomm") {
      s = s.replace(/^qualcomm\s+/i, "");
    }
  }

  if (itemType === "pc_gpu") {
    if (vendor === "NVIDIA") {
      s = s.replace(/^nvidia\s+/i, "");
    }
    if (vendor === "AMD") {
      s = s.replace(/^amd\s+/i, "");
    }
  }

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

/**
 * PC CPU/GPU: download=1 のCSVを優先し、取れなければHTMLにフォールバック
 */
async function updatePcTarget(t) {
  const existing = loadExisting(t.out);
  const text = await fetchText(t.url);

  const incoming = new Map();

  const lower = text.toLowerCase();
  const looksCsv =
    (lower.includes("cpu mark") && t.itemType === "pc_cpu") ||
    (lower.includes("g3d mark") && t.itemType === "pc_gpu");

  if (looksCsv) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error(`CSV too short: ${t.url}`);

    const header = rows[0].map(h => h.toLowerCase());
    const nameIdx = header.findIndex(h => h.includes(t.nameNeedle.toLowerCase()));
    const scoreIdx = header.findIndex(h => h.includes(t.scoreNeedle.toLowerCase()));
    if (nameIdx < 0 || scoreIdx < 0) throw new Error(`CSV headers not found: ${t.url}`);

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[nameIdx] || "").replace(/\s+/g, " ").trim();
      const score = Number(String(r[scoreIdx] || "").replace(/,/g, "").trim());
      if (name && Number.isFinite(score)) incoming.set(name, { [t.suite]: score });
    }
  } else {
    // HTML fallback
    const $ = cheerio.load(text);
    const table = pickTableByHeaders($, t.nameNeedle, t.scoreNeedle);
    const nameToScore = parseTableList($, table, t.nameNeedle, t.scoreNeedle);
    for (const [name, score] of nameToScore.entries()) {
      incoming.set(name, { [t.suite]: score });
    }
  }

  const cpus = mergeUpsert(existing.cpus ?? [], incoming, t.itemType);

  fs.writeFileSync(
    t.out,
    JSON.stringify(
      {
        meta: { key: t.key, source: t.url, fetched_at: todayISO(), note: "CSV preferred (download=1)" },
        cpus
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`[OK] ${t.key}: ${cpus.length} -> ${t.out}`);
}

/**
 * Mobile: Android + iOS のチャートを統合
 */
async function updateMobileMerged() {
  const existing = loadExisting(MOBILE_OUT);
  const incoming = new Map();

  const meta = { key: "mobile", sources: [], fetched_at: todayISO(), passmark_last_updated: {} };

  for (const s of MOBILE_SOURCES) {
    const html = await fetchText(s.url);
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

main().catch(e => {
  console.error(e);
  process.exit(1);
});
