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
// Light theme. Series colours and the ember ramp were checked with the dataviz palette validator against a white surface.
const TH = { ink: "#1a1310", ink2: "#5b5148", mute: "#85796d", grid: "#e2dace", surface: "#fbf8f3", zero: "#f1ece3", est: "#d8d0c3", obs: "#b5aa9b" };
const C = { modis: "#2a78d6", npp: "#eb6834", n20: "#1baf7a", ink: TH.ink };
const RAMP = ["#eda465", "#e38b43", "#d5732a", "#bd5d1e", "#9f4a17", "#7c3811", "#55250a"];
const TONE = { cool: "#1c5cab", good: "#0a7d0a", warn: "#c2541f", hot: "#d03b3b" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// round axis ticks (step 1, 2, 2.5 or 5 × a power of ten) from 0 up to at least max
const ticks = (max: number) => { const p = 10 ** Math.floor(Math.log10(max / 5)), step = [1, 2, 2.5, 5, 10].find((m) => m * p >= max / 5)! * p; return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step); };
const fmt = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
const mname = (m: string) => `${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
const dname = (d: string) => `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
const UNIT = "km²-days of detected fire";
const UNIT_S = `<abbr title="One km²-day is one square kilometre with fire detected on one day">km²-days</abbr>`;
const SVG_TEXT = `<style>text{font:12px Archivo,system-ui,sans-serif;fill:${TH.ink2}}.mo{font-weight:600;fill:${TH.ink}}</style>`;

// ---------------- icons: drawn for FireCal on a 24 px grid ----------------
const FLAME = "M12 2.5c.6 3.4 5.5 5.6 5.5 11a5.5 5.5 0 0 1-11 0c0-2.3 1-4.2 2.3-5.500.1 1.9.9 3 2 3.300-.4-3.200-.3-6.300 1.200-8.800z";
const ICON: Record<string, string> = {
  flame: `<path d="${FLAME}"/><path d="M12 19a2.300 2.300 0 0 1-2.300-2.300c0-1.300 1.100-2 2.300-3.500 1.200 1.500 2.300 2.200 2.300 3.500A2.300 2.300 0 0 1 12 19z"/>`,
  satellite: `<g transform="rotate(-35 12 12)"><rect x="9.5" y="7.5" width="5" height="8" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx=".8"/><rect x="17" y="9" width="5" height="5" rx=".8"/><path d="M7 11.5h2.500M14.500 11.500H17M12 15.500v2.300M9.400 20.400a3.400 3.400 0 0 1 5.200 0"/></g>`,
  wind: `<path d="M3 9h11a2.500 2.500 0 1 0-2.500-2.500M3 13h16a2.500 2.500 0 1 1-2.500 2.500M3 17h8a2 2 0 1 1-2 2"/>`,
  droplet: `<path d="M12 3c3.200 3.900 5.500 6.900 5.500 10.200a5.500 5.500 0 0 1-11 0C6.500 9.900 8.800 6.900 12 3z"/>`,
  thermo: `<path d="M10 5a2 2 0 0 1 4 0v8.600a4 4 0 1 1-4 0zM12 10v6"/>`,
  calendar: `<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.500 10h17M8 3v4M16 3v4M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>`,
  target: `<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>`,
  search: `<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.300-4.300"/>`,
  locate: `<path d="M20.500 3.500 3.500 10.600l7 2.900 2.900 7z"/>`,
  download: `<path d="M12 4v11M7.500 11 12 15.500 16.500 11M5 19.500h14"/>`,
  trend: `<path d="M3.500 17 9 11.500l4 4 7.500-8M15 7.500h5.500V13"/>`,
  bars: `<path d="M5 20v-9M12 20V4M19 20v-6"/>`,
  moon: `<path d="M20 14.200A8 8 0 1 1 9.800 4a6.300 6.300 0 0 0 10.200 10.200z"/>`,
  shield: `<path d="M12 3 5 6v5.500c0 4.300 2.900 7.600 7 9.500 4.100-1.900 7-5.200 7-9.500V6zM9 12l2.200 2.200 4-4.200"/>`,
  grid: `<rect x="4" y="4" width="7" height="7" rx="1.2"/><rect x="13" y="4" width="7" height="7" rx="1.2"/><rect x="4" y="13" width="7" height="7" rx="1.2"/><rect x="13" y="13" width="7" height="7" rx="1.2"/>`,
  gap: `<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3.200"/><path d="M9 12h6"/>`,
  swap: `<path d="M4 8.500h14M14.500 5 18 8.500 14.500 12M20 15.500H6M9.500 12 6 15.500 9.500 19"/>`,
  rewind: `<path d="M4.500 12a7.500 7.500 0 1 0 2.400-5.500M4 4.500v4h4M12 8v4.200l2.800 1.800"/>`,
  play: `<path d="M8 5.500v13l10.500-6.500z" fill="currentColor"/>`,
  pause: `<path d="M8.500 5.500v13M15.500 5.500v13"/>`,
  arrow: `<path d="M12 20V5M6 11l6-6 6 6"/>`,
  alert: `<path d="M12 4 3 19.500h18zM12 10v4.500M12 17h.01"/>`,
  close: `<path d="M6 6l12 12M18 6 6 18"/>`,
  arrowr: `<path d="M5 12h14M13 6l6 6-6 6"/>`,
  gauge: `<path d="M4 16.500a8 8 0 0 1 16 0"/><path d="M12 16.500l4.200-5.200"/><circle cx="12" cy="16.500" r="1.200"/>`,
  tree: `<path d="M12 21v-5M12 3l4.500 5.500h-2.500l4 5H6l4-5H7.500z"/>`,
  sprout: `<path d="M12 21v-8.500M12 12.500C12 9 9.500 7 6 7c0 3.500 2.500 5.500 6 5.500zM12 14.500c0-3 2-5 5.500-5 0 3-2 5-5.500 5z"/>`,
  bolt: `<path d="M13 2.500 5 13.500h6l-1 8 8-11h-6z"/>`,
  umbrella: `<path d="M3.500 12a8.500 8.500 0 0 1 17 0zM12 12v6.500a2 2 0 0 1-4 0M12 3.500v-1"/>`,
  cloud: `<path d="M7 18a4 4 0 0 1-.600-7.950A5.500 5.500 0 0 1 17 9.500a4.250 4.250 0 0 1 .500 8.500z"/>`,
  globe: `<circle cx="12" cy="12" r="8.500"/><path d="M3.500 12h17M12 3.500c2.600 2.400 3.900 5.200 3.900 8.500s-1.300 6.100-3.900 8.500c-2.600-2.400-3.900-5.200-3.900-8.500S9.400 5.900 12 3.500z"/>`,
  beacon: `<path d="M7 19v-6a5 5 0 0 1 10 0v6M5 19h14M12 3v2M4.500 6 6 7.500M19.500 6 18 7.500"/>`,
};
const icon = (n: string, size = 20) => `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="16" rx="14" ry="5.600" transform="rotate(-28 16 16)" fill="none" stroke="currentColor" stroke-width="1.5"/><g transform="translate(2.200 3.400) scale(1.150)"><path d="${FLAME}" fill="#ff6a2b" stroke="#140e0c" stroke-width="1"/></g><circle cx="26.700" cy="8" r="1.900" fill="currentColor"/></svg>`;
document.querySelectorAll<HTMLElement>("[data-icon]").forEach((e) => (e.innerHTML = icon(e.dataset.icon!)));
document.querySelectorAll<HTMLElement>("[data-logo]").forEach((e) => (e.innerHTML = LOGO));

const [meta, blocks, monthly, validation] = (await Promise.all([
  getJSON("meta.json"), getJSON("blocks.json"), getJSON("monthly.json"), getJSON("validation.json"),
])) as [any, Block[], Monthly, Validation];

