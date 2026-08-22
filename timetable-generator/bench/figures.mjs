#!/usr/bin/env node
// Turns the study's results into figures: standalone SVGs for a LaTeX document, and one
// self-contained HTML page for reading them.
//
// No dependencies, on purpose. Everything in `bench/` has to run on a machine with Node and nothing
// else, and a figure script that needs a Python environment is a figure script that stops working.
//
//   node bench/figures.mjs --out bench/figures
//
// Reads whatever exists in bench/results/ and bench/logs/ and skips what does not, so it is safe to
// run half way through a study.
//
// Colour: three categorical slots from a palette validated for colour-vision deficiency and for
// contrast against both surfaces (worst adjacent CVD ΔE 9.2 light / 9.4 dark, normal-vision ΔE 27.6 /
// 26.5). Identity is never carried by colour alone — every series is direct-labelled at its end and
// every figure has a legend.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const nx = process.argv[i + 1];
  argv[a.slice(2)] = nx && !nx.startsWith('--') ? (i++, nx) : true;
}
const RESULTS = argv.results ?? 'bench/results';
const LOGS = argv.logs ?? 'bench/logs';
const OUT = argv.out ?? 'bench/figures';
mkdirSync(OUT, { recursive: true });

const C = {
  s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a',
  ink: '#0b0b0b', ink2: '#52514e', muted: '#8a8983',
  grid: '#e6e5e0', surface: '#fcfcfb',
};

// ── helpers ──────────────────────────────────────────────────────────────────
const readJsonl = (file) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** A standalone SVG document — includable in LaTeX via `\includegraphics`, or inline in HTML. */
function svgDoc(width, height, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" ` +
    `font-family="Georgia, 'Liberation Serif', serif">\n` +
    `<title>${esc(title)}</title>\n` +
    `<rect width="${width}" height="${height}" fill="${C.surface}"/>\n${body}\n</svg>\n`;
}

/**
 * A plot frame: recessive axes and grid, a title, axis labels. Returns the scales the caller draws
 * with. `xLog` because every x here is a class count or a wall-clock budget, both of which are
 * doubled rather than incremented.
 */
function frame({ width = 760, height = 420, title, xLabel, yLabel, xDomain, yDomain, xLog = false,
                 yWarp = (v) => v, xTicks, yTicks, pad = { l: 68, r: 96, t: 46, b: 54 } }) {
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const lx = (v) => (xLog ? Math.log10(Math.max(v, 1e-9)) : v);
  const [x0, x1] = xDomain.map(lx);
  const [y0, y1] = yDomain.map(yWarp);
  const sx = (v) => pad.l + ((lx(v) - x0) / (x1 - x0 || 1)) * iw;
  // One axis, one scale. `yWarp` is how a soft cost that ranges over three orders of magnitude and
  // legitimately reaches zero gets an axis at all: log(v + 1), with the +1 stated on the label,
  // because a zero on a log axis is a lie unless it is said out loud.
  const sy = (v) => pad.t + ih - ((yWarp(v) - y0) / (y1 - y0 || 1)) * ih;

  let g = '';
  g += `<text x="${pad.l}" y="${pad.t - 22}" fill="${C.ink}" font-size="16" font-weight="600">${esc(title)}</text>\n`;
  for (const t of yTicks) {
    g += `<line x1="${pad.l}" y1="${sy(t).toFixed(1)}" x2="${pad.l + iw}" y2="${sy(t).toFixed(1)}" ` +
         `stroke="${C.grid}" stroke-width="1"/>\n`;
    g += `<text x="${pad.l - 10}" y="${(sy(t) + 4).toFixed(1)}" fill="${C.ink2}" font-size="12" ` +
         `text-anchor="end">${esc(fmt(t))}</text>\n`;
  }
  for (const t of xTicks) {
    g += `<text x="${sx(t.at ?? t).toFixed(1)}" y="${pad.t + ih + 20}" fill="${C.ink2}" font-size="12" ` +
         `text-anchor="middle">${esc(t.label ?? fmt(t))}</text>\n`;
  }
  g += `<line x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}" stroke="${C.muted}" stroke-width="1"/>\n`;
  g += `<text x="${pad.l + iw / 2}" y="${height - 12}" fill="${C.ink2}" font-size="12.5" text-anchor="middle">${esc(xLabel)}</text>\n`;
  g += `<text x="16" y="${pad.t + ih / 2}" fill="${C.ink2}" font-size="12.5" text-anchor="middle" ` +
       `transform="rotate(-90 16 ${pad.t + ih / 2})">${esc(yLabel)}</text>\n`;
  return { g, sx, sy, pad, iw, ih, width, height };
}

