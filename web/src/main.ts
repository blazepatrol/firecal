import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";

type Num = number | null;
type Series = { cal: Num[]; modis: Num[]; npp: Num[]; n20: Num[]; vc?: Num[]; vt?: Num[] };
type Monthly = { months: string[]; source: (string | null)[]; coverage: Record<"terra" | "aqua" | "npp" | "n20", number[]>; blocks: Record<string, Series> };
type Block = { id: number; bounds: [number, number, number, number] };
type Val = {
  months: string[]; obs: number[]; pred: Record<string, number[]>; metrics: Record<string, Record<string, number>>;
  bootstrap_95: Record<string, [number, number]>; chosen: string; n_train_rows: number; years: number[];
  interval_annual_log1p_q10_q90?: [number, number];
};
type Validation = { terra_aqua: Val; terra_only: Val; continuity_snpp_noaa20: Record<string, any> };
type Row = { t: number; month: string; value: Num; source: string | null; type: "observed" | "estimated" | "none";
  lo: Num; hi: Num; median: Num; modis: Num; npp: Num; n20: Num; partial: boolean; clear: Num };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DATA = `${import.meta.env.BASE_URL}data/`;
const getJSON = (f: string) => fetch(DATA + f).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
const METHOD: Record<string, string> = { unadjusted: "Raw MODIS (no adjustment)", ratio: "Single overlap ratio", seasonal: "Seasonal regression", gbm: "FireCal model (boosted)" };
const C = { modis: "#2a78d6", npp: "#eb6834", n20: "#1baf7a", ink: "#14181d" };
const RED = ["#f6c3ba", "#f09b8e", "#e87263", "#d94c3f", "#bf3229", "#9a241f", "#721a17"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// round axis ticks (step 1, 2, 2.5 or 5 × a power of ten) from 0 up to at least max
const ticks = (max: number) => { const p = 10 ** Math.floor(Math.log10(max / 5)), step = [1, 2, 2.5, 5, 10].find((m) => m * p >= max / 5)! * p; return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step); };
const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
const mname = (m: string) => `${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
const dname = (d: string) => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const UNIT = "km²-days of detected fire";

const [meta, blocks, monthly, validation] = (await Promise.all([
  getJSON("meta.json"), getJSON("blocks.json"), getJSON("monthly.json"), getJSON("validation.json"),
])) as [any, Block[], Monthly, Validation];

const M = monthly.months, T = M.length;
const OBS_DAY = +meta.observations_through.slice(8), OBS_FRAC = OBS_DAY / new Date(+M[T - 1].slice(0, 4), +M[T - 1].slice(5), 0).getDate();
const allIds = () => new Set(blocks.map((b) => b.id));
let selected = allIds(), placeName: string = meta.region.short, placeSub: string = meta.region.name, placeKey = "all";
let from = M[0], to = M[T - 1];
let rows: Row[] = [];
let calView: "clock" | "grid" = "clock";
let storyMode: "raw" | "harm" = "raw";
const DECK = "deck" in document.body.dataset; // deck.html reuses these renderers without the map
const txt = (id: string, v: string) => { const e = document.getElementById(id); if (e) e.textContent = v; };

// ---------------- data ----------------
function sumSel(key: keyof Series): Num[] {
  const out: Num[] = new Array(T).fill(null);
  for (let t = 0; t < T; t++) {
    let s = 0, any = false, nul = false;
    for (const b of selected) { const v = monthly.blocks[b][key]?.[t] ?? null; if (v === null) nul = true; else { s += v; any = true; } }
    out[t] = nul || !any ? null : s;
  }
  return out;
}
function priorMedian(vals: Num[], t: number): Num {
  const mo = M[t].slice(5);
  const prior = vals.filter((v, i) => i < t && M[i].slice(5) === mo && v !== null) as number[];
  if (prior.length < 5) return null;
  prior.sort((a, b) => a - b);
  const h = prior.length >> 1;
  return prior.length % 2 ? prior[h] : (prior[h - 1] + prior[h]) / 2;
}
const refCov = (t: number) => (monthly.source[t]?.includes("NOAA-20") ? monthly.coverage.n20[t] : monthly.coverage.npp[t]);
function computeRows(): Row[] {
  const cal = sumSel("cal"), modis = sumSel("modis"), npp = sumSel("npp"), n20 = sumSel("n20"), vc = sumSel("vc"), vt = sumSel("vt");
  return M.map((month, t) => {
    const v = cal[t], src = monthly.source[t], est = !!src?.startsWith("Estimated");
    const [q10, q90] = src?.includes("Terra only") ? meta.interval_terra : meta.interval_full;
    return {
      t, month, value: v, source: src, type: v === null ? "none" : est ? "estimated" : "observed",
      lo: v !== null && est ? Math.max(0, Math.expm1(Math.log1p(v) + q10)) : null,
      hi: v !== null && est ? Math.expm1(Math.log1p(v) + q90) : null,
      median: priorMedian(cal, t), modis: modis[t], npp: npp[t], n20: n20[t],
      partial: t === T - 1 && OBS_FRAC < 1, clear: vc[t] !== null && vt[t] ? vc[t]! / vt[t]! : null,
    };
  });
}
const lastFull = () => (rows[T - 1].partial ? T - 2 : T - 1);
const LAST_YEAR = M[T - 1].slice(0, 4);
function annual(key: "value" | "modis" | "npp" | "n20") {
  const years = [...new Set(M.map((m) => m.slice(0, 4)))].filter((y) => y >= "2001");
  return {
    years,
    vals: years.map((y) => {
      const sel = rows.filter((r) => r.month.startsWith(y));
      const known = sel.filter((r) => r[key] !== null);
      if (!known.length || (known.length < sel.length && y !== LAST_YEAR)) return null;
      return known.reduce((a, r) => a + (r[key] as number), 0);
    }),
  };
}

// ---------------- tooltip ----------------
const tip = $("tip");
function showTip(html: string, ev: MouseEvent) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
const hideTip = () => (tip.hidden = true);
// Colour by rank: each shade holds an equal share of this area's non-zero months, so seasons stand out anywhere.
function scale(vals: Num[]) {
  const nz = (vals.filter((v) => v !== null && v > 0) as number[]).sort((a, b) => a - b);
  const q = RED.slice(1).map((_, i) => nz[Math.floor(((i + 1) / RED.length) * nz.length)] ?? Infinity);
  return (v: Num) => (v === null ? "url(#hatch)" : v === 0 ? "#ffffff" : RED[q.filter((x) => v > x).length]);
}
const HATCH = `<pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#eef0f2"/><line x1="0" y1="0" x2="0" y2="5" stroke="#c9ced5" stroke-width="1.6"/></pattern>`;