const M = monthly.months, T = M.length;
const OBS_DAY = +meta.observations_through.slice(8), OBS_FRAC = OBS_DAY / new Date(+M[T - 1].slice(0, 4), +M[T - 1].slice(5), 0).getDate();
const OBS_END = Date.parse(`${meta.observations_through}T23:59Z`);
const LIVE = (Date.now() - OBS_END) / 864e5 < 3; // the copy says "right now" only while the satellite data is fresh
const allIds = () => new Set(blocks.map((b) => b.id));
let selected = allIds(), placeName: string = meta.region.short, placeKey = "all";
let from = M[0], to = M[T - 1];
let rows: Row[] = [];
const DECK = "deck" in document.body.dataset; // deck.html reuses these renderers without the map
let calView: "clock" | "grid" = "grid";
let storyMode: "raw" | "harm" = "raw";
const txt = (id: string, v: string) => { const e = document.getElementById(id); if (e) e.textContent = v; };
const STILL = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
// Annual series for the current selection: FireCal, raw MODIS, raw VIIRS (S-NPP, then NOAA-20 once S-NPP stopped).
function annualSeries() {
  const h = annual("value"), n20 = annual("n20").vals;
  const viirs = annual("npp").vals.map((v, i) => v ?? (h.years[i] >= "2026" ? n20[i] : null)), modis = annual("modis").vals;
  const ov = h.years.map((y, i) => (y >= "2012" && modis[i] && viirs[i] ? viirs[i]! / modis[i]! : null)).filter((x): x is number => x !== null);
  return { years: h.years, harm: h.vals, modis, viirs, jump: ov.length ? ov.reduce((a, b) => a + b, 0) / ov.length : null };
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
// Colour by rank: each shade holds an equal share of the non-zero values, so seasons stand out anywhere.
function scale(vals: Num[]) {
  const nz = (vals.filter((v) => v !== null && v > 0) as number[]).sort((a, b) => a - b);
  const q = RAMP.slice(1).map((_, i) => nz[Math.floor(((i + 1) / RAMP.length) * nz.length)] ?? Infinity);
  return (v: Num) => (v === null ? "url(#hatch)" : v === 0 ? TH.zero : RAMP[q.filter((x) => v > x).length]);
}
const HATCH = `<pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${TH.surface}"/><line x1="0" y1="0" x2="0" y2="5" stroke="#d8d2c6" stroke-width="1.6"/></pattern>`;

// ---------------- the answer ----------------
function classify(v: number, med: number | null, month: string) {
  const mon = MONTH[+month.slice(5) - 1];
  if (med === null) return { r: null, mult: "–", word: "Not enough history", tone: TH.mute, exp: `Fewer than five earlier ${mon}s to compare with.` };
  if (med === 0) return v === 0
    ? { r: null, mult: "0", word: "Normal", tone: TONE.good, exp: `No burning detected, as usual for ${mon}.` }
    : { r: null, mult: "New", word: "Unusual", tone: TONE.hot, exp: `${fmt(v)} ${UNIT_S}, in a month that usually has none.` };
  const r = v / med;
  const word = r >= 2 ? "Well above normal" : r >= 1.25 ? "Above normal" : r > 0.8 ? "Normal" : r > 0.5 ? "Below normal" : "Well below normal";
  const tone = r >= 2 ? TONE.hot : r >= 1.25 ? TONE.warn : r > 0.8 ? TONE.good : TONE.cool;
  const mult = `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;
  return { r, mult, word, tone, exp: `<b>${mult}</b> the burning of a typical ${mon} here: ${fmt(v)} vs ${fmt(med)} ${UNIT_S}.` };
}
// Five zones on a log scale from a quarter of typical to four times typical.
function scaleBar(r: number | null, mult: string) {
  const pos = r === null ? null : Math.max(1, Math.min(99, ((Math.log2(Math.max(r, 0.01)) + 2) / 4) * 100));
  return `<div class="vscale"><div class="track"><i style="flex:25;background:#1c5cab"></i><i style="flex:17;background:#7fb0ea"></i><i style="flex:16;background:#3aa53a"></i><i style="flex:17;background:#e58a4f"></i><i style="flex:25;background:#d03b3b"></i>${pos === null ? "" : `<span class="mark" style="left:${pos}%"><b>${mult}</b></span>`}</div>
    <div class="ticks"><span>Well below</span><span>Below</span><span>Normal</span><span>Above</span><span>Well above</span></div></div>`;
}
function drawAnswer() {
  const tf = lastFull(), r = rows[tf], mon = MONTH[+r.month.slice(5) - 1], where = `<div class="where">${icon("target", 16)}${placeName}</div>`;
  if (r.value === null) { $("answer").innerHTML = where + `<p class="exp">No observation for ${mon}.</p>`; return; }
  const c = classify(r.value, r.median, r.month);
  const same = rows.filter((x) => x.month.slice(5) === r.month.slice(5) && x.month >= "2001");
  const w = 440, h = 84, b = 16, max = Math.max(1, ...same.map((x) => x.value ?? 0), r.median ?? 0), bw = w / same.length;
  let svg = `<svg class="mini" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${mon} in every year since 2001">`;
  same.forEach((x, i) => {
    if (x.value === null) return;
    const bh = Math.max(x.value > 0 ? 2 : 0, (x.value / max) * (h - b - 6));
    svg += `<rect x="${i * bw + 1}" y="${h - b - bh}" width="${bw - 2}" height="${bh}" rx="2" fill="${x.t === tf ? c.tone : x.type === "estimated" ? TH.est : TH.obs}"><title>${x.month.slice(0, 4)}: ${fmt(x.value)}</title></rect>`;
  });
  if (r.median !== null) { const y = h - b - (r.median / max) * (h - b - 6); svg += `<line x1="0" x2="${w}" y1="${y}" y2="${y}" stroke="${TH.ink}" stroke-dasharray="3 3" opacity=".6"/><text x="${w - 2}" y="${y - 4}" text-anchor="end">typical</text>`; }
  svg += `<text x="0" y="${h - 2}">${same[0].month.slice(0, 4)}</text><text x="${w}" y="${h - 2}" text-anchor="end">${same.at(-1)!.month.slice(0, 4)}</text></svg>`;
  const cur = rows[T - 1];
  let sofar = "";
  if (cur.partial && cur.value !== null && cur.median !== null) {
    const typ = cur.median * OBS_FRAC, cc = classify(cur.value, typ, cur.month);
    sofar = `<div class="sofar"><b>${MONTH[+cur.month.slice(5) - 1]} so far</b> (to ${dname(meta.observations_through)}): <b style="color:${cc.tone}">${cc.word}</b>, ${fmt(cur.value)} vs ${fmt(typ)} typical by this date.</div>`;
  }
  $("answer").innerHTML = `${where}<p class="q">Is the burning here unusual?</p><div class="vword" style="color:${c.tone}">${c.word}</div>${scaleBar(c.r, c.mult)}
    <p class="exp"><b>${mon} ${r.month.slice(0, 4)}</b> saw ${c.exp}</p>${svg}<div class="minicap">Every ${mon} since 2001. Dashed line = typical.</div>${sofar}`;
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
  out.push(`flame|Burning usually peaks in <b>${pair}</b>${second !== undefined ? `, with a second season around <b>${MONTH[second]}</b>` : ""}.`);
  const yrs = annual("value");
  const complete = yrs.years.map((y, i) => [y, yrs.vals[i]] as [string, Num]).filter(([y, v]) => v !== null && y !== LAST_YEAR) as [string, number][];
  if (complete.length) {
    const avg = complete.reduce((a, [, v]) => a + v, 0) / complete.length;
    const [by, bv] = complete.reduce((a, x) => (x[1] > a[1] ? x : a));
    out.push(`bars|<b>${by}</b> was the most active year on record: <b>${(bv / avg).toFixed(1)}×</b> an average year${by < "2012" ? ", rebuilt from the older MODIS sensor" : ""}.`);
    const recent = complete.filter(([y]) => +y >= +LAST_YEAR - 5), early = complete.filter(([y]) => y <= "2010");
    if (recent.length && early.length) {
      const ra = recent.reduce((a, [, v]) => a + v, 0) / recent.length, ea = early.reduce((a, [, v]) => a + v, 0) / early.length;
      const d = (ra / Math.max(ea, 1e-9) - 1) * 100;
      out.push(`trend|The last five years saw <b>${Math.abs(d).toFixed(0)}% ${d >= 0 ? "more" : "less"}</b> burning than 2001–2010. A fair comparison only because both eras are on one scale.`);
    }
  }
  out.push(`moon|<b>${MONTH[order.at(-1)!]}</b> is usually the quietest month.`);
  return out;
}
const drawInsights = () => ($("insights").innerHTML = insightLines().map((l) => { const [ic, t] = l.split("|"); return `<li><span class="ib">${icon(ic)}</span><span>${t}</span></li>`; }).join(""));

// ---------------- burning calendar: grid and fire clock ----------------
function detailHtml(r: Row): string {
  const pill = r.type === "estimated" ? `<span class="tag est">Rebuilt from MODIS</span>` : r.type === "observed" ? `<span class="tag obs">Seen by ${r.source?.replace(" observed", "")}</span>` : `<span class="tag none">No observation</span>`;
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
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" role="img" aria-label="Fire clock: monthly burning, one ring per year from 2001 to ${years.at(-1)}"><defs>${HATCH}</defs>${SVG_TEXT}<rect width="${S}" height="${S}" fill="${TH.surface}"/>`;
  years.forEach((y, yi) => {
    const ri = r0 + yi * ring + 0.45, ro = r0 + (yi + 1) * ring - 0.45;
    for (let m = 0; m < 12; m++) {
      const r = vis.find((x) => x.month === `${y}-${String(m + 1).padStart(2, "0")}`);
      if (!r) continue;
      const a0 = gapDeg / 2 + m * mdeg + 0.35, a1 = gapDeg / 2 + (m + 1) * mdeg - 0.35;
      s += `<path class="cell" tabindex="0" data-t="${r.t}" style="animation-delay:${yi * 45 + m * 6}ms" d="${arc(ri, ro, a0, a1)}" fill="${color(r.value)}"${r.partial ? ` stroke="${TH.ink}" stroke-width=".8" stroke-dasharray="2 1.5"` : ""}/>`;
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
    s += `<path d="M${x0},${y0}A${rr},${rr} 0 1 1 ${x1},${y1}" fill="none" stroke="${TH.ink}" stroke-width="1.4" stroke-dasharray="4 3"/>`;
  }
  MON.forEach((m, i) => { const [x, y] = pt(r1 + 18, gapDeg / 2 + (i + 0.5) * mdeg); s += `<text class="mo" x="${x}" y="${y + 4}" text-anchor="middle">${m}</text>`; });
  const nm = placeName.length > 20 ? placeName.slice(0, 19) + "…" : placeName;
  s += `<text class="mo" x="${cx}" y="${cy - 4}" text-anchor="middle" style="font-size:14px">${nm}</text><text x="${cx}" y="${cy + 15}" text-anchor="middle">2001 → ${years.at(-1)}</text></svg>`;
  $("clock").innerHTML = s;
  bindCells($("clock"));
}
function drawGrid() {
  const years = [...new Set(M.map((m) => m.slice(0, 4)))];
  const color = scale(rows.map((r) => r.value));
  const cw = 50, ch = 22, left = 46, top = 22, bx = left + 12 * cw + 12, bwid = 96, Wd = bx + bwid + 4, Ht = top + years.length * ch + 4;
  const tot = years.map((y) => rows.filter((r) => r.month.startsWith(y) && r.value !== null).reduce((a, r) => a + r.value!, 0)), tmax = Math.max(1, ...tot);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Wd} ${Ht}" width="${Wd}" role="img" aria-label="Burning calendar: one square per month"><defs>${HATCH}</defs>${SVG_TEXT}<rect width="${Wd}" height="${Ht}" fill="${TH.surface}"/>`;
  MON.forEach((m, i) => (s += `<text class="mo" x="${left + i * cw + cw / 2}" y="14" text-anchor="middle">${m}</text>`));
  s += `<text class="mo" x="${bx}" y="14">Year total</text>`;
  years.forEach((y, yi) => {
    s += `<rect x="${bx}" y="${top + yi * ch + 4}" width="${(tot[yi] / tmax) * bwid}" height="${ch - 8}" rx="2" fill="${tot[yi] === tmax ? RAMP[5] : TH.obs}"><title>${y}: ${fmt(tot[yi])} ${UNIT}</title></rect>`;
    if (y === "2012") s += `<line x1="${left}" x2="${Wd - 4}" y1="${top + yi * ch}" y2="${top + yi * ch}" stroke="${TH.ink}" stroke-width="1.2" stroke-dasharray="4 3"/>`;
    s += `<text x="${left - 8}" y="${top + yi * ch + 15}" text-anchor="end" style="font-weight:${y === "2012" ? 700 : 500}">${y}</text>`;
    for (let m = 0; m < 12; m++) {
      const r = rows.find((x) => x.month === `${y}-${String(m + 1).padStart(2, "0")}`);
      if (!r) continue;
      s += `<rect class="cell" tabindex="0" data-t="${r.t}" x="${left + m * cw + 1}" y="${top + yi * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${color(r.value)}"${r.partial ? ` stroke="${TH.ink}" stroke-dasharray="3 2"` : ""}/>`;
    }
  });
  $("clock").innerHTML = s + "</svg>";
  bindCells($("clock"));
}
function drawCalendar() {
  if (calView === "clock") drawClock(); else drawGrid();
  $("legend").innerHTML = `<span class="ramp">quieter<span class="bar">${RAMP.map((c) => `<i style="background:${c}"></i>`).join("")}</span>busier month (for this area)</span>
    <span><span class="sw" style="background:${TH.zero}"></span>none detected</span>
    <span><span class="sw" style="background:repeating-linear-gradient(45deg,${TH.surface} 0 3px,#d8d2c6 3px 5px)"></span>no satellite record</span>
    <span><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="${TH.ink}" stroke-width="1.4" stroke-dasharray="4 3"/></svg> ${calView === "clock" ? "inside the 2012 ring" : "above the dashed line"}: rebuilt from the older satellite</span>`;
}

// ---------------- 25-year line chart (in the proof section and the deck) ----------------
function drawStory() {
  const { years, harm, modis, viirs: npp, jump } = annualSeries();
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
  for (const v of tk) s += `<line x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${TH.grid}"/><text x="${l - 8}" y="${Y(v) + 4}" text-anchor="end">${v.toLocaleString()}</text>`;
  years.forEach((y, i) => { if ((i % 3 === 0 && i < years.length - 2) || i === years.length - 1) s += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${y}${y === LAST_YEAR ? "*" : ""}</text>`; });
  const i12 = years.indexOf("2012");
  if (i12 >= 0) s += `<line x1="${X(i12)}" x2="${X(i12)}" y1="${t - 12}" y2="${H - b}" stroke="${TH.mute}" stroke-dasharray="4 4"/><text class="lab" x="${X(i12) + 6}" y="${t - 16}">2012: new satellite sensor</text>`;
  if (jump) txt("jump", `${jump.toFixed(1)}×`);
  const yM = Y(modis[lastIdx(modis)] ?? 0), yV = Y(npp[lastIdx(npp)] ?? 0), clash = Math.abs(yM - yV) < 16 ? (yM > yV ? 8 : -8) : 0;
  s += `<g class="raw" style="transition:opacity .45s"><path d="${path(modis)}" fill="none" stroke="${C.modis}" stroke-width="2.6"/><path d="${path(npp)}" fill="none" stroke="${C.npp}" stroke-width="2.6"/>
    ${end(modis, C.modis, "Old sensor (MODIS)", clash)}${end(npp, C.npp, "New sensor (VIIRS)", -clash)}</g>`;
  let bd = ""; band.forEach((x, i) => { if (x) bd += `${bd ? "L" : "M"}${X(i)},${Y(x[1])}`; }); for (let i = band.length - 1; i >= 0; i--) if (band[i]) bd += `L${X(i)},${Y(band[i]![0])}`;
  s += `<g class="harm" style="transition:opacity .45s">${bd ? `<path d="${bd}Z" fill="${C.ink}" opacity=".14"/>` : ""}<path d="${path(harm)}" fill="none" stroke="${C.ink}" stroke-width="3.2"/>${end(harm, C.ink, "FireCal")}
    ${i12 > 1 ? `<text x="${X(Math.floor(i12 / 2))}" y="${t + 4}" text-anchor="middle" style="font-size:12px">rebuilt from MODIS · shaded = likely range</text>` : ""}</g></svg>`;
  $("storychart").innerHTML = s;
  const raw = storyMode === "raw";
  ($("storychart").querySelector(".raw") as SVGGElement).style.opacity = raw ? "1" : "0.16";
  ($("storychart").querySelector(".harm") as SVGGElement).style.opacity = raw ? "0" : "1";
  $("storycap").innerHTML = raw
    ? `Raw records: burning appears to jump ${jump ? `<b>${jump.toFixed(1)}×</b> ` : ""}in 2012. That is the sensor change, not more fire.`
    : `FireCal: every year on the VIIRS scale. Before 2012 the values are rebuilt from MODIS, with a likely range. <span class="note">* ${LAST_YEAR} so far.</span>`;
}

// ---------------- the problem: the same years, raw and harmonized ----------------
let REG = annualSeries(); // region-wide; filled once the first rows exist
function drawVersus() {
  const rawEl = document.getElementById("stripes-raw"), harmEl = document.getElementById("stripes-harm");
  if (!rawEl || !harmEl) return;
  const { years, harm, modis, viirs, jump } = REG, n = years.length, i12 = years.indexOf("2012");
  const raw = years.map((y, i) => (y < "2012" ? modis[i] : viirs[i]));
  const max = Math.max(1, ...[...harm, ...raw].filter((v): v is number => v !== null));
  const Wd = 560, Ht = 168, top = 26, bot = 20, bw = Wd / n, Y = (v: number) => top + (1 - v / max) * (Ht - top - bot);
  const chart = (vals: Num[], fill: (i: number) => string, left: string, right: string, label: string) => {
    let s = `<svg viewBox="0 0 ${Wd} ${Ht}" role="img" aria-label="${label}">`;
    vals.forEach((v, i) => { if (v !== null) s += `<rect class="bar" style="animation-delay:${i * 80}ms" x="${i * bw + 1.5}" y="${Y(v)}" width="${bw - 3}" height="${Ht - bot - Y(v)}" rx="2" ${fill(i)}><title>${years[i]}: ${fmt(v)} ${UNIT}</title></rect>`; });
    const x12 = i12 * bw;
    s += `<line x1="${x12}" x2="${x12}" y1="2" y2="${Ht - bot}" stroke="${TH.ink}" stroke-opacity=".45" stroke-dasharray="3 4"/><text x="${x12 - 8}" y="12" text-anchor="end">${left}</text><text x="${x12 + 8}" y="12">${right}</text>`;
    years.forEach((y, i) => { if (i === 0 || y === "2012" || i === n - 1 || (+y % 5 === 0 && Math.abs(i - i12) > 1 && i < n - 2)) s += `<text x="${i === n - 1 ? Wd : i * bw + bw / 2}" y="${Ht - 5}" text-anchor="${i === n - 1 ? "end" : "middle"}"${y === "2012" ? ' class="mo"' : ""}>${y}</text>`; });
    return s + "</svg>";
  };
  rawEl.innerHTML = chart(raw, (i) => `fill="${i < i12 ? C.modis : C.npp}"`, "MODIS", "VIIRS", "Raw satellite record per year: low before 2012, several times higher after");
  harmEl.innerHTML = chart(harm, (i) => `fill="${TH.ink}"${i < i12 ? ' fill-opacity=".38"' : ""}`, "Rebuilt from MODIS", "Recorded by VIIRS", "FireCal record per year: one consistent level across 2012");
  txt("vs-bad", `The ${jump ? jump.toFixed(1) + "× " : ""}jump in 2012 is the sensor change, not more fire.`);
}
// Bars rise year by year when the comparison scrolls into view; the Replay button runs it again.
function runVersus() {
  const el = document.getElementById("versus"), yrs = REG.years;
  if (!el) return;
  let timer = 0;
  const go = () => {
    el.classList.remove("run"); void el.offsetWidth; el.classList.add("run");
    let i = 0; clearInterval(timer);
    timer = window.setInterval(() => { txt("vsyear", yrs[Math.min(i, yrs.length - 1)]); if (++i >= yrs.length) clearInterval(timer); }, 80);
  };
  if (STILL || DECK) { el.classList.add("run"); txt("vsyear", `${yrs[0]}–${yrs.at(-1)}`); }
  else new IntersectionObserver((es, ob) => { if (es[0].isIntersecting) { go(); ob.disconnect(); } }, { threshold: 0.35 }).observe(el);
  const rp = document.getElementById("vsreplay"); if (rp) rp.onclick = go;
}
// Big numbers count up once when they scroll into view.
function countUp() {
  const est = rows.filter((r) => r.type === "estimated").length / 12;
  const spec: Record<string, [number, (v: number) => string]> = {
    hot: [Number(meta.n_hotspots), (v) => Math.round(v).toLocaleString()],
    jump: [REG.jump ?? 0, (v) => `${v.toFixed(1)}×`],
    lost: [Math.round(est), (v) => `${Math.round(v)} years`],
  };
  document.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
    const [to, f] = spec[el.dataset.count!];
    el.textContent = f(to);
    if (STILL || DECK) return;
    new IntersectionObserver((es, ob) => {
      if (!es[0].isIntersecting) return;
      ob.disconnect();
      const t0 = performance.now(), step = (now: number) => { const k = Math.min(1, (now - t0) / 1400); el.textContent = f(to * (1 - (1 - k) ** 3)); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }, { threshold: 0.6 }).observe(el);
  });
}

// ---------------- proof ----------------
function drawTrust() {
  const v = validation.terra_aqua, ch = v.chosen, k = v.metrics;
  const ours = k[ch].annual_median_abs_pct, raw = k.unadjusted.annual_median_abs_pct;
  const months = v.months.map((m) => m.slice(0, 4)), yrs = [...new Set(months)];
  const sumY = (arr: number[]) => yrs.map((y) => arr.reduce((a, x, i) => a + (months[i] === y ? x : 0), 0));
  const obs = sumY(v.obs), pred = sumY(v.pred[ch]), unadj = sumY(v.pred.unadjusted);
  const W = 1000, H = 300, l = 52, r = 14, t = 16, b = 30, tk = ticks(Math.max(1, ...obs, ...pred, ...unadj)), max = tk[tk.length - 1];
  const bw = (W - l - r) / yrs.length, Y = (x: number) => t + (1 - x / max) * (H - t - b), BAR = "#f0c3a2";
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Test years: what VIIRS saw versus FireCal and raw MODIS">`;
  for (const x of tk) s += `<line x1="${l}" x2="${W - r}" y1="${Y(x)}" y2="${Y(x)}" stroke="${TH.grid}"/><text x="${l - 6}" y="${Y(x) + 4}" text-anchor="end">${x.toLocaleString()}</text>`;
  yrs.forEach((y, i) => {
    const x = l + i * bw;
    s += `<rect x="${x + bw * 0.18}" y="${Y(obs[i])}" width="${bw * 0.64}" height="${Y(0) - Y(obs[i])}" rx="3" fill="${BAR}"><title>${y}: VIIRS saw ${fmt(obs[i])}</title></rect>`;
    s += `<circle cx="${x + bw / 2}" cy="${Y(unadj[i])}" r="5" fill="${TH.surface}" stroke="${C.modis}" stroke-width="2"><title>${y}: raw MODIS ${fmt(unadj[i])}</title></circle>`;
    s += `<circle cx="${x + bw / 2}" cy="${Y(pred[i])}" r="5.5" fill="${C.ink}" stroke="${TH.surface}" stroke-width="2"><title>${y}: FireCal ${fmt(pred[i])}</title></circle>`;
    if (i % 2 === 0 || i === yrs.length - 1) s += `<text x="${x + bw / 2}" y="${H - 9}" text-anchor="middle">${y}</text>`;
  });
  s += "</svg>";
  const [blo, bhi] = v.bootstrap_95.gbm_minus_seasonal, cont = validation.continuity_snpp_noaa20;
  $("trust").innerHTML = `<div class="card">
      <div class="legend" style="margin:0 0 6px"><span><span class="sw" style="background:${BAR}"></span>Recorded by VIIRS</span>
      <span><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="${C.ink}"/></svg> FireCal, rebuilt from MODIS</span>
      <span><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="${TH.surface}" stroke="${C.modis}" stroke-width="2"/></svg> Raw MODIS</span></div>
      <div class="chart">${s}</div>
      <details class="more"><summary>All methods and statistics</summary>
        <table class="metrics"><tr><th>Method</th><th title="mean |log(1+predicted) − log(1+VIIRS)| by region-month; fixed before results">Monthly error ↓</th><th>Typical yearly error</th><th>Bias</th><th>Rank corr.</th></tr>
        ${Object.keys(METHOD).map((m) => `<tr class="${m === ch ? "chosen" : ""}"><td>${METHOD[m]}</td><td>${k[m].mae_log.toFixed(3)}</td><td>${k[m].annual_median_abs_pct.toFixed(0)}%</td><td>${k[m].bias_pct >= 0 ? "+" : ""}${k[m].bias_pct.toFixed(0)}%</td><td>${k[m].spearman.toFixed(2)}</td></tr>`).join("")}
        </table>
        <p class="note">Leave-one-year-out over ${v.years[0]}–${v.years.at(-1)}, ${v.n_train_rows.toLocaleString()} block-months. Method used before 2012: ${METHOD[ch]}. 95% year-bootstrap interval of the monthly-error difference (boosted model minus seasonal regression): [${blo.toFixed(3)}, ${bhi.toFixed(3)}]${bhi < 0 ? ", boosted model better" : ", includes zero, so not a conclusive difference"}.${cont.spearman == null ? "" : ` NOAA-20 vs S-NPP over ${cont.months} shared months: ${(cont.noaa20_over_snpp_total * 100).toFixed(0)}% of the activity, rank correlation ${cont.spearman.toFixed(2)}.`}</p>
      </details>
    </div>`;
}
// How often a month reads "well above normal" (twice typical or more): raw records joined at 2012 versus FireCal.
function alarmStats() {
  const est = rows.map((r) => r.type === "estimated"), raw = rows.map((r, t) => (est[t] ? r.modis : r.value)), cal = rows.map((r) => r.value);
  let n = 0, a = 0, b = 0;
  for (let t = 0; t <= lastFull(); t++) {
    if (est[t] || cal[t] === null) continue;
    const mr = priorMedian(raw, t), mh = priorMedian(cal, t);
    if (!mr || !mh) continue;
    n++; if (cal[t]! / mr >= 2) a++; if (cal[t]! / mh >= 2) b++;
  }
  return { raw: Math.round((a / Math.max(1, n)) * 100), us: Math.round((b / Math.max(1, n)) * 100) };
}
function drawProof() {
  const el = document.getElementById("proofgrid");
  if (!el) return;
  const k = validation.terra_aqua.metrics, ch = validation.terra_aqua.chosen, A = alarmStats();
  const off = (m: string) => Math.exp(k[m].mae_log) - 1; // typical monthly error as a share
  const list: [string, number, boolean][] = [["Raw MODIS", off("unadjusted"), false], ["One correction factor", off("ratio"), false], ["FireCal", off(ch), true]];
  const max = Math.max(...list.map((r) => r[1])), lab = (x: number) => (x >= 1 ? `${(x + 1).toFixed(1)}× off` : `${Math.round(x * 100)}% off`);
  el.innerHTML = `
    <div class="pcard"><h3>${icon("bars")}Yearly totals</h3><div class="num">${k[ch].annual_median_abs_pct.toFixed(0)}%</div><p>typical error for a year it had not seen. Raw MODIS: <b>${k.unadjusted.annual_median_abs_pct.toFixed(0)}%</b>.</p></div>
    <div class="pcard"><h3>${icon("calendar")}Monthly values</h3><div class="hbars">${list.map(([n, x, us]) => `<div class="hb${us ? " us" : ""}"><span>${n}</span><i><u style="width:${Math.max(2.5, (x / max) * 100)}%"></u></i><b>${lab(x)}</b></div>`).join("")}</div><p>Typical error in a single month. Lower is better.</p></div>
    <div class="pcard"><h3>${icon("alert")}False alarms</h3><div class="num"><s>${A.raw}%</s>${icon("arrowr", 34)}${A.us}%</div><p>of months since 2012 read "well above normal". Raw records joined together: <b>${A.raw}%</b>. FireCal: <b>${A.us}%</b>.</p></div>`;
}

// ---------------- map ----------------
const map = DECK ? null : L.map("map", { preferCanvas: true, zoomSnap: 0.25, scrollWheelZoom: false }); // wheel zoom would trap page scrolling
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const [W, S, E, N] = meta.region.bbox as number[];
const tileLayer = L.layerGroup(), windLayer = L.layerGroup(), recentLayer = L.layerGroup(), rects = new Map<number, L.Rectangle>();
const esri = (path: string, o: L.TileLayerOptions = {}) => L.tileLayer(`${ESRI}${path}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, ...o });
// Three basemaps: a plain map, satellite imagery, and NASA's night lights (the hero image, as a map layer).
const BASE: Record<string, L.LayerGroup> = {
  map: L.layerGroup([esri("Canvas/World_Dark_Gray_Base", { attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors" }), esri("Canvas/World_Dark_Gray_Reference", { pane: "shadowPane" })]),
  sat: L.layerGroup([esri("World_Imagery", { attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" }), esri("Canvas/World_Dark_Gray_Reference", { pane: "shadowPane" })]),
  night: L.layerGroup([L.tileLayer("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png", { maxNativeZoom: 8, maxZoom: 16, attribution: "Night lights: NASA Black Marble, NASA GIBS" }), esri("Canvas/World_Dark_Gray_Reference", { pane: "shadowPane" })]),
};
const outline = L.rectangle([[S, W], [N, E]], { color: "#f6f0e8", weight: 1.2, opacity: 0.6, fill: false, dashArray: "4 5", interactive: false });
if (map) {
  BASE.map.addTo(map);
  map.fitBounds([[S, W], [N, E]], { padding: [6, 6] });
  outline.addTo(map); tileLayer.addTo(map); windLayer.addTo(map); recentLayer.addTo(map);
  for (const b of blocks) { const [w0, s0, e0, n0] = b.bounds; rects.set(b.id, L.rectangle([[s0, w0], [n0, e0]], { stroke: false, fillOpacity: 0, interactive: false }).addTo(tileLayer)); }
  document.querySelectorAll<HTMLButtonElement>("#basemaps button").forEach((btn) => (btn.onclick = () => {
    for (const k in BASE) map.removeLayer(BASE[k]);
    BASE[btn.dataset.b!].addTo(map);
    document.querySelectorAll("#basemaps button").forEach((x) => x.setAttribute("aria-pressed", String(x === btn)));
  }));
}
let shape: L.Layer | null = null;
const KX = 111.32 * Math.cos((((S + N) / 2) * Math.PI) / 180), KY = 110.95;
const centre = (b: Block) => [(b.bounds[0] + b.bounds[2]) / 2, (b.bounds[1] + b.bounds[3]) / 2];
const SEL = { color: "#f6f0e8", weight: 2, fillColor: "#f6f0e8", fillOpacity: 0.05, dashArray: "6 5", interactive: false };
function setShape(l: L.Layer | null) { if (!map) return; if (shape) map.removeLayer(shape); shape = l; if (l) l.addTo(map); }
function areaIds(k: string) {
  if (k === "all") return allIds();
  const [w, s, e, n] = meta.region.presets[k];
  return new Set(blocks.filter((b) => { const [x, y] = centre(b); return x >= w && x <= e && y >= s && y <= n; }).map((b) => b.id));
}
function choosePreset(k: string) {
  placeKey = k; selected = areaIds(k);
  placeName = k === "all" ? meta.region.short : k.replace(/ \(.+\)/, "");
  if (k === "all") setShape(null);
  else { const [w, s, e, n] = meta.region.presets[k]; setShape(L.rectangle([[s, w], [n, e]], SEL)); }
  render();
}
let lastClick: L.LatLng | null = null;
async function chooseCircle(ll: L.LatLng) {
  const rk = +$<HTMLInputElement>("radius").value;
  const sel = new Set(blocks.filter((b) => { const [x, y] = centre(b); return Math.hypot((x - ll.lng) * KX, (y - ll.lat) * KY) <= rk; }).map((b) => b.id));
  if (!sel.size) return;
  lastClick = ll; selected = sel; placeKey = "custom";
  placeName = `${rk} km around ${ll.lat.toFixed(2)}°N, ${Math.abs(ll.lng).toFixed(2)}°W`;
  setShape(L.circle(ll, { ...SEL, radius: rk * 1000 }));
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

// ---------------- now: recent fires, smoke drift, unusual squares, weather ----------------
type Wx = { speed: number[]; dir: number[]; gust: number[]; rh: number[] };
type Fire = { lat: number; lon: number; date: string; time: string; at: number; frp: number; platform: string; sensor: string; block: number; age: number; day: number; wx?: Wx; drift?: { km: number; to: string } };
let recent: Fire[] = [], yearFires: Fire[] = [];
const RECENT_DAYS = 7, NEW_DAYS = 2, DRIFT_H = 3, FRESH = "#d4541c", OLDER = "#c9a58c", SMOKE = "#e2d6c8";
const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const level = (frp: number) => (frp < 5 ? "low" : frp < 20 ? "moderate" : "high");
const flame = (fill: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${FLAME}" fill="${fill}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
function popupHtml(f: Fire) {
  const when = new Date(f.at).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), w = f.wx;
  return `<div class="pop"><h4>${icon("flame", 16)}Fire detected</h4><dl>
    <dt>When</dt><dd>${when} CT</dd><dt>Satellite</dt><dd>${f.platform} ${f.sensor}</dd><dt>Intensity</dt><dd>${f.frp.toFixed(1)} MW · ${level(f.frp)}</dd>
    ${w ? `<dt>Wind</dt><dd>${Math.round(w.speed[0])} mph from the ${compass(w.dir[0])}, gusts ${Math.round(w.gust[0])}</dd><dt>Humidity</dt><dd>${Math.round(w.rh[0])}%</dd>` : ""}
    ${f.drift ? `<dt>Smoke drift</dt><dd>${Math.round(f.drift.km)} km ${f.drift.to} in ${DRIFT_H} h</dd>` : ""}</dl>
    ${f.drift ? `<p>Drift follows the hourly forecast wind at this spot and assumes the fire is still burning.</p>` : ""}</div>`;
}
async function loadRecent() {
  // ponytail: reads the latest year's file only, so the 7-day window is short in the first week of January
  const all = await hotYear(LAST_YEAR), h = all[0] ?? [], ix = (k: string) => h.indexOf(k), jan1 = Date.parse(`${LAST_YEAR}-01-01T00:00Z`);
  yearFires = all.slice(1).filter((r) => r[ix("used")] === "1").map((r) => {
    const time = r[ix("time")].padStart(4, "0"), at = Date.parse(`${r[ix("date")]}T${time.slice(0, 2)}:${time.slice(2)}Z`);
    return { lat: +r[ix("lat")], lon: +r[ix("lon")], date: r[ix("date")], time, at, frp: +r[ix("frp")] || 0, platform: r[ix("platform")], sensor: r[ix("sensor")], block: +r[ix("block")], age: (OBS_END - at) / 864e5, day: (at - jan1) / 864e5 };
  });
  recent = yearFires.filter((f) => f.age < RECENT_DAYS).sort((a, b) => b.age - a.age);
  for (const f of recent) { // one flame per detection: larger for stronger fires, muted once older than two days
    const fresh = f.age < NEW_DAYS, size = f.frp < 5 ? 20 : f.frp < 20 ? 26 : 32;
    L.marker([f.lat, f.lon], { icon: L.divIcon({ className: "", html: `<span class="fpin">${flame(fresh ? FRESH : OLDER)}</span>`, iconSize: [size, size], iconAnchor: [size / 2, size * 0.82] }), keyboard: false, zIndexOffset: fresh ? 500 : 0 })
      .bindPopup(() => popupHtml(f), { maxWidth: 300, autoPanPaddingTopLeft: [70, 64], autoPanPaddingBottomRight: [16, 16] }).bindTooltip(`${dname(f.date)} · ${f.frp.toFixed(1)} MW · click for details`).addTo(recentLayer);
  }
}
// Smoke drift: follow the hourly forecast wind at each new fire for DRIFT_H hours.
// The plume starts wider for stronger fires and widens with distance and gustiness, so no two are alike.
async function loadDrift() {
  const fresh = recent.filter((f) => f.age < NEW_DAYS);
  if (!map || !fresh.length) return;
  try {
    const j = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${fresh.map((f) => f.lat.toFixed(3)).join(",")}&longitude=${fresh.map((f) => f.lon.toFixed(3)).join(",")}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m&forecast_hours=7&wind_speed_unit=mph&timezone=UTC`).then((r) => r.json());
    (Array.isArray(j) ? j : [j]).forEach((o: any, i: number) => { const H = o.hourly; if (H && fresh[i]) fresh[i].wx = { speed: H.wind_speed_10m, dir: H.wind_direction_10m, gust: H.wind_gusts_10m, rh: H.relative_humidity_2m }; });
  } catch { return; } // no forecast, no plumes
  for (const f of fresh) {
    const w = f.wx;
    if (!w) continue;
    let lat = f.lat, lon = f.lon, dist = 0;
    const line: [number, number][] = [[lat, lon]], left: [number, number][] = [], right: [number, number][] = [], half0 = 0.5 + Math.min(1.5, Math.sqrt(f.frp) / 4);
    for (let hr = 0; hr < DRIFT_H; hr++) {
      const mph = w.speed[hr] ?? 0, kmh = mph * 1.609, to = (((w.dir[hr] ?? 0) + 180) * Math.PI) / 180, gusty = Math.max(1, Math.min(2.5, (w.gust[hr] ?? mph) / Math.max(1, mph)));
      const an = Math.cos(to + Math.PI / 2), ae = Math.sin(to + Math.PI / 2); // unit vector across the wind (north, east)
      if (hr === 0) { left.push([lat + (half0 * an) / KY, lon + (half0 * ae) / KX]); right.push([lat - (half0 * an) / KY, lon - (half0 * ae) / KX]); }
      lat += (kmh * Math.cos(to)) / KY; lon += (kmh * Math.sin(to)) / KX; dist += kmh;
      const half = half0 + dist * 0.04 * gusty;
      left.push([lat + (half * an) / KY, lon + (half * ae) / KX]); right.push([lat - (half * an) / KY, lon - (half * ae) / KX]);
      line.push([lat, lon]);
    }
    const dN = (lat - f.lat) * KY, dE = (lon - f.lon) * KX, strong = Math.min(1, 0.6 + f.frp / 40);
    f.drift = { km: Math.hypot(dN, dE), to: compass((Math.atan2(dE, dN) * 180) / Math.PI) };
    for (let hr = 0; hr < DRIFT_H; hr++) // one segment per hour, thinning out as the smoke disperses
      L.polygon([left[hr], left[hr + 1], right[hr + 1], right[hr]], { stroke: false, fillColor: SMOKE, fillOpacity: 0.34 * strong * (1 - hr / (DRIFT_H + 0.6)), interactive: false }).addTo(windLayer);
    L.polyline(line, { color: SMOKE, weight: 1, opacity: 0.7, dashArray: "2 5", interactive: false }).addTo(windLayer);
    line.slice(1).forEach((pt) => L.circleMarker(pt, { radius: 1.8, stroke: false, fillColor: SMOKE, fillOpacity: 0.9, interactive: false }).addTo(windLayer)); // one dot per hour
  }
}
// Squares: is burning since the start of last month unusual for this block, against the same weeks in earlier years?
const unusual = new Map<number, number>();
function findUnusual() {
  const part = OBS_FRAC < 1, idx = part ? [T - 2, T - 1] : [T - 1], since = `1 ${MON[+M[idx[0]].slice(5) - 1]}`;
  for (const b of blocks) {
    const cal = monthly.blocks[b.id].cal, cur = idx.reduce((a, i) => a + (cal[i] ?? NaN), 0);
    const past: number[] = [];
    for (let k = 1; idx[0] - 12 * k >= 0; k++) { const v = idx.reduce((a, i) => a + (cal[i - 12 * k] ?? NaN) * (part && i === T - 1 ? OBS_FRAC : 1), 0); if (!Number.isNaN(v)) past.push(v); }
    if (Number.isNaN(cur) || past.length < 10) continue;
    const rank = past.filter((v) => v < cur).length / past.length;
    // ponytail: fixed rank and count thresholds; counts per 10 km block are small, so one or two detections are never flagged
    const cls = cur >= 3 && rank >= 0.9 ? 2 : cur >= 2 && rank >= 0.7 ? 1 : 0;
    unusual.set(b.id, cls);
    if (cls) rects.get(b.id)?.bindTooltip(`<b>${cls === 2 ? "Far above" : "Above"} usual</b><br/>${fmt(cur)} km²-days since ${since}<br/>usual: ${fmt(past.sort((x, y) => x - y)[past.length >> 1])}`, { sticky: true });
  }
  return `since ${since}`;
}
const HOT = ["", "#f2a020", "#d03b3b"];
const paintNow = () => rects.forEach((r, id) => { const c = unusual.get(id) ?? 0; r.options.interactive = !!c; r.setStyle(c ? { fillColor: HOT[c], fillOpacity: c === 2 ? 0.55 : 0.42 } : { fillOpacity: 0 }); });
const selCentre = (): [number, number] => {
  if (placeKey === "custom" && lastClick) return [lastClick.lat, lastClick.lng];
  const cs = blocks.filter((b) => selected.has(b.id)).map(centre);
  return [cs.reduce((a, c) => a + c[1], 0) / cs.length, cs.reduce((a, c) => a + c[0], 0) / cs.length];
};
// Plain rule, stated in Technical details: afternoon humidity, wind and the day's rain.
function spread(rh: number, wind: number, rain: number) {
  if (rain >= 0.1) return { word: "Low", tone: TONE.good };
  if (rh < 30 && wind >= 15) return { word: "High", tone: TONE.hot };
  if ((rh < 40 && wind >= 10) || rh < 25) return { word: "Elevated", tone: "#b26a00" };
  return { word: "Low", tone: TONE.good };
}
let nowToken = 0;
async function drawNow() {
  if (DECK) return;
  const tk = ++nowToken, mine = recent.filter((f) => selected.has(f.block)), fresh = mine.filter((f) => f.age < NEW_DAYS);
  const fires = `<h3>${LIVE ? "Right now" : "Latest satellite week"}<span>${icon("satellite", 15)} passes to ${dname(meta.observations_through)}</span></h3>
    <div class="nowrow"><span class="ib hot">${icon("flame", 22)}</span><span class="bignum">${mine.length}</span><span><b>fire detection${mine.length === 1 ? "" : "s"} in ${RECENT_DAYS} days</b><br/>${fresh.length} in the last ${NEW_DAYS} days</span></div>`;
  $("now").innerHTML = fires + `<p class="note">Loading weather…</p>`;
  const [lat, lon] = selCentre();
  let wx = `<p class="note">Weather is unavailable right now.</p>`;
  try {
    const j = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=relative_humidity_2m,wind_speed_10m,precipitation&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto&forecast_days=5`).then((r) => r.json());
    if (tk !== nowToken) return;
    const c = j.current, H = j.hourly, days = [...new Set((H.time as string[]).map((t) => t.slice(0, 10)))];
    const daily = days.map((d) => {
      let rh = 100, wind = 0, rain = 0;
      (H.time as string[]).forEach((t, i) => { if (!t.startsWith(d)) return; rain += H.precipitation[i] ?? 0; const hr = +t.slice(11, 13); if (hr >= 12 && hr <= 18) { rh = Math.min(rh, H.relative_humidity_2m[i]); wind = Math.max(wind, H.wind_speed_10m[i]); } });
      return { d, rh, wind, ...spread(rh, wind, rain) };
    });
    const dir = c.wind_direction_10m, t0 = daily[0];
    wx = `<div class="nowrow"><span class="ib" style="transform:rotate(${dir + 180}deg)" title="The wind is blowing this way">${icon("arrow", 22)}</span><span><b>Wind ${Math.round(c.wind_speed_10m)} mph from the ${compass(dir)}</b><br/>gusts ${Math.round(c.wind_gusts_10m)} mph</span></div>
      <div class="nowrow two"><span>${icon("droplet", 18)}Humidity <b>${Math.round(c.relative_humidity_2m)}%</b></span><span>${icon("thermo", 18)}<b>${Math.round(c.temperature_2m)}°F</b></span></div>
      <div class="spread"><span class="led" style="background:${t0.tone}"></span>Fire-spread conditions today: <b style="color:${t0.tone}">${t0.word}</b></div>
      <div class="days">${daily.map((x, i) => `<div><span>${i ? new Date(`${x.d}T12:00`).toLocaleDateString("en-US", { weekday: "short" }) : "Today"}</span><b><i class="led" style="background:${x.tone}"></i>${x.word}</b><small>${Math.round(x.rh)}% humid<br/>${Math.round(x.wind)} mph</small></div>`).join("")}</div>
      <p class="note">A simple rule from afternoon humidity, wind and rain. Not an official forecast.</p>`;
  } catch { if (tk !== nowToken) return; }
  $("now").innerHTML = fires + wx;
}

// ---------------- replay: 25 years on the map, scrubbed from the strip under it ----------------
let hist: number | null = null, playing = 0;
const FAINT = 0.5; // rebuilt months give every block a small fraction; below this a block is left dark
const histColor = scale(blocks.flatMap((b) => monthly.blocks[b.id].cal).filter((v) => v !== null && v >= FAINT));
const T0 = M.findIndex((m) => m >= "2001-01");
function drawStrip() {
  const el = document.getElementById("strip");
  if (!el) return;
  const color = scale(rows.map((r) => r.value)), Wd = 1000, bw = Wd / T;
  let s = `<svg viewBox="0 0 ${Wd} 28" preserveAspectRatio="none" role="img" aria-label="Burning in this area, one stripe per month">`;
  rows.forEach((r, t) => (s += `<rect x="${(t * bw).toFixed(2)}" y="0" width="${(bw + 0.4).toFixed(2)}" height="28" fill="${r.value === null ? TH.zero : color(r.value)}"/>`));
  s += `</svg><div class="yrs">${rows.filter((r) => r.month.endsWith("-01") && (+r.month.slice(0, 4) % 5 === 0 || r.month.startsWith("2012"))).map((r) => `<span style="left:${((r.t + 0.5) / T) * 100}%"${r.month.startsWith("2012") ? ' class="k"' : ""}>${r.month.slice(0, 4)}</span>`).join("")}</div><i class="ph" id="ph" hidden></i>`;
  el.innerHTML = s;
}
function setHist(t: number | null) {
  if (!map) return;
  hist = t;
  const lab = $("maplabel"), ph = $("ph");
  if (t === null) {
    stopPlay(); paintNow(); map.addLayer(recentLayer); map.addLayer(windLayer); lab.hidden = true; if (ph) ph.hidden = true;
    return;
  }
  map.removeLayer(recentLayer); map.removeLayer(windLayer);
  rects.forEach((r, id) => { const v = monthly.blocks[id].cal[t]; r.options.interactive = false; r.setStyle(v !== null && v >= FAINT ? { fillColor: histColor(v), fillOpacity: 0.85 } : { fillOpacity: 0 }); });
  const r = rows[t], c = r.value !== null && r.median !== null ? classify(r.value, r.median, r.month) : null;
  lab.hidden = false;
  lab.innerHTML = `<div class="d">${MONTH[+r.month.slice(5) - 1]} <b>${r.month.slice(0, 4)}</b></div>
    <div class="s">${r.value === null ? "No satellite record" : `${fmt(r.value)} km²-days in ${placeName}`}${c && c.r !== null ? ` · <b style="color:${c.tone}">${c.word}</b>` : ""}${r.type === "estimated" ? " · rebuilt from the older satellite" : ""}</div>
    <button type="button" id="histexit" class="ghost">${icon("close", 16)}Back to ${LIVE ? "now" : "the latest week"}</button>`;
  $("histexit").onclick = () => setHist(null);
  if (ph) { ph.hidden = false; ph.style.left = `${((t + 0.5) / T) * 100}%`; }
}
function stopPlay() { clearInterval(playing); playing = 0; const b = document.getElementById("play"); if (b) b.innerHTML = `${icon("play")}<span>Replay 25 years</span>`; }
function startPlay() {
  let t = hist === null || hist >= T - 1 ? T0 : hist;
  setHist(t);
  $("play").innerHTML = `${icon("pause")}<span>Pause</span>`;
  playing = window.setInterval(() => { if (++t >= T) { stopPlay(); return; } setHist(t); }, 110);
}
if (map) {
  const strip = $("strip"), at = (e: PointerEvent | MouseEvent) => { const b = strip.getBoundingClientRect(); return Math.max(0, Math.min(T - 1, Math.floor(((e.clientX - b.left) / b.width) * T))); };
  $("play").onclick = () => (playing ? stopPlay() : startPlay());
  strip.onpointerdown = (e) => { strip.setPointerCapture(e.pointerId); stopPlay(); setHist(at(e)); };
  strip.onpointermove = (e) => { if (e.buttons) setHist(at(e)); else showTip(tipHtml(rows[at(e)]), e); };
  strip.onpointerleave = hideTip;
  strip.onkeydown = (e) => { const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (d) { stopPlay(); setHist(Math.max(0, Math.min(T - 1, (hist ?? T - 1) + d))); } };
}

// ---------------- search and "use my location" ----------------
if (map) {
  const HINT = "Search, pick a place or click the map. Click a fire for details.", say = (m: string) => ($("searchmsg").textContent = m);
  const goTo = (ll: L.LatLng | null) => {
    if (!ll || ll.lng < W || ll.lng > E || ll.lat < S || ll.lat > N) return false;
    say(HINT); chooseCircle(ll); map.setView(ll, 10);
    return true;
  };
  $<HTMLFormElement>("search").onsubmit = async (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>("q").value.trim(), m = q.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!q) return;
    let ll: L.LatLng | null = m ? L.latLng(+m[1], +m[2]) : null;
    if (!m) try { // place search: OpenStreetMap Nominatim, limited to the region
      const j = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&bounded=1&viewbox=${W},${N},${E},${S}&q=${encodeURIComponent(q)}`).then((r) => r.json());
      if (j[0]) ll = L.latLng(+j[0].lat, +j[0].lon);
    } catch { /* falls through to "couldn't find" */ }
    if (!goTo(ll)) say(`Couldn't find "${q}" inside ${meta.region.short}. Try a town name, or click the map.`);
  };
  const locate = () => {
    $("app").scrollIntoView({ behavior: "smooth" });
    if (!navigator.geolocation) return say("This browser can't share a location. Search or click the map instead.");
    say("Finding you…");
    navigator.geolocation.getCurrentPosition(
      (pos) => { if (!goTo(L.latLng(pos.coords.latitude, pos.coords.longitude))) { choosePreset("all"); say(`You are outside the prototype's coverage. Showing ${meta.region.short}.`); } },
      () => say("Location wasn't shared. Search or click the map instead."));
  };
  // the hero, the tool, the map and the footer all carry these buttons
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-locate]")) locate();
    else if (t.closest("[data-go]")) setTimeout(() => $("q").focus({ preventScroll: true }), 700);
  });
}