function line(points, colour, { label, dash = null, markers = null } = {}) {
  if (!points.length) return '';
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  let g = `<path d="${d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" ` +
          `stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>\n`;
  // Markers where each point is a measurement worth pointing at, and none where the line is a dense
  // trace — a marker per sample on a 60-sample trajectory is ink that hides the shape it is on.
  const showMarkers = markers ?? points.length <= 14;
  if (showMarkers) {
    // A 2px surface ring on every marker, so two series crossing stay two series.
    for (const p of points) {
      g += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" fill="${colour}" ` +
           `stroke="${C.surface}" stroke-width="2"/>\n`;
    }
  }
  if (label) {
    const last = points[points.length - 1];
    g += `<text x="${(last[0] + 10).toFixed(1)}" y="${(last[1] + 4).toFixed(1)}" fill="${C.ink2}" ` +
         `font-size="12.5">${esc(label)}</text>\n`;
  }
  return g;
}

const figures = [];
const emit = (name, svg, caption) => {
  writeFileSync(join(OUT, `${name}.svg`), svg);
  figures.push({ name, svg, caption });
  console.log(`${OUT}/${name}.svg`);
};

// ── figure 1: head to head, soft cost against instance size ─────────────────
{
  const rows = readJsonl(join(RESULTS, 'headtohead.jsonl'));
  const cpp = rows.filter((r) => r.solver === 'cpp');
  const ts = rows.filter((r) => r.solver === 'typescript');
  if (cpp.length && ts.length) {
    const sizes = [...new Set(rows.map((r) => r.n))].sort((a, b) => a - b);
    const seriesOf = (rs) => sizes
      .map((n) => [n, median(rs.filter((r) => r.n === n).map((r) => r.check.soft))])
      .filter(([, v]) => v !== null);
    const a = seriesOf(ts);
    const b = seriesOf(cpp);
    const top = Math.max(1, ...a.map(([, v]) => v), ...b.map(([, v]) => v));
    // A linear y would compress everything the C++ solver does into the axis line, so the axis is
    // "soft cost + 1" on a log scale — and the +1 is stated on the label, because a zero on a log
    // axis is a lie unless it is.
    const yWarp = (v) => Math.log10(v + 1);
    const yTicks = [0, 1, 3, 10, 30, 100, 300, 1000, 3000].filter((t) => t <= top * 1.8);
    const f = frame({
      title: 'Soft cost at a 30-second budget, two cores, median of three seeds',
      xLabel: 'class sessions (log scale)', yLabel: 'windows + mixed days   (log scale of value + 1)',
      xDomain: [sizes[0], sizes[sizes.length - 1]], xLog: true,
      yDomain: [0, top * 1.8], yWarp,
      xTicks: sizes.map((n) => ({ at: n, label: n.toLocaleString('en-US') })),
      yTicks,
    });
    let body = f.g;
    body += line(a.map(([n, v]) => [f.sx(n), f.sy(v)]), C.s2, { label: 'TypeScript (browser)' });
    body += line(b.map(([n, v]) => [f.sx(n), f.sy(v)]), C.s1, { label: 'C++ (this)' });
    emit('headtohead', svgDoc(f.width, f.height, body,
      'Soft cost against instance size for the two solvers at a 30-second budget'),
      'Both solvers on the same host at the same moment, on the same instances, scored by the same ' +
      'independent validator. Two workers each. A zero means a perfect schedule — no hard violations, ' +
      'no windows, no mixed online days.');
  }
}

// ── figure 2: what a longer budget buys ─────────────────────────────────────
{
  const rows = readJsonl(join(RESULTS, 'budget.jsonl'));
  const labels = [...new Set(rows.map((r) => r.label))];
  if (rows.length) {
    const budgets = [...new Set(rows.map((r) => r.timeMs))].sort((a, b) => a - b);
    const top = Math.max(1, ...rows.map((r) => r.check.soft));
    const f = frame({
      title: 'Soft cost against wall-clock budget',
      xLabel: 'budget (log scale)', yLabel: 'soft cost',
      xDomain: [budgets[0] / 1000, budgets[budgets.length - 1] / 1000], xLog: true,
      yDomain: [0, top * 1.2],
      xTicks: budgets.map((t) => ({ at: t / 1000, label: t >= 3600000 ? '1 h' : t >= 60000 ? `${t / 60000} min` : `${t / 1000} s` })),
      yTicks: Array.from({ length: 6 }, (_, i) => Math.round((top * 1.2 * i) / 5)),
    });
    let body = f.g;
    const colours = [C.s1, C.s2, C.s3];
    labels.forEach((label, i) => {
      const pts = budgets
        .map((t) => [t, median(rows.filter((r) => r.label === label && r.timeMs === t).map((r) => r.check.soft))])
        .filter(([, v]) => v !== null)
        .map(([t, v]) => [f.sx(t / 1000), f.sy(v)]);
      body += line(pts, colours[i % colours.length], { label });
    });
    emit('budget', svgDoc(f.width, f.height, body, 'Soft cost against wall-clock budget'),
      'The measurement this project exists for. The browser solver returns the same schedule at nine ' +
      'minutes as at five (TIMETABLE-GENERATION.md §8); this one is still descending.');
  }
}

