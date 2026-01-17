let TYPE = "pc_cpu";
let L = null, R = null;

let chartScore = null;
let chartDiff = null;
let chartRank = null;

const $ = (id) => document.getElementById(id);

const FILES = {
  pc_cpu: "/data/pc_cpu.json",
  pc_gpu: "/data/pc_gpu.json",
  mobile: "/data/mobile.json"
};

const cache = new Map(); // type -> cpus[]

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

  [chartScore, chartDiff, chartRank].forEach(ch => ch && ch.destroy());
  chartScore = chartDiff = chartRank = null;

  cache.clear(); // data更新の反映
}

async function search(side) {
  const q = $(side + "q").value.trim().toLowerCase();
  if (q.length < 2) { $(side + "r").innerHTML = ""; return; }

  const list = await loadList(TYPE);
  const rows = list
    .filter(x => x.name.toLowerCase().includes(q))
    .slice(0, 50)
    .map(({ id, name, vendor }) => ({ id, name, vendor }));

  const root = $(side + "r");
  root.innerHTML = "";
  rows.forEach(cpu => {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = `${cpu.name}${cpu.vendor ? " (" + cpu.vendor + ")" : ""}`;
    div.onclick = () => pick(side, cpu);
    root.appendChild(div);
  });
}

function pick(side, cpu) {
  if (side === "l") L = cpu; else R = cpu;
  $(side + "p").textContent = `${cpu.name} [${cpu.id}]`;
  $(side + "r").innerHTML = "";
  $("go").disabled = !(L && R && L.id !== R.id);
}

function fmtPct(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(1)}%`;
}

async function compare() {
  const list = await loadList(TYPE);
  const a = list.find(x => x.id === L.id);
  const b = list.find(x => x.id === R.id);
  if (!a || !b) { $("out").textContent = "Not found"; return; }

  const suites = Array.from(new Set([
    ...Object.keys(a.bench || {}),
    ...Object.keys(b.bench || {})
  ])).sort();

  // ranks（母集団＝10年以内）
  const rankMap = {};
  for (const s of suites) {
    const scored = list
      .map(x => ({ id: x.id, score: x.bench?.[s] ?? null }))
      .filter(x => typeof x.score === "number" && Number.isFinite(x.score))
      .sort((p, q) => q.score - p.score);
    const m = {};
    scored.forEach((x, i) => { m[x.id] = i + 1; });
    rankMap[s] = m;
  }

  const diffPct = {};
  for (const s of suites) {
    const as = a.bench?.[s];
    const bs = b.bench?.[s];
    diffPct[s] = (typeof as === "number" && typeof bs === "number" && as !== 0)
      ? ((bs - as) / as) * 100
      : null;
  }

  const ranksA = Object.fromEntries(suites.map(s => [s, rankMap[s]?.[a.id] ?? null]));
  const ranksB = Object.fromEntries(suites.map(s => [s, rankMap[s]?.[b.id] ?? null]));

  // 表
  let html = `<div class="head"><div><strong>左</strong>: ${a.name}</div><div><strong>右</strong>: ${b.name}</div></div>`;
  html += `<table>
    <tr>
      <th>Suite</th>
      <th>左スコア</th><th>左順位</th>
      <th>右スコア</th><th>右順位</th>
      <th>差分％（右-左）/左</th>
    </tr>`;
  suites.forEach(s => {
    const as = a.bench?.[s] ?? null;
    const bs = b.bench?.[s] ?? null;
    html += `<tr>
      <td>${s}</td>
      <td>${as ?? "-"}</td><td>${ranksA[s] ?? "-"}</td>
      <td>${bs ?? "-"}</td><td>${ranksB[s] ?? "-"}</td>
      <td>${fmtPct(diffPct[s])}</td>
    </tr>`;
  });
  html += `</table>`;
  $("out").innerHTML = html;

  // グラフ：スコア
  if (chartScore) chartScore.destroy();
  chartScore = new Chart($("chartScore"), {
    type: "bar",
    data: {
      labels: suites,
      datasets: [
        { label: "左スコア", data: suites.map(s => a.bench?.[s] ?? null) },
        { label: "右スコア", data: suites.map(s => b.bench?.[s] ?? null) }
      ]
    },
    options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true } } }
  });

  // グラフ：差分％
  if (chartDiff) chartDiff.destroy();
  chartDiff = new Chart($("chartDiff"), {
    type: "bar",
    data: { labels: suites, datasets: [{ label: "差分％", data: suites.map(s => diffPct[s] ?? null) }] },
    options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true, ticks: { callback: v => `${v}%` } } } }
  });

  // グラフ：順位（1位が上）
  if (chartRank) chartRank.destroy();
  chartRank = new Chart($("chartRank"), {
    type: "bar",
    data: {
      labels: suites,
      datasets: [
        { label: "左順位", data: suites.map(s => ranksA[s] ?? null) },
        { label: "右順位", data: suites.map(s => ranksB[s] ?? null) }
      ]
    },
    options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true, reverse: true, ticks: { callback: v => `#${v}` } } } }
  });
}

function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

$("lq").addEventListener("input", debounce(() => search("l"), 200));
$("rq").addEventListener("input", debounce(() => search("r"), 200));
$("go").addEventListener("click", compare);

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    setType(btn.dataset.type);
  });
});