// ---------------- hero example: the verdict for each preset area in turn, so the purpose shows without a click ----------------
let heroBox: number[] | null = null;
function liveCard() {
  const el = document.getElementById("livecard");
  if (!el) return;
  const keep = selected;
  const items = ["all", ...Object.keys(meta.region.presets)].map((k) => {
    selected = areaIds(k);
    const rs = computeRows(), r = rs[rs[T - 1].partial ? T - 2 : T - 1], fires = recent.filter((f) => selected.has(f.block)).length;
    return { k, r, fires, name: k === "all" ? (meta.region.short as string) : k.replace(/ \(.+\)/, ""), c: r.value === null ? null : classify(r.value, r.median, r.month) };
  }).filter((x) => x.c);
  selected = keep;
  if (!items.length) { el.hidden = true; return; }
  let i = 0;
  const show = () => {
    const x = items[i % items.length], c = x.c!, mon = MONTH[+x.r.month.slice(5) - 1];
    heroBox = x.k === "all" ? null : meta.region.presets[x.k];
    el.innerHTML = `<span class="lc-tag"><i class="led"></i>Example · ${mon} ${x.r.month.slice(0, 4)}</span>
      <span class="lc-place">${icon("target", 16)}${x.name}</span>
      <span class="lc-word" style="color:${c.tone}">${c.word}</span>
      <span class="lc-line">${c.r !== null ? `<b>${c.mult}</b> a typical ${mon} · ` : ""}<b>${x.fires}</b> fire detection${x.fires === 1 ? "" : "s"} in the last 7 days</span>
      <span class="lc-dots">${items.map((_, j) => `<i${j === i % items.length ? ' class="on"' : ""}></i>`).join("")}</span>`;
    el.onclick = () => choosePreset(x.k);
  };
  show();
  if (!STILL && items.length > 1) setInterval(() => { el.classList.add("out"); setTimeout(() => { i++; show(); el.classList.remove("out"); }, 260); }, 3800);
}