// ---------------- hero answer ----------------
function classify(v: number, med: number | null, month: string) {
  const mon = MONTH[+month.slice(5) - 1];
  if (med === null) return { mult: "–", word: "Not enough history", tone: "#7a8491", exp: `Fewer than five earlier ${mon}s to compare with.` };
  if (med === 0) return v === 0
    ? { mult: "0", word: "Normal", tone: "#0a7d0a", exp: `No burning detected, as usual for ${mon}.` }
    : { mult: "New", word: "Unusual", tone: "#d03b3b", exp: `${fmt(v)} ${UNIT}, in a month that usually has none.` };
  const r = v / med;
  const word = r >= 2 ? "Well above normal" : r >= 1.25 ? "Above normal" : r > 0.8 ? "Normal" : r > 0.5 ? "Below normal" : "Well below normal";
  const tone = r >= 2 ? "#d03b3b" : r >= 1.25 ? "#c2541f" : r > 0.8 ? "#0a7d0a" : "#1c5cab";
  return { mult: `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`, word, tone, exp: `${fmt(v)} ${UNIT}, vs a typical ${mon} of ${fmt(med)}.` };
}
function drawAnswer() {
  const tf = lastFull(), r = rows[tf], mon = MONTH[+r.month.slice(5) - 1];
  const head = `<div class="where">${placeName}</div><div class="q">${mon} ${r.month.slice(0, 4)}, compared with every ${mon} since 2001</div>`;
  if (r.value === null) { $("answer").innerHTML = head + `<p class="exp">No observation for this month.</p>`; return; }
  const c = classify(r.value, r.median, r.month);
  const same = rows.filter((x) => x.month.slice(5) === r.month.slice(5) && x.month >= "2001");
  const w = 440, h = 96, b = 16, max = Math.max(1, ...same.map((x) => x.value ?? 0), r.median ?? 0), bw = w / same.length;
  let svg = `<svg class="mini" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${mon} in every year since 2001">`;
  same.forEach((x, i) => {
    if (x.value === null) return;
    const bh = Math.max(x.value > 0 ? 2 : 0, (x.value / max) * (h - b - 6));
    svg += `<rect x="${i * bw + 1}" y="${h - b - bh}" width="${bw - 2}" height="${bh}" rx="2" fill="${x.t === tf ? c.tone : x.type === "estimated" ? "#d5d9de" : "#aeb5bd"}"><title>${x.month.slice(0, 4)}: ${fmt(x.value)}</title></rect>`;
  });
  if (r.median !== null) { const y = h - b - (r.median / max) * (h - b - 6); svg += `<line x1="0" x2="${w}" y1="${y}" y2="${y}" stroke="#14181d" stroke-dasharray="3 3" opacity=".55"/><text x="${w - 2}" y="${y - 4}" text-anchor="end">typical</text>`; }
  svg += `<text x="0" y="${h - 2}">${same[0].month.slice(0, 4)}</text><text x="${w}" y="${h - 2}" text-anchor="end">${same.at(-1)!.month.slice(0, 4)}</text></svg>`;
  const cur = rows[T - 1];
  let sofar = "";
  if (cur.partial && cur.value !== null && cur.median !== null)
    sofar = `<div class="sofar"><b>${MONTH[+cur.month.slice(5) - 1]} so far</b> (through ${dname(meta.observations_through)}): ${fmt(cur.value)}, vs ${fmt(cur.median * OBS_FRAC)} typical by this date.</div>`;
  $("answer").innerHTML = head + `<div class="verdict"><span class="mult" style="color:${c.tone}">${c.mult}</span><span class="word" style="color:${c.tone}">${c.word}</span></div><p class="exp">${c.exp}</p>${svg}${sofar}`;
}
function drawPlaces() {
  const presets: Record<string, number[]> = meta.region.presets;
  const items: [string, string][] = [["all", meta.region.short], ...Object.keys(presets).map((k) => [k, k.replace(/ \(.+\)/, "")] as [string, string])];
  $("places").innerHTML = items.map(([k, label]) => `<button data-k="${k}" aria-pressed="${placeKey === k}">${label}</button>`).join("");
  $("places").querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => choosePreset(b.dataset.k!)));
}