// ── figure 3: ablation ───────────────────────────────────────────────────────
{
  const rows = readJsonl(join(RESULTS, 'ablation.jsonl'));
  if (rows.length) {
    const variants = [...new Set(rows.map((r) => r.label))];
    const sizes = [...new Set(rows.map((r) => r.n))].sort((a, b) => a - b);
    const biggest = sizes[sizes.length - 1];
    const data = variants
      .map((v) => ({ v, m: median(rows.filter((r) => r.label === v && r.n === biggest).map((r) => r.check.soft)) }))
      .filter((d) => d.m !== null)
      .sort((a, b) => a.m - b.m);
    const top = Math.max(1, ...data.map((d) => d.m));
    const rowH = 30;
    const width = 760;
    const pad = { l: 132, r: 84, t: 46, b: 46 };
    const height = pad.t + pad.b + data.length * rowH;
    const iw = width - pad.l - pad.r;
    let body = `<text x="${pad.l - 116}" y="${pad.t - 22}" fill="${C.ink}" font-size="16" font-weight="600">` +
      `${esc(`Ablation at n = ${biggest.toLocaleString('en-US')}, 60 s, median of three seeds`)}</text>\n`;
    data.forEach((d, i) => {
      const y = pad.t + i * rowH;
      const w = (d.m / (top || 1)) * iw;
      const full = d.v === 'full';
      body += `<text x="${pad.l - 10}" y="${y + rowH / 2 + 4}" fill="${full ? C.ink : C.ink2}" font-size="12.5" ` +
              `text-anchor="end"${full ? ' font-weight="600"' : ''}>${esc(d.v)}</text>\n`;
      // 4px rounded data-end, anchored to the baseline; 2px surface gap between bars via rowH.
      body += `<rect x="${pad.l}" y="${y + 6}" width="${Math.max(2, w).toFixed(1)}" height="${rowH - 14}" ` +
              `rx="4" fill="${full ? C.s1 : C.s2}"/>\n`;
      body += `<text x="${(pad.l + Math.max(2, w) + 8).toFixed(1)}" y="${y + rowH / 2 + 4}" fill="${C.ink2}" ` +
              `font-size="12.5">${esc(fmt(d.m))}</text>\n`;
    });
    body += `<line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + data.length * rowH}" ` +
            `stroke="${C.muted}" stroke-width="1"/>\n`;
    body += `<text x="${pad.l}" y="${height - 14}" fill="${C.ink2}" font-size="12.5">` +
            `soft cost — lower is better; “full” is every neighbourhood enabled</text>\n`;
    emit('ablation', svgDoc(width, height, body, 'Ablation of the neighbourhood portfolio'),
      'One variant at a time, everything else unchanged. “simple” is move and targeted swap only — ' +
      'the shape of the search the browser solver runs.');
  }
}