// ---------------- hero: the region at night from orbit. Heat builds and fades where this year's fires were detected. ----------------
function heroScene() {
  const cv = document.getElementById("sky") as HTMLCanvasElement | null;
  if (!cv) return;
  const ctx = cv.getContext("2d")!, IMG = { w: 1920, h: 1080, W: -101, E: -93, S: 27.2, N: 31.7, px: 0.68 }; // extent of night.jpg; px matches its object-position
  const sprite = (stops: [number, string][]) => {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d")!, gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    stops.forEach(([o, col]) => gr.addColorStop(o, col)); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return c;
  };
  const core = sprite([[0, "rgba(255,240,210,1)"], [0.3, "rgba(255,170,80,.6)"], [1, "rgba(255,120,40,0)"]]);
  const heat = sprite([[0, "rgba(255,96,32,.9)"], [0.5, "rgba(230,70,20,.35)"], [1, "rgba(200,50,10,0)"]]);
  let cw = 0, ch = 0, sc = 1, ox = 0, oy = 0;
  const fit = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    cw = cv.clientWidth; ch = cv.clientHeight; cv.width = cw * dpr; cv.height = ch * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sc = Math.max(cw / IMG.w, ch / IMG.h); ox = (cw - IMG.w * sc) * IMG.px; oy = (ch - IMG.h * sc) / 2;
    (ctx as any).letterSpacing = "1.2px"; // where supported
  };
  const xy = (lon: number, lat: number): [number, number] => [ox + ((lon - IMG.W) / (IMG.E - IMG.W)) * IMG.w * sc, oy + ((IMG.N - lat) / (IMG.N - IMG.S)) * IMG.h * sc];
  const put = (img: HTMLCanvasElement, x: number, y: number, size: number, a: number) => { ctx.globalAlpha = a; ctx.drawImage(img, x - size / 2, y - size / 2, size, size); };
  const span = Math.max(1, ...yearFires.map((f) => f.day)) + 8, LOOP = 30, HAZE = 16, SPARK = 2.5, PASS = 12, JAN1 = Date.parse(`${LAST_YEAR}-01-01T00:00Z`);
  const frame = (ms: number) => {
    const ts = ms / 1000, d = STILL ? span - 8 : ((ts % LOOP) / LOOP) * span, k = Math.max(0.75, Math.min(1.5, sc * 1.5)), roomy = cw >= 700;
    ctx.clearRect(0, 0, cw, ch);
    const [x0, y0] = xy(W, N), [x1, y1] = xy(E, S);
    ctx.globalAlpha = 1; ctx.strokeStyle = "rgba(240,239,236,.3)"; ctx.lineWidth = 1; ctx.setLineDash([4, 6]); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
    ctx.font = "600 10px Archivo, sans-serif"; ctx.fillStyle = "rgba(240,239,236,.62)"; if (roomy) ctx.fillText("GREATER HOUSTON WATCH AREA", x0, y0 - 8);
    if (heroBox) { // the area the example card is showing
      const [bx0, by0] = xy(heroBox[0], heroBox[3]), [bx1, by1] = xy(heroBox[2], heroBox[1]);
      ctx.strokeStyle = "rgba(255,180,84,.9)"; ctx.lineWidth = 1.5; ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
    }
    ctx.globalCompositeOperation = "lighter";
    for (const f of yearFires) {
      const a = d - f.day;
      if (a < -HAZE || a > HAZE) continue;
      const [x, y] = xy(f.lon, f.lat);
      put(heat, x, y, (30 + Math.sqrt(f.frp) * 5) * k, (1 - Math.abs(a) / HAZE) * 0.055); // heat of the weeks around each detection
      if (a < 0 || a >= SPARK) continue;
      const e = 1 - a / SPARK; // the detection itself: a brief spark and a ring
      put(core, x, y, (6 + Math.sqrt(f.frp) * 1.4) * k, e);
      ctx.globalAlpha = e * 0.5; ctx.strokeStyle = "#ffcf8a"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, (3 + (1 - e) * 11) * k, 0, 6.283); ctx.stroke();
    }
    for (const f of recent) { // the latest week's fires stay lit
      const [x, y] = xy(f.lon, f.lat);
      put(core, x, y, 9 * k, 0.95);
      if (f.age >= NEW_DAYS || STILL) continue;
      const rr = (((ts * 0.4 + f.lon * 7) % 1) + 1) % 1;
      ctx.globalAlpha = (1 - rr) * 0.4; ctx.strokeStyle = "#ffb454"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, (4 + rr * 12) * k, 0, 6.283); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    const p = (ts % PASS) / PASS; // a satellite pass: the scan line crosses north to south
    if (p < 0.5 && !STILL) {
      const yl = -80 + (p / 0.5) * (ch + 160), tilt = cw * 0.05, xs = Math.min(cw - 150, x1 + 70), ys = yl + tilt - (xs / cw) * 2 * tilt;
      const band = ctx.createLinearGradient(0, yl - 90, 0, yl); band.addColorStop(0, "rgba(140,200,255,0)"); band.addColorStop(1, "rgba(140,200,255,.08)");
      ctx.globalAlpha = 1; ctx.fillStyle = band; ctx.beginPath(); ctx.moveTo(0, yl + tilt); ctx.lineTo(cw, yl - tilt); ctx.lineTo(cw, yl - tilt - 90); ctx.lineTo(0, yl + tilt - 90); ctx.fill();
      ctx.strokeStyle = "rgba(170,215,255,.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, yl + tilt); ctx.lineTo(cw, yl - tilt); ctx.stroke();
      ctx.save(); ctx.translate(xs, ys); ctx.rotate(-0.35); ctx.fillStyle = "#f0efec"; ctx.fillRect(-4, -6, 8, 12); ctx.fillStyle = "#7fb4f5"; ctx.fillRect(-17, -4, 11, 8); ctx.fillRect(6, -4, 11, 8); ctx.restore();
      ctx.fillStyle = "rgba(240,239,236,.8)"; ctx.fillText("NOAA-20 · VIIRS", xs + 24, ys + 4);
    }
    ctx.globalAlpha = 1;
    if (!roomy) return; // caption under the watch area: what is glowing, and when
    const when = STILL ? `TO ${dname(meta.observations_through).toUpperCase()}` : `${MONTH[new Date(JAN1 + Math.min(d, span - 8) * 864e5).getUTCMonth()].toUpperCase()} ${LAST_YEAR}`;
    ctx.font = "600 11px Archivo, sans-serif"; ctx.fillStyle = "#ffb454"; ctx.beginPath(); ctx.arc(x0 + 4, y1 + 16, 3.5, 0, 6.283); ctx.fill();
    ctx.fillStyle = "rgba(240,239,236,.72)"; ctx.fillText("FIRE ACTIVITY SEEN FROM ORBIT", x0 + 14, y1 + 20);
    ctx.fillStyle = "#ffd089"; ctx.fillText(when, x0 + 22 + ctx.measureText("FIRE ACTIVITY SEEN FROM ORBIT").width, y1 + 20);
  };
  fit(); addEventListener("resize", fit);
  if (STILL) { frame(0); return; }
  let on = true;
  new IntersectionObserver((es) => (on = es[0].isIntersecting)).observe(cv);
  const loop = (ms: number) => { if (on && !document.hidden) frame(ms); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}


