let TYPE = "pc_cpu";
let L = null, R = null;
let chartScore = null;

const $ = (id) => document.getElementById(id);

const FILES = {
  pc_cpu: "/data/pc_cpu.json",
  pc_gpu: "/data/pc_gpu.json",
  mobile: "/data/mobile.json"
};

const cache = new Map(); // type -> list(10y filtered)

function keyDate(x) { return new Date(x.released_at || x.first_seen_at); }
function withinYears(x, years) {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setFullYear(now.getFullYear() - years);
  return keyDate(x) >= cutoff;
}

async function loadList(type) {
  if (cache.has(type)) return cache.get(type);
  const res = await fetch(FILES[type], { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${FILES[type]} (${res.status})`);
  const raw = await res.json();
  const list = (raw.cpus ?? []).filter(x => withinYears(x, 10));
  cache.set(type, list);
  return list;
}

function getMode() {
  return $("modeSel").value; // simple | detail
}
function getVendor() {
  return $("vendorSel").value;
}
function getFamily() {
  return $("familySel").value;
}

function displayLine(item) {
  const mode = getMode();
  const short = item.short_name || item.name;
  const vendor = item.vendor || "Other/Unknown";
  const family = item.family || "Other/Unknown";

  if (mode === "detail") {
    return `${short}  —  ${item.name}\n[${vendor} / ${family}]`;
  }
  return `${short}\n[${vendor} / ${family}]`;
}

function setType(t) {
  TYPE = t;
  L = null; R = null;

  $("lp").textContent = "未選択";
  $("rp").textContent = "未選択";
  $("lr").innerHTML = "";
  $("rr").innerHTML = "";
  $("lq").value = "";
  $("rq").value = "";
  $("out").innerHTML = "";
  $("go").disabled = true;

  if (chartScore) chartScore.destroy();
  chartScore = null;

  cache.clear();
  refreshFilters().catch(console.error);
}

function uniqSorted(arr) {
  return Array.from(new Set(arr)).filter(Boolean).sort((a,b)=>a.localeCompare(b));
}

async function refreshFilters() {
  const list = await loadList(TYPE);

  // vendor options
  const vendors = uniqSorted(list.map(x => x.vendor || "Other/Unknown"));
  const vendorSel = $("vendorSel");
  const keepVendor = vendorSel.value;
  vendorSel.innerHTML = `<option value="">（すべて）</option>` + vendors.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  if (vendors.includes(keepVendor)) vendorSel.value = keepVendor;

  // family options depend on vendor selection
  refreshFamilyOptions(list);
}

function refreshFamilyOptions(list) {
  const v = getVendor();
  const filtered = v ? list.filter(x => (x.vendor || "Other/Unknown") === v) : list;

  const families = uniqSorted(filtered.map(x => x.family || "Other/Unknown"));
  const familySel = $("familySel");
  const keepFamily = familySel.value;
  familySel.innerHTML = `<option value="">（すべて）</option>` + families.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");
  if (families.includes(keepFamily)) familySel.value = keepFamily;
}

function applyFilter(list) {
  const v = getVendor();
  const f = getFamily();
  return list.filter(x => {
    const xv = x.vendor || "Other/Unknown";
    const xf = x.family || "Other/Unknown";
    if (v && xv !== v) return false;
    if (f && xf !== f) return false;
    return true;
  });
}

async function search(side) {
  const q = $(side + "q").value.trim().toLowerCase();
  if (q.length < 2) { $(side + "r").innerHTML = ""; return; }

  const list0 = await loadList(TYPE);
  const list = applyFilter(list0);

  // 名前・短縮名の両方で検索
  const rows = list
    .filter(x => (x.name || "").toLowerCase().includes(q) || (x.short_name || "").toLowerCase().includes(q))
    .slice(0, 50);

  const root = $(side + "r");
  root.innerHTML = "";
  rows.forEach(item => {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = displayLine(item);
    div.onclick = () => pick(side, item);
    root.appendChild(div);
  });
}

function pick(side, item) {
  if (side === "l") L = item; else R = item;
  $(side + "p").textContent = `${item.short_name || item.name} [${item.id}]`;
  $(side + "r").innerHTML = "";
  $("go").disabled = !(L && R && L.id !== R.id);
}

function safeNum(v) {
  return (typeof v === "number" && Number.isFinite(v)) ? v : null;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function compare() {
  const list0 = await loadList(TYPE);
  // 比較対象はフィルタ後に限定しない（選んだ2つは必ず比較）
  const a = list0.find(x => x.id === L.id);
  const b = list0.find(x => x.id === R.id);
  if (!a || !b) { $("out").textContent = "Not found"; return; }

  const suites = Array.from(new Set([
    ...Object.keys(a.bench || {}),
    ...Object.keys(b.bench || {})
  ])).sort();

  // 表（スコアのみ）
  let html = `<div class="head"><div><strong>左</strong>: ${escapeHtml(a.short_name || a.name)}</div><div><strong>右</strong>: ${escapeHtml(b.short_name || b.name)}</div></div>`;
  html += `<table style="width:100%;border-collapse:collapse;margin-top:10px">
    <tr>
      <th style="text-align:left;padding:10px;border-bottom:1px solid #eef">Suite</th>
      <th style="text-align:left;padding:10px;border-bottom:1px solid #eef">左</th>
      <th style="text-align:left;padding:10px;border-bottom:1px solid #eef">右</th>
    </tr>`;

  for (const s of suites) {
    const as = safeNum(a.bench?.[s]);
    const bs = safeNum(b.bench?.[s]);
    html += `<tr>
      <td style="padding:10px;border-bottom:1px solid #eef">${escapeHtml(s)}</td>
      <td style="padding:10px;border-bottom:1px solid #eef">${as ?? "-"}</td>
      <td style="padding:10px;border-bottom:1px solid #eef">${bs ?? "-"}</td>
    </tr>`;
  }
  html += `</table>`;
  $("out").innerHTML = html;

  // 横棒グラフ（高い方=青 / 低い方=赤）
  const BLUE = "#1976d2";
  const RED  = "#d32f2f";

  const aData = suites.map(s => safeNum(a.bench?.[s]));
  const bData = suites.map(s => safeNum(b.bench?.[s]));

  const aColors = suites.map((_, i) => {
    const av = aData[i], bv = bData[i];
    if (av === null || bv === null) return BLUE;
    return (av >= bv) ? BLUE : RED;
  });
  const bColors = suites.map((_, i) => {
    const av = aData[i], bv = bData[i];
    if (av === null || bv === null) return BLUE;
    return (bv >= av) ? BLUE : RED;
  });

  if (chartScore) chartScore.destroy();

  const rows = Math.max(6, suites.length);
  const canvas = $("chartScore");
  canvas.height = Math.min(520, 40 + rows * 18);

  chartScore = new Chart(canvas, {
    type: "bar",
    data: {
      labels: suites,
      datasets: [
        { label: "左", data: aData, backgroundColor: aColors, barThickness: 10 },
        { label: "右", data: bData, backgroundColor: bColors, barThickness: 10 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: { legend: { position: "bottom" } },
      scales: {
        x: { beginAtZero: true },
        y: { ticks: { autoSkip: false } }
      }
    }
  });
}

function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

$("lq").addEventListener("input", debounce(() => search("l"), 200));
$("rq").addEventListener("input", debounce(() => search("r"), 200));
$("go").addEventListener("click", compare);

$("vendorSel").addEventListener("change", async () => {
  const list = await loadList(TYPE);
  refreshFamilyOptions(list);
  $("lr").innerHTML = ""; $("rr").innerHTML = "";
});
$("familySel").addEventListener("change", () => {
  $("lr").innerHTML = ""; $("rr").innerHTML = "";
});
$("modeSel").addEventListener("change", () => {
  $("lr").innerHTML = ""; $("rr").innerHTML = "";
});

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    setType(btn.dataset.type);
  });
});

// 初期ロード
refreshFilters().catch(console.error);