// ── figure 4: a single run's trajectory ─────────────────────────────────────
{
  const files = existsSync(LOGS) ? readdirSync(LOGS).filter((f) => f.endsWith('.csv')) : [];
  // The longest run available: the trajectory only says something interesting over a long budget.
  const pick = files.map((f) => ({ f, n: Number((f.match(/-(\d+)\.csv$/) ?? [0, 0])[1]) }))
    .sort((a, b) => b.n - a.n)[0];
  if (pick) {
    const text = readFileSync(join(LOGS, pick.f), 'utf8').trim().split('\n');
    const head = text[0].split(',');
    const col = (name) => head.indexOf(name);
    const all = text.slice(1).map((l) => l.split(',')).map((c) => ({
      t: Number(c[col('seconds')]),
      hard: Number(c[col('hard')]),
      obj: Number(c[col('objective')]),
      soft: Number(c[col('soft')]),
      lec: Number(c[col('lecturerWindows')]),
      grp: Number(c[col('groupWindows')]),
    })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.soft)).sort((a, b) => a.t - b.t);
    // The run's best-so-far across every worker, not one worker's samples. A row describes the
    // worker's own incumbent, and a worker that has just restarted from scratch is carrying a fresh
    // construction — plotted literally that is a sawtooth, and it is not what "was it still
    // descending" means. The envelope is monotone by construction.
    let best = null;
    const use = [];
    for (const p of all) {
      if (!best || p.hard < best.hard || (p.hard === best.hard && p.obj < best.obj)) best = p;
      use.push({ t: p.t, soft: best.soft, lec: best.lec, grp: best.grp });
    }
    if (use.length > 4) {
      const tMax = Math.max(...use.map((p) => p.t));
      const top = Math.max(1, ...use.map((p) => p.soft));
      // Same warped axis as figure 1, and for the same reason: the series falls from several hundred
      // to single digits, and on a linear axis everything after the first thirty seconds — which is
      // the entire question this figure exists to answer — lies on the axis line.
      const yWarp = (v) => Math.log10(v + 1);
      const f = frame({
        title: `Best schedule so far over one run (${esc(pick.f.replace(/\.csv$/, ''))})`,
        xLabel: 'seconds', yLabel: 'violations in the best schedule   (log scale of value + 1)',
        xDomain: [0, tMax], yDomain: [0, top * 1.6], yWarp,
        xTicks: Array.from({ length: 6 }, (_, i) => ({ at: (tMax * i) / 5, label: Math.round((tMax * i) / 5) })),
        yTicks: [0, 1, 3, 10, 30, 100, 300, 1000, 3000].filter((t) => t <= top * 1.6),
      });
      let body = f.g;
      const thin = (xs) => {
        const step = Math.max(1, Math.floor(xs.length / 120));
        const out = xs.filter((_, i) => i % step === 0);
        if (out[out.length - 1] !== xs[xs.length - 1]) out.push(xs[xs.length - 1]);
        return out;
      };
      body += line(thin(use).map((p) => [f.sx(p.t), f.sy(p.soft)]), C.s1, { label: 'soft total' });
      body += line(thin(use).map((p) => [f.sx(p.t), f.sy(p.lec)]), C.s2, { label: 'Π₇ lecturer windows' });
      body += line(thin(use).map((p) => [f.sx(p.t), f.sy(p.grp)]), C.s3, { label: 'Π₈ group windows' });
      emit('trajectory', svgDoc(f.width, f.height, body, 'The incumbent over one long run'),
        'The run\u2019s best-so-far across all workers. Every field of a sample describes an ' +
        'incumbent, not a working state, so the line can be checked against itself. The question a ' +
        'budget table cannot answer: was it still descending when the clock ran out?');
    }
  }
}

// ── the HTML page ────────────────────────────────────────────────────────────
{
  const body = figures.map((fig) => `
  <figure>
    ${fig.svg.replace(/^<\?xml[^>]*>\s*/, '')}
    <figcaption><strong>${esc(fig.name)}</strong> — ${esc(fig.caption)}</figcaption>
  </figure>`).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>timetable-generator — study figures</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 880px; padding: 40px 24px 80px;
         font: 15px/1.55 Georgia, 'Liberation Serif', serif;
         background: ${C.surface}; color: ${C.ink}; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p.lead { color: ${C.ink2}; margin: 0 0 34px; }
  figure { margin: 0 0 44px; }
  figure svg { max-width: 100%; height: auto; display: block; }
  figcaption { color: ${C.ink2}; font-size: 13.5px; margin-top: 10px; }
  table { border-collapse: collapse; font-size: 13px; width: 100%; margin-top: 8px; }
  th, td { text-align: right; padding: 4px 8px; border-bottom: 1px solid ${C.grid}; }
  th:first-child, td:first-child { text-align: left; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a19; color: #fff; }
    figure svg rect:first-of-type { fill: #1a1a19; }
    p.lead, figcaption { color: #c3c2b7; }
  }
</style></head>
<body>
<h1>timetable-generator — study figures</h1>
<p class="lead">Generated by <code>bench/figures.mjs</code> from <code>bench/results/</code>. Every
figure is scored by <code>timetable-bench/validate.mjs</code>, the independent validator the
TypeScript solver is measured with. The SVGs beside this file are standalone and includable in a
LaTeX document.</p>
${body}
</body></html>`;
  writeFileSync(join(OUT, 'index.html'), html);
  console.log(`${OUT}/index.html`);
}

if (!figures.length) {
  console.log('nothing to draw yet — run bench/master.sh first');
}