// ---------------- hero: the 25-year burning wall. Raw records jump in 2012; FireCal puts them on one scale. ----------------
function heroWall() {
  const el = document.getElementById("wallgrid"), note = document.getElementById("wallnote");
  if (!el || !note) return;
  const keep = selected; selected = allIds(); const R = computeRows(); selected = keep;
  const raw = R.map((r) => (r.month >= "2012-01" ? r.npp ?? r.n20 ?? r.modis : r.modis));
  const harm = R.map((r) => r.value);
  const Y0 = +M[0].slice(0, 4), Y1 = +LAST_YEAR, NY = Y1 - Y0 + 1;
  const yearSum = (v: Num[]) => Array.from({ length: NY }, (_, i) => v.reduce<number>((a, x, t) => a + (+M[t].slice(0, 4) === Y0 + i && x !== null ? x : 0), 0));
  const rawY = yearSum(raw), harmY = yearSum(harm);
  const full = (i: number) => i > 0 && i < NY - 1;
  const ymax = Math.max(...rawY.filter((_, i) => full(i)), ...harmY.filter((_, i) => full(i)));
  const vmax = Math.log1p(Math.max(...(raw.filter((v) => v !== null) as number[]), ...(harm.filter((v) => v !== null) as number[])));
  const stops: [number, number[]][] = [[0, [43, 29, 23]], [0.22, [86, 34, 18]], [0.45, [158, 50, 24]], [0.65, [216, 88, 38]], [0.82, [245, 150, 68]], [1, [255, 228, 170]]];
  const col = (v: Num) => {
    if (v === null) return "#1a120f";
    const x = Math.min(1, Math.log1p(v) / vmax); let i = 1; while (i < stops.length - 1 && stops[i][0] < x) i++;
    const [a, ca] = stops[i - 1], [b, cb] = stops[i], k = (x - a) / (b - a || 1);
    return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * k)).join(",")})`;
  };
  const W = 640, GX = 26, cw = (W - GX) / NY, ch = 14, BH = 64, TOP = 18, GY = TOP + BH + 8, H = GY + 12 * ch + 22;
  const xi = (i: number) => GX + i * cw;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly burning in Greater Houston, ${Y0} to ${Y1}">`;
  harmY.forEach((_, i) => (s += `<rect class="wb" data-i="${i}" x="${(xi(i) + 2).toFixed(1)}" y="${TOP}" width="${(cw - 4).toFixed(1)}" height="${BH}" rx="1.5" fill="${full(i) ? "#e0602a" : "#6b4a3a"}"/>`));
  R.forEach((r, t) => {
    const yr = +r.month.slice(0, 4) - Y0, mo = +r.month.slice(5) - 1;
    s += `<rect class="wc" data-t="${t}" x="${(xi(yr) + 1).toFixed(1)}" y="${(GY + mo * ch + 1).toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${ch - 2}" rx="1.5"/>`;
  });
  "JFMAMJJASOND".split("").forEach((m, i) => (s += `<text x="${GX - 9}" y="${GY + i * ch + ch - 3.5}" text-anchor="end">${m}</text>`));
  for (let i = 0; i < NY; i++) { const y = Y0 + i; if ((y % 5 === 0 && Y1 - y >= 2) || y === 2012 || y === Y1) s += `<text x="${xi(i) + cw / 2}" y="${H - 6}" text-anchor="middle"${y === 2012 ? ' class="k"' : ""}>${y === 2012 || y === Y1 || y === Y0 ? y : `'${String(y).slice(2)}`}</text>`; }
  const x12 = xi(2012 - Y0);
  s += `<line class="mk" x1="${x12}" x2="${x12}" y1="${TOP - 6}" y2="${GY + 12 * ch + 2}"/><text class="k" x="${x12 + 6}" y="${TOP - 4}">VIIRS JOINS</text>`;
  el.innerHTML = s + "</svg>";
  const cells = el.querySelectorAll<SVGRectElement>(".wc"), bars = el.querySelectorAll<SVGRectElement>(".wb"), btns = document.querySelectorAll<HTMLButtonElement>("#wallmode button");
  const jump = REG.jump ? `${REG.jump.toFixed(1)}×` : "several times";
  const apply = (mode: "raw" | "harm") => {
    const v = mode === "raw" ? raw : harm, y = mode === "raw" ? rawY : harmY;
    cells.forEach((c, t) => (c.style.fill = col(v[t])));
    bars.forEach((b, i) => (b.style.transform = `scaleY(${Math.max(0.02, Math.min(1, y[i] / ymax)).toFixed(3)})`));
    btns.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === mode)));
    note.innerHTML = mode === "raw"
      ? `${icon("alert", 18)}<span><b>2012 looks like a jump in fire activity.</b> It isn't: VIIRS, flying since 2012, detects smaller fires and reports ${jump} more burning than MODIS.</span>`
      : `${icon("shield", 18)}<span><b>One scale, ${Y0}–${Y1}.</b> FireCal rebuilds the MODIS years on the VIIRS scale. Tested on 15 years it had not seen.</span>`;
  };
  let mode: "raw" | "harm" = "raw", auto = 0;
  apply(mode);
  btns.forEach((b) => (b.onclick = () => { clearInterval(auto); auto = -1; mode = b.dataset.v as typeof mode; apply(mode); }));
  if (STILL) return;
  const start = () => { if (auto) return; auto = window.setInterval(() => { mode = mode === "raw" ? "harm" : "raw"; apply(mode); }, 4200); };
  setTimeout(start, 1800);
}
function heroTicker() {
  const el = document.getElementById("ticker");
  if (!el) return;
  const items = [
    `<i>●</i> NASA FIRMS passes to <b>${dname(meta.observations_through)}</b>`,
    `<b>${Number(meta.n_hotspots).toLocaleString()}</b> detections since Nov 2000`,
    `<b>4</b> satellites: Terra · Aqua · Suomi NPP · NOAA-20`,
    `<b>${recent.length}</b> fire detections in the last ${RECENT_DAYS} days`,
    `Suomi NPP stopped <b>${dname(meta.snpp_end)}</b>: NOAA-20 carries VIIRS`,
    `Every detection on one <b>1 km</b> grid`,
    `Missing data stays <b>missing</b>, never zero`,
  ].map((x) => `<span>${x}</span>`).join("");
  el.innerHTML = `<div class="tk">${items}${items}</div>`;
}
function consoleBar() {
  const el = document.getElementById("consolebar");
  if (!el) return;
  const mine = recent.filter((f) => selected.has(f.block)).length;
  el.innerHTML = `<span><i class="led live"></i><b>${LIVE ? "Live" : "Latest"}</b></span><span>NASA FIRMS · MODIS · VIIRS</span><span>Passes to <b>${dname(meta.observations_through)}</b></span><span><b>${mine}</b> detections · ${RECENT_DAYS} days</span><span>Area <b>${placeName}</b></span>`;
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
  txt("updated", dname(meta.observations_through));
  $("tech").innerHTML = `
  <p><b>Unit.</b> One km²-day is one 1 km × 1 km grid square where a satellite detected fire on one day. It measures satellite-observed burning, not separate fires, burned area or ignition risk.</p>
  <p><b>Data.</b> NASA FIRMS active-fire detections for ${meta.region.name}: MODIS Collection 6.1 (Terra and Aqua, since Nov 2000) and VIIRS 375 m Collection 2 (Suomi NPP from 2012 until it stopped on ${dname(meta.snpp_end)}; NOAA-20 since 2018). ${Number(meta.n_hotspots).toLocaleString()} detections, ${Number(meta.n_qualifying).toLocaleString()} counted.</p>
  <p><b>What counts.</b> Detections that are not low confidence and not static sources such as refinery flares (FIRMS type 2). Excluded records stay in the downloads.</p>
  <p><b>The model.</b> A seasonal Poisson regression gives a baseline; gradient-boosted trees learn a correction from MODIS activity, Terra and Aqua separately, neighbouring areas, the months before and after, fire intensity, season and location. Beyond the largest training values the top-of-range ratio is held constant.</p>
  <p><b>Testing.</b> Leave-one-year-out over the overlap years, against raw MODIS and a single ratio. The monthly error measure was fixed before results; whichever method wins is used before 2012.</p>
  <p><b>Accuracy figures.</b> Monthly error is the mean absolute difference of log(1 + value) between rebuilt and recorded regional months; the percentages shown are exp(error) − 1. "False alarms" counts months from 2012 on that are at least twice the median of the same month in all earlier years, once with MODIS and VIIRS records joined as they are and once with FireCal.</p>
  <p><b>Map squares.</b> Each 10 km square compares burning since the start of last month with the same weeks in every earlier year: "above usual" is higher than 70% of those years, "far above" higher than 90%.</p>
  <p><b>Smoke drift.</b> For each fire detected in the last two days, the path follows the hourly 10 m forecast wind at that location for three hours (Open-Meteo), one dot per hour. The plume starts wider for stronger fires and widens with distance and gustiness. It assumes the fire is still burning. It is an indicator, not a dispersion model.</p>
  <p><b>Fire-spread conditions.</b> From afternoon (12:00–18:00) forecast values: High if humidity is under 30% with wind of 15 mph or more; Elevated if humidity is under 40% with wind of 10 mph or more, or humidity under 25%; Low otherwise or with 0.1 in of rain.</p>
  <p><b>Limits.</b> Clouds and smoke hide fires from every sensor. Pre-2012 estimates assume the 2012–2026 MODIS–VIIRS relationship held earlier. The newest months use near-real-time data that NASA later reprocesses.</p>`;
  $("foot").innerHTML = `<h2>Is fire activity in your area normal?</h2>
  <div class="cta"><button type="button" class="pill big accent" data-locate>${icon("locate")}Use my location</button><a class="pill big" href="#app" data-go>${icon("search")}Search an area</a></div>
  <div class="brand"><span class="logo">${LOGO}</span><b>FIRECAL</b></div>
  <p>Team BlazePatrol · NASA Space Apps Challenge 2026, <i>Harmonization of MODIS and VIIRS Hot Spots</i><br/>
  <a href="deck.html">7-slide summary</a> (<a href="FireCal-deck.pdf">PDF</a>) · <a href="https://github.com/blazepatrol/firecal">Source code</a>, Apache-2.0</p>
  <p class="fine">Fire data: NASA FIRMS (LANCE, ESDIS), through ${dname(meta.observations_through)}. Night image and night map layer: NASA Black Marble, via NASA GIBS. Basemaps © Esri, Maxar, Earthstar Geographics, © OpenStreetMap contributors. Place search © OpenStreetMap (Nominatim). Weather: Open-Meteo.</p>
  <p class="fine">SI disclosure: the code, charts, icons and logo were generated with SI tools, directed, reviewed and tested by the team. Fire data and the night image are NASA's.</p>`;
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
  fromEl.onchange = toEl.onchange = () => { from = fromEl.value || M[0]; to = toEl.value || M[T - 1]; if (from > to) [from, to] = [to, from]; };
}