// ---------------- insights ----------------
function insightLines(): string[] {
  const full = rows.filter((r) => r.value !== null && r.month >= "2001" && !r.month.startsWith(LAST_YEAR));
  if (!full.length) return [];
  const out: string[] = [];
  const mean = MON.map((_, i) => { const xs = full.filter((r) => +r.month.slice(5) === i + 1).map((r) => r.value!); return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); });
  const order = mean.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 12 - Math.abs(a - b));
  const p = order[0], q = order.find((i) => dist(i, p) === 1 && mean[i] > 0.6 * mean[p]);
  const pair = q === undefined ? MONTH[p] : (p + 1) % 12 === q ? `${MONTH[p]}–${MONTH[q]}` : `${MONTH[q]}–${MONTH[p]}`;
  const second = order.find((i) => dist(i, p) >= 3 && mean[i] > 0.45 * mean[p]);
  out.push(`🔥|Burning usually peaks in <b>${pair}</b>${second !== undefined ? `, with a second season around <b>${MONTH[second]}</b>` : ""}.`);
  const yrs = annual("value");
  const complete = yrs.years.map((y, i) => [y, yrs.vals[i]] as [string, Num]).filter(([y, v]) => v !== null && y !== LAST_YEAR) as [string, number][];
  if (complete.length) {
    const avg = complete.reduce((a, [, v]) => a + v, 0) / complete.length;
    const [by, bv] = complete.reduce((a, x) => (x[1] > a[1] ? x : a));
    out.push(`📅|<b>${by}</b> was the most active year on record: <b>${(bv / avg).toFixed(1)}×</b> an average year${by < "2012" ? ", rebuilt from the older MODIS sensor" : ""}.`);
    const recent = complete.filter(([y]) => +y >= +LAST_YEAR - 5), early = complete.filter(([y]) => y <= "2010");
    if (recent.length && early.length) {
      const ra = recent.reduce((a, [, v]) => a + v, 0) / recent.length, ea = early.reduce((a, [, v]) => a + v, 0) / early.length;
      const d = (ra / Math.max(ea, 1e-9) - 1) * 100;
      out.push(`📈|The last five years saw <b>${Math.abs(d).toFixed(0)}% ${d >= 0 ? "more" : "less"}</b> burning than 2001–2010. A fair comparison only because both eras are on one scale.`);
    }
  }
  out.push(`🌧️|<b>${MONTH[order.at(-1)!]}</b> is usually the quietest month.`);
  return out;
}
const drawInsights = () => ($("insights").innerHTML = insightLines().map((l) => { const [ic, txt] = l.split("|"); return `<li><span class="ic">${ic}</span><span>${txt}</span></li>`; }).join(""));