// ---------------- use cases: each role gets FireCal's current result for a real area ----------------
function useCases() {
  const tabs = document.getElementById("usetabs"), panel = document.getElementById("usepanel"), list = document.getElementById("uselist");
  if (!tabs && !list) return;
  const P = Object.keys(meta.region.presets), pick = (re: RegExp) => P.find((k) => re.test(k)) ?? "all";
  // icon, role, area, question, facts shown, headline fact, what the user does with it
  const defs: [string, string, string, string, string[], string, string][] = [
    ["beacon", "Emergency management", "all", "Is this month's fire activity normal?", ["verdict", "fires"], "verdict", "Decide whether to raise readiness or stand down."],
    ["tree", "Forestry and land management", pick(/forest/i), "When is burn season here?", ["peak", "verdict"], "peak", "Schedule prescribed burns in the usual window and keep a burn history."],
    ["sprout", "Agriculture", pick(/prairie|coast/i), "Is burning heavier than usual this season?", ["verdict", "peak"], "verdict", "Track residue-burning seasons and compare years fairly."],
    ["bolt", "Electric utilities", pick(/core/i), "Is fire activity near our lines above usual?", ["verdict", "squares"], "verdict", "Send patrols where activity is above its usual level."],
    ["umbrella", "Insurance and risk", "all", "Has fire activity changed in 25 years?", ["trend", "busiest"], "trend", "Assess exposure on 25 comparable years instead of 15."],
    ["cloud", "Air quality and public health", "all", "When should we expect smoke?", ["peak", "quiet"], "peak", "Plan smoke advisories around the burning seasons."],
  ];
  const keep = selected, firstB = (t: string) => t.match(/<b>(.*?)<\/b>/)?.[1] ?? "";
  const items = defs.map(([ic, role, k, q, facts, head, act]) => {
    selected = areaIds(k); rows = computeRows();
    const r = rows[lastFull()], c = r.value === null ? null : classify(r.value, r.median, r.month), mon = MONTH[+r.month.slice(5) - 1];
    const ins = Object.fromEntries(insightLines().map((l) => l.split("|") as [string, string]));
    const ids = [...selected], flagged = ids.filter((id) => unusual.get(id)).length;
    const F: Record<string, [string, string]> = {
      verdict: ["gauge", c ? `${mon} ${r.month.slice(0, 4)}: <b>${c.word}</b>${c.r !== null ? `, ${c.mult} a typical ${mon}` : ""}.` : ""],
      fires: ["flame", `<b>${recent.filter((f) => selected.has(f.block)).length}</b> fire detections in the last ${RECENT_DAYS} days.`],
      peak: ["calendar", ins.flame ?? ""], trend: ["trend", ins.trend ?? ""], busiest: ["bars", ins.bars ?? ""], quiet: ["moon", ins.moon ?? ""],
      squares: ["grid", `<b>${flagged}</b> of ${ids.length} map squares are above their usual level.`],
    };
    const big: [string, string] = head === "verdict" ? (c ? [c.word, c.tone] : ["No reading", TH.mute]) : [firstB(F[head][1]) || "–", TH.ink];
    return { ic, role, k, q, act, big, area: k === "all" ? (meta.region.short as string) : k.replace(/ \(.+\)/, ""), facts: facts.map((f) => F[f]).filter((f) => f[1]) };
  });
  selected = keep; rows = computeRows();
  if (tabs && panel) {
    const show = (i: number) => {
      const x = items[i];
      tabs.querySelectorAll("button").forEach((b, j) => b.setAttribute("aria-selected", String(j === i)));
      panel.innerHTML = `<p class="uq">${x.q}</p><span class="uarea">${icon("target", 16)}${x.area}</span><div class="uword" style="color:${x.big[1]}">${x.big[0]}</div>
        <ul class="ufacts">${x.facts.map(([fi, t]) => `<li>${icon(fi, 18)}<span>${t}</span></li>`).join("")}</ul>
        <p class="udo"><b>Use:</b> ${x.act}</p><a class="pill" href="#app">${icon("target", 18)}Open ${x.area} in the tool</a>`;
      (panel.querySelector("a.pill") as HTMLElement).onclick = () => choosePreset(x.k);
    };
    tabs.innerHTML = items.map((x) => `<button type="button" role="tab">${icon(x.ic)}${x.role}</button>`).join("");
    tabs.querySelectorAll("button").forEach((b, i) => (b.onclick = () => show(i)));
    show(0);
  }
  if (list) list.innerHTML = items.slice(0, 4).map((x) => `<div><span class="ib">${icon(x.ic, 24)}</span><b>${x.role}</b><p>${x.q}</p><p class="ans" style="color:${x.big[1]}">${x.big[0]}</p><p class="fine">${x.area}</p></div>`).join("");
}