// ---------------- fire clock + grid ----------------
function detailHtml(r: Row): string {
  const pill = r.type === "estimated" ? `<span class="pill est">Rebuilt from MODIS</span>` : r.type === "observed" ? `<span class="pill obs">Seen by ${r.source?.replace(" observed", "")}</span>` : `<span class="pill none">No observation</span>`;
  let h = `<div><b>${MONTH[+r.month.slice(5) - 1]} ${r.month.slice(0, 4)}</b>${pill}</div>`;
  if (r.value === null) return h + `<div class="note">No satellite record for this month. That's different from "no fire".</div>`;
  h += `<div><span class="big">${fmt(r.value)}</span> ${UNIT}</div>`;
  if (r.lo !== null) h += `<div class="note">Likely range ${fmt(r.lo)} to ${fmt(r.hi!)}</div>`;
  if (r.median !== null) { const c = classify(r.value, r.median, r.month); h += `<div style="color:${c.tone};font-weight:600;margin-top:4px">${c.word}${r.median > 0 ? ` · ${c.mult} a typical ${MONTH[+r.month.slice(5) - 1]}` : ""}</div>`; }
  if (r.partial) h += `<div class="note">Month in progress, through ${dname(meta.observations_through)}.</div>`;
  return h;
}
const tipHtml = (r: Row) => `<b>${mname(r.month)}</b><br/>${r.value === null ? "No observation" : `${fmt(r.value)} <span class="m">${UNIT}</span>`}${r.type === "estimated" ? `<br/><span class="m">rebuilt from MODIS</span>` : ""}`;
function bindCells(root: HTMLElement) {
  root.querySelectorAll<SVGElement>(".cell").forEach((el) => {
    const r = rows[+el.dataset.t!];
    el.addEventListener("mousemove", (ev) => { showTip(tipHtml(r), ev as MouseEvent); $("detail").innerHTML = detailHtml(r); });
    el.addEventListener("mouseleave", hideTip);
    el.addEventListener("focus", () => ($("detail").innerHTML = detailHtml(r)));
  });
}
function drawClock() {
  const years = [...new Set(M.map((m) => m.slice(0, 4)))].filter((y) => y >= "2001");
  const vis = rows.filter((r) => r.month >= "2001");
  const color = scale(vis.map((r) => r.value));
  const S = 640, cx = S / 2, cy = S / 2, r0 = 78, r1 = 268, gapDeg = 26;
  const ring = (r1 - r0) / years.length, mdeg = (360 - gapDeg) / 12;
  const pt = (r: number, deg: number) => { const a = ((deg - 90) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const arc = (ri: number, ro: number, a0: number, a1: number) => {
    const [x0, y0] = pt(ro, a0), [x1, y1] = pt(ro, a1), [x2, y2] = pt(ri, a1), [x3, y3] = pt(ri, a0);
    return `M${x0.toFixed(2)},${y0.toFixed(2)}A${ro},${ro} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}L${x2.toFixed(2)},${y2.toFixed(2)}A${ri},${ri} 0 0 0 ${x3.toFixed(2)},${y3.toFixed(2)}Z`;
  };
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" role="img" aria-label="Fire clock: monthly burning, one ring per year from 2001 to ${years.at(-1)}"><defs>${HATCH}</defs><rect width="${S}" height="${S}" fill="#fff"/>`;
  years.forEach((y, yi) => {
    const ri = r0 + yi * ring + 0.45, ro = r0 + (yi + 1) * ring - 0.45;
    for (let m = 0; m < 12; m++) {
      const r = vis.find((x) => x.month === `${y}-${String(m + 1).padStart(2, "0")}`);
      if (!r) continue;
      const a0 = gapDeg / 2 + m * mdeg + 0.35, a1 = gapDeg / 2 + (m + 1) * mdeg - 0.35;
      s += `<path class="cell" tabindex="0" data-t="${r.t}" style="animation-delay:${yi * 45 + m * 6}ms" d="${arc(ri, ro, a0, a1)}" fill="${color(r.value)}"${r.partial ? ' stroke="#14181d" stroke-width=".8" stroke-dasharray="2 1.5"' : r.value === 0 ? ' stroke="#e3e6ea" stroke-width=".6"' : ""}/>`;
    }
    const keyYears = ["2001", "2012", years.at(-1)!].map((k) => years.indexOf(k));
    if (keyYears.includes(yi) || (+y % 5 === 0 && keyYears.every((k) => Math.abs(k - yi) > 2))) {
      const [x, yy] = pt(r0 + (yi + 0.5) * ring, 0);
      s += `<text x="${x}" y="${yy + 3.5}" text-anchor="middle" style="font-size:10px;font-weight:${y === "2012" ? 700 : 500}">${y}</text>`;
    }
  });
  const vi = years.indexOf("2012");
  if (vi > 0) {
    const rr = r0 + vi * ring, [x0, y0] = pt(rr, gapDeg / 2), [x1, y1] = pt(rr, 360 - gapDeg / 2);
    s += `<path d="M${x0},${y0}A${rr},${rr} 0 1 1 ${x1},${y1}" fill="none" stroke="#14181d" stroke-width="1.4" stroke-dasharray="4 3"/>`;
  }
  MON.forEach((m, i) => { const [x, y] = pt(r1 + 18, gapDeg / 2 + (i + 0.5) * mdeg); s += `<text class="mo" x="${x}" y="${y + 4}" text-anchor="middle">${m}</text>`; });
  const nm = placeName.length > 20 ? placeName.slice(0, 19) + "…" : placeName;
  s += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" style="font-size:14px;font-weight:700;fill:#14181d">${nm}</text><text x="${cx}" y="${cy + 15}" text-anchor="middle">2001 → ${years.at(-1)}</text></svg>`;
  $("clock").innerHTML = s;
  bindCells($("clock"));
  $("legend").innerHTML = `<span class="ramp">quieter<span class="bar">${RED.map((c) => `<i style="background:${c}"></i>`).join("")}</span>busier month (for this area)</span>
    <span><span class="sw" style="background:#fff"></span>none detected</span>
    <span><span class="sw" style="background:repeating-linear-gradient(45deg,#eef0f2 0 3px,#c9ced5 3px 5px)"></span>no satellite record</span>
    <span><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#14181d" stroke-width="1.4" stroke-dasharray="4 3"/></svg> inside the 2012 ring: rebuilt from MODIS</span>`;
}
function drawGrid() {
  const years = [...new Set(M.map((m) => m.slice(0, 4)))];
  const color = scale(rows.map((r) => r.value));
  const cw = 44, ch = 19, left = 46, top = 20, Wd = left + 12 * cw + 4, Ht = top + years.length * ch + 4;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Wd} ${Ht}" width="${Wd}" role="img" aria-label="Monthly burning grid"><defs>${HATCH}</defs><rect width="${Wd}" height="${Ht}" fill="#fff"/>`;
  MON.forEach((m, i) => (s += `<text class="mo" x="${left + i * cw + cw / 2}" y="13" text-anchor="middle">${m}</text>`));
  years.forEach((y, yi) => {
    s += `<text x="${left - 8}" y="${top + yi * ch + 13}" text-anchor="end" style="font-weight:${y === "2012" ? 700 : 500}">${y}</text>`;
    for (let m = 0; m < 12; m++) {
      const r = rows.find((x) => x.month === `${y}-${String(m + 1).padStart(2, "0")}`);
      if (!r) continue;
      s += `<rect class="cell" tabindex="0" data-t="${r.t}" x="${left + m * cw + 1}" y="${top + yi * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${color(r.value)}"${r.partial ? ' stroke="#14181d" stroke-dasharray="3 2"' : r.value === 0 ? ' stroke="#e3e6ea"' : ""}/>`;
    }
  });
  $("clock").innerHTML = s + "</svg>";
  bindCells($("clock"));
}
const drawCalendar = () => (calView === "clock" ? drawClock() : drawGrid());

// ---------------- story chart ----------------
function drawStory() {
  const h = annual("value"), years = h.years, harm = h.vals, modis = annual("modis").vals;
  const nppA = annual("npp").vals, n20A = annual("n20").vals, npp = nppA.map((v, i) => v ?? (years[i] >= "2026" ? n20A[i] : null));
  const [q10, q90] = validation.terra_aqua.interval_annual_log1p_q10_q90 ?? meta.interval_full;
  const band = harm.map((v, i) => (years[i] < "2012" && v !== null ? [Math.max(0, Math.expm1(Math.log1p(v) + q10)), Math.expm1(Math.log1p(v) + q90)] : null));
  const W = 1000, H = 380, l = 56, r = 160, t = 34, b = 32;
  const all = [...harm, ...modis, ...npp, ...band.map((x) => x?.[1] ?? null)].filter((v): v is number => v !== null);
  const tk = ticks(Math.max(1, ...all)), ymax = tk[tk.length - 1];
  const X = (i: number) => l + (i / Math.max(1, years.length - 1)) * (W - l - r), Y = (v: number) => t + (1 - v / ymax) * (H - t - b);
  const path = (a: Num[]) => { let d = "", pen = false; a.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; }); return d; };
  const lastIdx = (a: Num[]) => a.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).pop() ?? 0;
  const end = (a: Num[], col: string, label: string, dy = 0) => `<circle cx="${X(lastIdx(a))}" cy="${Y(a[lastIdx(a)] ?? 0)}" r="4.5" fill="${col}"/><text class="lab" x="${W - r + 14}" y="${Y(a[lastIdx(a)] ?? 0) + 4 + dy}">${label}</text>`;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Annual burning: raw satellite records versus FireCal">`;
  for (const v of tk) s += `<line x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eef0f2"/><text x="${l - 8}" y="${Y(v) + 4}" text-anchor="end">${v.toLocaleString()}</text>`;
  years.forEach((y, i) => { if ((i % 3 === 0 && i < years.length - 2) || i === years.length - 1) s += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${y}${y === LAST_YEAR ? "*" : ""}</text>`; });
  const i12 = years.indexOf("2012");
  if (i12 >= 0) s += `<line x1="${X(i12)}" x2="${X(i12)}" y1="${t - 12}" y2="${H - b}" stroke="#7a8491" stroke-dasharray="4 4"/><text class="lab" x="${X(i12) + 6}" y="${t - 16}">2012: new satellite sensor</text>`;
  const ov = years.map((y, i) => (y >= "2012" && modis[i] && npp[i] ? npp[i]! / modis[i]! : null)).filter((x): x is number => x !== null);
  const jump = ov.length ? ov.reduce((a, b2) => a + b2, 0) / ov.length : null;
  if (jump) txt("jump", `${jump.toFixed(1)}×`);
  const yM = Y(modis[lastIdx(modis)] ?? 0), yV = Y(npp[lastIdx(npp)] ?? 0), clash = Math.abs(yM - yV) < 16 ? (yM > yV ? 8 : -8) : 0;
  s += `<g class="raw" style="transition:opacity .45s"><path d="${path(modis)}" fill="none" stroke="${C.modis}" stroke-width="2.6"/><path d="${path(npp)}" fill="none" stroke="${C.npp}" stroke-width="2.6"/>
    ${end(modis, C.modis, "Old sensor (MODIS)", clash)}${end(npp, C.npp, "New sensor (VIIRS)", -clash)}</g>`;
  let bd = ""; band.forEach((x, i) => { if (x) bd += `${bd ? "L" : "M"}${X(i)},${Y(x[1])}`; }); for (let i = band.length - 1; i >= 0; i--) if (band[i]) bd += `L${X(i)},${Y(band[i]![0])}`;
  s += `<g class="harm" style="transition:opacity .45s">${bd ? `<path d="${bd}Z" fill="${C.ink}" opacity=".1"/>` : ""}<path d="${path(harm)}" fill="none" stroke="${C.ink}" stroke-width="3.2"/>${end(harm, C.ink, "FireCal")}
    ${i12 > 1 ? `<text x="${X(Math.floor(i12 / 2))}" y="${t + 4}" text-anchor="middle" style="font-size:12px">rebuilt from MODIS · shaded = likely range</text>` : ""}</g></svg>`;
  $("storychart").innerHTML = s;
  const raw = storyMode === "raw";
  ($("storychart").querySelector(".raw") as SVGGElement).style.opacity = raw ? "1" : "0.12";
  ($("storychart").querySelector(".harm") as SVGGElement).style.opacity = raw ? "0" : "1";
  $("storycap").innerHTML = raw
    ? `Add up the raw detections and burning seems to jump ${jump ? `<b>${jump.toFixed(1)}×</b> ` : ""}the moment VIIRS arrives. That's the sensor, not the fires. <b>Switch to FireCal</b> to see one continuous record.`
    : `FireCal puts every year on the VIIRS scale: what VIIRS saw from 2012, and what it <i>would have</i> seen before that, rebuilt from MODIS with a likely range. Now 2005 and 2025 can be compared directly. <span class="note">* ${LAST_YEAR} so far.</span>`;
}

// ---------------- trust ----------------
function drawTrust() {
  const v = validation.terra_aqua, ch = v.chosen, k = v.metrics;
  const ours = k[ch].annual_median_abs_pct, raw = k.unadjusted.annual_median_abs_pct;
  const months = v.months.map((m) => m.slice(0, 4)), yrs = [...new Set(months)];
  const sumY = (arr: number[]) => yrs.map((y) => arr.reduce((a, x, i) => a + (months[i] === y ? x : 0), 0));
  const obs = sumY(v.obs), pred = sumY(v.pred[ch]), unadj = sumY(v.pred.unadjusted);
  const W = 640, H = 300, l = 52, r = 14, t = 16, b = 30, tk = ticks(Math.max(1, ...obs, ...pred, ...unadj)), max = tk[tk.length - 1];
  const bw = (W - l - r) / yrs.length, Y = (x: number) => t + (1 - x / max) * (H - t - b);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Test years: what VIIRS saw versus FireCal and raw MODIS">`;
  for (const x of tk) s += `<line x1="${l}" x2="${W - r}" y1="${Y(x)}" y2="${Y(x)}" stroke="#eef0f2"/><text x="${l - 6}" y="${Y(x) + 4}" text-anchor="end">${x.toLocaleString()}</text>`;
  yrs.forEach((y, i) => {
    const x = l + i * bw;
    s += `<rect x="${x + bw * 0.18}" y="${Y(obs[i])}" width="${bw * 0.64}" height="${Y(0) - Y(obs[i])}" rx="3" fill="#f6c3ba"><title>${y}: VIIRS saw ${fmt(obs[i])}</title></rect>`;
    s += `<circle cx="${x + bw / 2}" cy="${Y(unadj[i])}" r="5" fill="#fff" stroke="${C.modis}" stroke-width="2"><title>${y}: raw MODIS ${fmt(unadj[i])}</title></circle>`;
    s += `<circle cx="${x + bw / 2}" cy="${Y(pred[i])}" r="5.5" fill="${C.ink}" stroke="#fff" stroke-width="1.5"><title>${y}: FireCal ${fmt(pred[i])}</title></circle>`;
    if (i % 2 === 0 || i === yrs.length - 1) s += `<text x="${x + bw / 2}" y="${H - 9}" text-anchor="middle">${y}</text>`;
  });
  s += "</svg>";
  const [blo, bhi] = v.bootstrap_95.gbm_minus_seasonal, cont = validation.continuity_snpp_noaa20;
  $("trust").innerHTML = `<div class="bigstat">
      <div class="num">${ours.toFixed(0)}%</div>
      <p>typical miss on yearly totals, for years FireCal had never seen. A single correction factor misses by <b>${k.ratio.annual_median_abs_pct.toFixed(0)}%</b>; raw MODIS by <b>${raw.toFixed(0)}%</b>.</p>
      <p class="fine">${v.years.length} test years, ${v.years[0]}–${v.years.at(-1)}. Method used before 2012: ${METHOD[ch]}.${ours < raw ? "" : " The adjustment did not beat raw MODIS on this measure."}</p>
    </div>
    <div class="card">
      <div class="legend" style="justify-content:flex-start;margin:0 0 6px"><span><span class="sw" style="background:#f6c3ba"></span>What VIIRS actually saw</span>
      <span><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="${C.ink}"/></svg> FireCal, rebuilt from MODIS</span>
      <span><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="#fff" stroke="${C.modis}" stroke-width="2"/></svg> Raw MODIS</span></div>
      <div class="chart">${s}</div>
      <details class="more"><summary>All methods and statistics</summary>
        <table class="metrics"><tr><th>Method</th><th title="mean |log(1+predicted) − log(1+VIIRS)| by region-month; fixed before results">Monthly error ↓</th><th>Typical yearly miss</th><th>Bias</th><th>Rank corr.</th></tr>
        ${Object.keys(METHOD).map((m) => `<tr class="${m === ch ? "chosen" : ""}"><td>${METHOD[m]}</td><td>${k[m].mae_log.toFixed(3)}</td><td>${k[m].annual_median_abs_pct.toFixed(0)}%</td><td>${k[m].bias_pct >= 0 ? "+" : ""}${k[m].bias_pct.toFixed(0)}%</td><td>${k[m].spearman.toFixed(2)}</td></tr>`).join("")}
        </table>
        <p class="note">Leave-one-year-out over ${v.years[0]}–${v.years.at(-1)}, ${v.n_train_rows.toLocaleString()} block-months. 95% year-bootstrap interval of the monthly-error difference (boosted model minus seasonal regression): [${blo.toFixed(3)}, ${bhi.toFixed(3)}]${bhi < 0 ? ", boosted model better" : ", includes zero, so not a conclusive difference"}.${cont.spearman == null ? "" : ` NOAA-20 vs S-NPP over ${cont.months} shared months: ${(cont.noaa20_over_snpp_total * 100).toFixed(0)}% of the activity, rank correlation ${cont.spearman.toFixed(2)}.`}</p>
      </details>
    </div>`;
}

// ---------------- map / explore ----------------
const map = DECK ? null : L.map("map", { preferCanvas: true, zoomSnap: 0.25, scrollWheelZoom: false }); // wheel zoom would trap page scrolling
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_";
const [W, S, E, N] = meta.region.bbox as number[];
const hotLayer = L.layerGroup();
if (map) {
  L.tileLayer(`${ESRI}Base/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors" }).addTo(map);
  L.tileLayer(`${ESRI}Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, pane: "shadowPane" }).addTo(map);
  map.fitBounds([[S, W], [N, E]], { padding: [6, 6] });
  L.rectangle([[S, W], [N, E]], { color: "#14181d", weight: 1, opacity: 0.4, fill: false, dashArray: "4 4", interactive: false }).addTo(map);
  hotLayer.addTo(map);
}
let shape: L.Layer | null = null;
const KX = 111.32 * Math.cos((((S + N) / 2) * Math.PI) / 180), KY = 110.95;
const centre = (b: Block) => [(b.bounds[0] + b.bounds[2]) / 2, (b.bounds[1] + b.bounds[3]) / 2];
function setShape(l: L.Layer | null) { if (!map) return; if (shape) map.removeLayer(shape); shape = l; if (l) l.addTo(map); }
function choosePreset(k: string) {
  placeKey = k;
  if (k === "all") { selected = allIds(); placeName = meta.region.short; placeSub = meta.region.name; setShape(null); }
  else {
    const [w, s, e, n] = meta.region.presets[k];
    selected = new Set(blocks.filter((b) => { const [x, y] = centre(b); return x >= w && x <= e && y >= s && y <= n; }).map((b) => b.id));
    placeName = k.replace(/ \(.+\)/, ""); placeSub = k;
    setShape(L.rectangle([[s, w], [n, e]], { color: "#e8573f", weight: 2, fillOpacity: 0.06, interactive: false }));
  }
  render();
}
let lastClick: L.LatLng | null = null;
async function chooseCircle(ll: L.LatLng) {
  const rk = +$<HTMLInputElement>("radius").value;
  const sel = new Set(blocks.filter((b) => { const [x, y] = centre(b); return Math.hypot((x - ll.lng) * KX, (y - ll.lat) * KY) <= rk; }).map((b) => b.id));
  if (!sel.size) return;
  lastClick = ll; selected = sel; placeKey = "custom";
  placeName = `${rk} km around ${ll.lat.toFixed(2)}°N, ${Math.abs(ll.lng).toFixed(2)}°W`;
  placeSub = `${sel.size} grid blocks of ${meta.grid.block_km} km`;
  setShape(L.circle(ll, { radius: rk * 1000, color: "#e8573f", weight: 2, fillOpacity: 0.06, interactive: false }));
  render();
  try { // friendly place name from OpenStreetMap Nominatim (best effort)
    const j = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${ll.lat.toFixed(4)}&lon=${ll.lng.toFixed(4)}`).then((r) => r.json());
    const a = j.address || {}, nm = a.city || a.town || a.village || a.hamlet || a.county;
    if (nm && lastClick === ll) { placeName = `${rk} km around ${nm}`; render(); }
  } catch { /* keep coordinates */ }
}
if (map) {
  map.on("click", (e: L.LeafletMouseEvent) => chooseCircle(e.latlng));
  $<HTMLInputElement>("radius").oninput = () => ($("radiusout").textContent = `${$<HTMLInputElement>("radius").value} km`);
  $<HTMLInputElement>("radius").onchange = () => { if (lastClick && placeKey === "custom") chooseCircle(lastClick); };
}

const hotCache = new Map<string, Promise<string[][]>>();
const hotYear = (y: string) => {
  if (!meta.hotspot_years.includes(y)) return Promise.resolve([] as string[][]);
  if (!hotCache.has(y)) hotCache.set(y, fetch(`${DATA}hotspots/${y}.csv`).then((r) => r.text()).then((t) => t.trim().split(/\r?\n/).map((l) => l.split(","))));
  return hotCache.get(y)!;
};
async function selectedHotspots() {
  const ys: string[] = [];
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) ys.push(String(y));
  const parts = await Promise.all(ys.map(hotYear));
  const header = parts.find((p) => p.length)?.[0] ?? [];
  const iD = header.indexOf("date"), iB = header.indexOf("block"), out: string[][] = [];
  for (const p of parts) for (const r of p.slice(1)) { const m = r[iD].slice(0, 7); if (m >= from && m <= to && selected.has(+r[iB])) out.push(r); }
  return { header, rows: out };
}
let hotToken = 0;
async function drawHotspots() {
  if (DECK) return;
  const tk = ++hotToken, { header, rows: hs } = await selectedHotspots();
  if (tk !== hotToken) return;
  hotLayer.clearLayers();
  const iLat = header.indexOf("lat"), iLon = header.indexOf("lon"), iP = header.indexOf("platform"), iU = header.indexOf("used");
  const used = hs.filter((r) => r[iU] === "1"), step = Math.max(1, Math.ceil(used.length / 10000)), dense = used.length > 3000;
  for (let i = 0; i < used.length; i += step) {
    const r = used[i], p = r[iP];
    L.circleMarker([+r[iLat], +r[iLon]], { interactive: false, radius: dense ? 1.8 : 3, weight: dense ? 0 : 0.8, color: "#fff", fillOpacity: dense ? 0.55 : 0.9, fillColor: p === "S-NPP" ? C.npp : p === "NOAA-20" ? C.n20 : C.modis }).addTo(hotLayer);
  }
  $("mapinfo").textContent = `${hs.length.toLocaleString()} NASA detections in this area, ${mname(from)} – ${mname(to)}${step > 1 ? ` (map shows 1 in ${step}; downloads include all)` : ""}. Industrial flares and low-confidence detections are in the download but not counted.`;
}

// ---------------- downloads ----------------
function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
if (!DECK) setupDownloads();
function setupDownloads() {
const slug = () => placeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
$("dl-hot").onclick = async () => {
  const { header, rows: hs } = await selectedHotspots();
  download(`firecal_detections_${slug()}_${from}_${to}.csv`, [header.join(","), ...hs.map((r) => r.join(","))].join("\n") + "\n", "text/csv");
  $("dlinfo").textContent = `${hs.length.toLocaleString()} original FIRMS detections. Column "used" = 1 if counted in the calendar.`;
};
$("dl-cal").onclick = () => {
  const head = ["month", "firecal_km2_days", "value_type", "source", "likely_low", "likely_high", "typical_for_month", "modis_raw", "viirs_snpp_raw", "viirs_noaa20_raw", "partial_month"];
  const c = (v: Num) => (v === null ? "" : String(Math.round(v * 100) / 100));
  const body = rows.filter((r) => r.month >= from && r.month <= to).map((r) => [r.month, c(r.value), r.type === "none" ? "no observation" : r.type, r.source ?? "", c(r.lo), c(r.hi), c(r.median), c(r.modis), c(r.npp), c(r.n20), r.partial ? 1 : 0].join(","));
  download(`firecal_calendar_${slug()}_${from}_${to}.csv`, [head.join(","), ...body].join("\n") + "\n", "text/csv");
  $("dlinfo").textContent = "Calendar downloaded: value_type marks observed, rebuilt (estimated) and missing months.";
};
$("dl-svg").onclick = () => download(`firecal_${calView}_${slug()}.svg`, $("clock").innerHTML, "image/svg+xml");
$("dl-meta").onclick = () => download(`firecal_metadata_${slug()}.json`, JSON.stringify({ place: placeName, selection: { from, to, blocks: [...selected].sort((a, b) => a - b) }, ...meta,
  validation: { terra_aqua: validation.terra_aqua.metrics, chosen: validation.terra_aqua.chosen } }, null, 1), "application/json");
}

// ---------------- text ----------------
function drawStatic() {
  $("updated").textContent = dname(meta.observations_through);
  $("tech").innerHTML = `
  <p><b>Unit.</b> One km²-day is one 1 km × 1 km grid square where a satellite detected fire on one day. It measures satellite-observed burning; it is not a count of separate fires, burned area or ignition risk.</p>
  <p><b>Data.</b> NASA FIRMS active-fire detections for ${meta.region.name}: MODIS Collection 6.1 (Terra and Aqua, since Nov 2000) and VIIRS 375 m Collection 2 (Suomi NPP from 2012 until it stopped on ${dname(meta.snpp_end)}; NOAA-20 since 2018). ${Number(meta.n_hotspots).toLocaleString()} detections, ${Number(meta.n_qualifying).toLocaleString()} counted.</p>
  <p><b>What counts.</b> Detections that are not low confidence and not static sources such as refinery flares (FIRMS type 2). Excluded records stay in the downloads.</p>
  <p><b>The model.</b> A seasonal Poisson regression gives a baseline; gradient-boosted trees learn a correction from MODIS activity, Terra and Aqua separately, neighbouring areas, the months before and after, fire intensity, season and location. Beyond the largest training values the top-of-range ratio is held constant.</p>
  <p><b>Testing.</b> Leave-one-year-out over the overlap years, against raw MODIS and a single ratio. The monthly error measure was fixed before results; whichever method wins is used before 2012.</p>
  <p><b>Limits.</b> Clouds and smoke hide fires from every sensor. Pre-2012 estimates assume the 2012–2026 MODIS–VIIRS relationship held earlier. The newest months use near-real-time data that NASA later reprocesses.</p>`;
  $("foot").innerHTML = `<b>FireCal</b> · Team BlazePatrol · NASA Space Apps Challenge 2026, <i>Harmonization of MODIS and VIIRS Hot Spots</i><br/>
  <a href="deck.html" style="color:inherit">7-slide summary</a> (<a href="FireCal-deck.pdf" style="color:inherit">PDF</a>) · <a href="https://github.com/blazepatrol/firecal" style="color:inherit">Source code</a>, Apache-2.0<br/>
  Data: NASA Fire Information for Resource Management System (FIRMS), part of NASA LANCE and ESDIS. Basemap © Esri, © OpenStreetMap contributors. Place names © OpenStreetMap (Nominatim).`;
}

// ---------------- controls ----------------
document.querySelectorAll<HTMLButtonElement>(".viewtoggle button").forEach((b) => (b.onclick = () => {
  calView = b.dataset.v as typeof calView;
  document.querySelectorAll(".viewtoggle button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  drawCalendar();
}));
document.querySelectorAll<HTMLButtonElement>("#storytoggle button").forEach((b) => (b.onclick = () => {
  storyMode = b.dataset.v as typeof storyMode;
  document.querySelectorAll("#storytoggle button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  drawStory();
}));
if (!DECK) {
  const fromEl = $<HTMLInputElement>("from"), toEl = $<HTMLInputElement>("to");
  for (const el of [fromEl, toEl]) { el.min = M[0]; el.max = M[T - 1]; }
  fromEl.value = from; toEl.value = to;
  fromEl.onchange = toEl.onchange = () => { from = fromEl.value || M[0]; to = toEl.value || M[T - 1]; if (from > to) [from, to] = [to, from]; drawHotspots(); };
}

function render() {
  rows = computeRows();
  txt("calhead", `${placeName}: 25 years of burning, month by month`);
  txt("placename", placeName);
  txt("placesub", placeSub);
  drawPlaces(); drawAnswer(); drawCalendar(); drawInsights(); drawStory(); drawHotspots();
  const lf = rows[lastFull()], ev = document.getElementById("exverdict"); // verdict beside the map (not in the deck)
  if (ev) { const c = lf.value === null ? null : classify(lf.value, lf.median, lf.month); ev.innerHTML = c ? `${mname(lf.month)}: <b style="color:${c.tone}">${c.mult} · ${c.word}</b> &nbsp;<a href="#">Full answer ↑</a>` : ""; }
  $("detail").innerHTML = detailHtml(lf) + `<div class="note" style="margin-top:6px">Hover any month for its details.</div>`;
}
drawStatic();
drawTrust();
if (DECK) deck(); else render();

function deck() {
  // Slide 6: the two presets whose peak months differ most
  const peakOf = () => {
    const full = rows.filter((r) => r.value !== null && r.month >= "2001" && !r.month.startsWith(LAST_YEAR));
    const mean = MON.map((_, i) => { const xs = full.filter((r) => +r.month.slice(5) === i + 1).map((r) => r.value!); return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); });
    return mean.indexOf(Math.max(...mean));
  };
  const keys = Object.keys(meta.region.presets), peaks: Record<string, number> = {};
  for (const k of keys) { choosePreset(k); peaks[k] = peakOf(); }
  const d = (a: number, b: number) => Math.min(Math.abs(a - b), 12 - Math.abs(a - b));
  let best: [string, string] = [keys[0], keys[1] ?? keys[0]];
  for (const a of keys) for (const b of keys) if (a < b && d(peaks[a], peaks[b]) > d(peaks[best[0]], peaks[best[1]])) best = [a, b];
  txt("h-places", d(peaks[best[0]], peaks[best[1]]) >= 2 ? "Same region, two different fire seasons." : "Every place gets its own fire calendar.");
  best.forEach((k, i) => {
    const id = "ab"[i];
    choosePreset(k);
    txt(`name-${id}`, placeName);
    $(`clock-${id}`).innerHTML = $("clock").innerHTML;
    $(`ins-${id}`).innerHTML = $("insights").querySelector("li span:last-child")?.innerHTML ?? "";
  });
  choosePreset("all");
  storyMode = "raw"; drawStory(); $("story-raw").innerHTML = $("storychart").innerHTML; $("cap-raw").innerHTML = $("storycap").innerHTML;
  storyMode = "harm"; drawStory(); $("story-harm").innerHTML = $("storychart").innerHTML;
  document.body.classList.add("ready");
}