function render() {
  rows = computeRows();
  txt("calhead", `${placeName}, ${M[0].slice(0, 4)}–${LAST_YEAR}`);
  drawPlaces(); drawAnswer(); drawCalendar(); drawInsights(); drawStory(); drawNow(); drawStrip(); consoleBar();
  $("detail").innerHTML = detailHtml(rows[lastFull()]) + `<div class="note" style="margin-top:6px">Hover any month for its details.</div>`;
  if (hist !== null) setHist(hist);
}
rows = computeRows();
REG = annualSeries();
drawStatic(); drawTrust(); drawProof(); drawVersus(); runVersus(); countUp();
const since = findUnusual();
await loadRecent();
if (DECK) { deck(); useCases(); heroScene(); }
else {
  paintNow();
  $("maplegend").innerHTML = `<span><span class="lg">${flame(FRESH)}</span>Fire, last ${NEW_DAYS} days</span><span><span class="lg">${flame(OLDER)}</span>${NEW_DAYS + 1}–${RECENT_DAYS} days ago</span><span>Larger flame = stronger fire</span>
    <span><i class="smoke"></i>Smoke drift, next ${DRIFT_H} h</span>
    <span class="brk">Burning ${since}, compared with the same weeks in earlier years:</span><span><i class="tile" style="background:${HOT[1]}"></i>above usual</span><span><i class="tile" style="background:${HOT[2]}"></i>far above usual</span>`;
  render();
  liveCard(); useCases(); heroWall(); heroTicker();
  loadDrift(); // plumes appear once the wind forecast arrives
}

function deck() {
  choosePreset("all"); // fills the calendar slide
  storyMode = "harm"; drawStory(); $("story-harm").innerHTML = $("storychart").innerHTML;
  document.body.classList.add("ready");
}
