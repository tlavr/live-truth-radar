// The detector's steps for one group, as figures with a plain sentence each (T12b, T12e). Shared by the
// dashboard's "How we got here" window and the standalone /explain page; styles in steps.css.
// stepsHTML() returns the markup, wireSteps() makes the pair grid answer taps.
import {verdictLabel} from './groups.js';

// detect/config.py defaults, shown in the plain-language hints
export const CFAR_K = 3, TAU_MAX_MIN = 10;
const NEWS_ECHO_MIN = 60;
// the five steps, named once: this page's sections and the dashboard's "Check" progress bar (short form under the bar)
export const STEP_TITLES = ['Find the posts about the topic', 'Compare every pair of accounts', 'Does it stand out from the background?',
  'Collect evidence post by post', 'Rule out a real news story'];
export const STEP_SHORT = ['Find posts', 'Compare pairs', 'Stand out?', 'Collect evidence', 'Rule out news'];
const CLOSE_MISMATCH_BINS = 3;  // ambiguity rows 0..0.3 of semantic mismatch = "nearly the same meaning"
const PAL = {cool: '#63CF97', warm: '#B7F063', peak: '#FFE066', muted: '#A3B8AA', grid: 'rgba(218,240,224,.12)'};

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const handle = a => a.startsWith('@') ? a : '@' + a;
const hm = iso => new Date(iso).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});   // the viewer's clock
const pct = x => `${+(x * 100).toFixed(1)}%`;
const sum = a => (a ?? []).flat().reduce((x, y) => x + y, 0);
const NARROW = matchMedia('(max-width: 560px)').matches;  // phone: narrower viewBox = larger SVG text
const span = s => s < 90 ? `${Math.round(s)} seconds` : s < 5400 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1)} hours`;

function step(n, title, say, body = '', hint = '', cls = '') {
  return `<section class="step ${cls}"><span class="sn">${typeof n === 'number' ? `Step ${n}` : 'Result'}</span>
    <h2>${title}</h2><p class="say">${say}</p>${body}${hint ? `<p class="hint">${hint}</p>` : ''}</section>`;
}

/* 1. Topic beam: when each account posted */
function timeline(f, items) {
  const uniq = [...new Set(f.accounts)];  // masked handles can collide: one row per shown name
  const rows = uniq.slice(0, 14), more = uniq.length - rows.length;
  const t0 = Date.parse(f.first_seen), t1 = Math.max(Date.parse(f.last_seen), t0 + 1000);
  // the label column is as wide as the longest name, so the dots start right after it, near the left edge
  const longest = Math.max(...rows.map(a => Math.min(handle(a).length, NARROW ? 16 : 18)));
  const w = NARROW ? 360 : 640, pl = Math.round(longest * 6.6) + 14, pr = 12, rh = 18, h = rows.length * rh + 26;
  const x = iso => pl + (Date.parse(iso) - t0) / (t1 - t0) * (w - pl - pr);
  const row = new Map(rows.map((a, k) => [a, k]));
  const dots = items.filter(it => row.has(it.author)).map(it =>
    `<circle cx="${x(it.published_at).toFixed(1)}" cy="${row.get(it.author) * rh + 10}" r="4.5" fill="${it.source === 'context_news' ? PAL.cool : PAL.warm}"><title>${esc(handle(it.author))} · ${hm(it.published_at)}</title></circle>`).join('');
  const labels = rows.map((a, k) => `<text x="0" y="${k * rh + 14}" text-anchor="start" fill="${PAL.muted}" font-size="12">${esc(handle(a).slice(0, NARROW ? 16 : 18))}</text>
    <line x1="${pl}" x2="${w - pr}" y1="${k * rh + 10}" y2="${k * rh + 10}" stroke="${PAL.grid}"/>`).join('');
  const axis = `<text x="${pl}" y="${h - 4}" fill="${PAL.muted}" font-size="12">${hm(f.first_seen)}</text>
    <text x="${w - pr}" y="${h - 4}" text-anchor="end" fill="${PAL.muted}" font-size="12">${hm(f.last_seen)}</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Posts of each account over time">${labels}${dots}${axis}</svg>
    ${more > 0 ? `<p class="hint">…and ${more} more accounts.</p>` : ''}`;
}

/* 2. Pair correlation heatmap */
function heatmap(f) {
  const n = f.accounts.length, cells = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) { cells.push('<div class="self" aria-hidden="true"></div>'); continue; }
    const v = Math.max(0, Math.min(1, f.correlation[i][j])), lag = f.lag_sec?.[i]?.[j] ?? 0;
    const who = lag > 0 ? `${handle(f.accounts[j])} posts ${Math.round(lag)} s after ${handle(f.accounts[i])}`
      : lag < 0 ? `${handle(f.accounts[j])} posts ${Math.round(-lag)} s before ${handle(f.accounts[i])}` : 'at the same time';
    const t = `${handle(f.accounts[i])} ↔ ${handle(f.accounts[j])}: similarity ${v.toFixed(2)}, ${who}`;
    cells.push(`<div tabindex="0" style="--v:${(.06 + .94 * v).toFixed(2)}" title="${esc(t)}" aria-label="${esc(t)}"></div>`);
  }
  return `<div class="corr" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${cells.join('')}</div>
    <p class="pairpick">Tap a square to see which two accounts it is.</p>`;
}

function offDiag(m) {
  const v = [];
  m.forEach((r, i) => r.forEach((x, j) => { if (i < j) v.push(x); }));
  return v.sort((a, b) => a - b);
}
const median = v => v.length ? v[Math.floor((v.length - 1) / 2)] : 0;

/* 3. CFAR + coherent integration */
function bars(f) {
  const mx = Math.max(f.snr_db, f.snr_db_single ?? 0, 1), n = f.accounts.length;
  const bar = (label, v) => `<div><span>${label}</span><i style="width:${(Math.max(0, v) / mx * 100).toFixed(1)}%"></i><span>${v.toFixed(1)} dB</span></div>`;
  return `<div class="bars">${f.snr_db_single != null ? bar('One pair', f.snr_db_single) : ''}${bar(`All ${n} together`, f.snr_db)}</div>`;
}

function closeShare(counts) {
  const all = sum(counts), close = sum((counts ?? []).slice(0, CLOSE_MISMATCH_BINS));
  return {all, close, share: all ? close / all : 0};
}

/* 4. SPRT trace */
function trace(f) {
  const t = f.sprt_trace, w = NARROW ? 380 : 640, h = NARROW ? 200 : 190, pl = 14, pr = 126, pb = 22;
  if (!t.length) return '<p class="empty">No posts to test.</p>';
  const lo = Math.min(f.sprt_lower, ...t) - .6, hi = Math.max(f.sprt_upper, ...t) + .8;
  const x = k => pl + k / Math.max(1, t.length - 1) * (w - pl - pr), y = v => (h - pb) - (v - lo) / (hi - lo) * (h - pb);
  const rule = (v, label, c) => `<line x1="${pl}" x2="${w - pr + 6}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${c}" stroke-opacity=".6" stroke-dasharray="4 5"/>
    <text x="${w - pr + 12}" y="${(y(v) + 4).toFixed(1)}" fill="${c}" font-size="12">${label}</text>`;
  const hit = f.verdict === 'coordinated', d = f.decided_at_item;
  const pts = t.map((v, k) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const dots = t.map((v, k) => `<circle cx="${x(k).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${k === d ? 6 : 3.5}" fill="${k === d ? PAL.peak : hit ? PAL.warm : PAL.cool}"><title>post ${k + 1}: evidence ${v.toFixed(2)}</title></circle>`).join('');
  const ticks = t.map((_, k) => (t.length <= 12 || k % Math.ceil(t.length / 12) === 0)
    ? `<text x="${x(k).toFixed(1)}" y="${h - 4}" text-anchor="middle" fill="${PAL.muted}" font-size="11">${k + 1}</text>` : '').join('');
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Evidence after each post, with the two decision thresholds">
    ${rule(f.sprt_upper, 'flag', PAL.peak)}${rule(0, 'no evidence', PAL.muted)}${rule(f.sprt_lower, 'clear', PAL.cool)}
    <polyline points="${pts}" fill="none" stroke="${hit ? PAL.warm : PAL.cool}" stroke-width="2" stroke-linejoin="round"/>${dots}${ticks}</svg>`;
}

/** The five steps and the verdict for finding `f`; `items` = its posts, `points` = /api/operating_points or null, `alpha` = the sensitivity in use. */
export function stepsHTML(f, items, points, alpha) {
  const n = f.accounts.length, posts = f.item_ids.length, hit = f.verdict === 'coordinated';
  const dur = (Date.parse(f.last_seen) - Date.parse(f.first_seen)) / 1000;
  const news = items.filter(it => it.source === 'context_news').length;
  const R = offDiag(f.correlation), lags = offDiag(f.lag_sec ?? []).map(Math.abs).sort((a, b) => a - b);
  const g = closeShare(f.ambiguity?.counts), bg = closeShare(f.ambiguity?.background);
  const d = f.decided_at_item, p = points?.points?.find(o => Math.abs(o.alpha - alpha) < 1e-9);
  const reprint = f.note?.startsWith('news reprint: '), echo = f.note?.startsWith('news echo: '), viral = f.note?.startsWith('viral echo: ');
  const trigger = f.sprt_trace.length && f.sprt_trace.at(-1) >= f.sprt_upper;

  const s = [];
  s.push(step(1, STEP_TITLES[0],
    `${posts} posts from ${n} accounts, all within ${span(dur)}.`,
    timeline(f, items),
    `One row per account, one dot per post (${hm(f.first_seen)}–${hm(f.last_seen)}).` +
    (news ? ` Darker dots are news articles.` : '')));
  s.push(step(2, STEP_TITLES[1],
    `Two accounts match when they say the same thing within minutes. Here a typical pair posted ${Math.round(median(lags))} seconds apart.`,
    heatmap(f),
    `Each square is one pair of accounts. The brighter, the closer their posts in meaning and time.`));
  s.push(step(3, STEP_TITLES[2],
    hit || f.verdict === 'watching'
      ? `Yes. These accounts match far more than people usually do in this topic.`
      : `They matched more than usual, but the next step cleared them.`,
    bars(f) + (g.all ? `<p class="hint">${pct(g.share)} of their posts say nearly the same thing${bg.all ? `; elsewhere in the topic only ${pct(bg.share)}` : ''}.</p>` : ''),
    `One pair alone is a weak signal. All ${n} accounts added up make a strong one.`));
  s.push(step(4, STEP_TITLES[3],
    d != null
      ? `By post ${d + 1} the evidence was strong enough to ${hit ? 'flag the group' : 'clear the group'}.`
      : trigger ? `The evidence was enough to flag the group, but the last check holds it back.`
      : `After ${f.sprt_trace.length} posts there is not enough evidence either way yet.`,
    trace(f),
    `Each post that repeats the group pushes the line up, an unrelated one pulls it down. The radar decides when the line crosses “flag” or “clear”.`));
  s.push(step(5, STEP_TITLES[4],
    reprint ? 'All posts in this group are news articles reprinting one story. Outlets syndicating a wire story are not a swarm.'
      : echo ? `A news article appeared just before this burst and says the same thing, so people may simply be reacting to it.`
      : viral ? `The same message is also posted by other accounts outside this group, so it looks like a meme or headline spreading on its own rather than a planned campaign.`
      : `No news story from the hour before says the same thing, so these people are not just reacting to a headline.`,
    f.note ? `<p class="note">${esc(f.note)}</p>` : '',
    f.note && trigger ? 'The evidence alone reached the "flag" line, so this check is why the group is not flagged.' : ''));

  const x = f.explanation, label = verdictLabel(f);
  s.push(step('✓', 'Verdict',
    `<span class="vmark"><i class="dot" data-v="${f.verdict}"></i>${esc(label)}</span>`,
    x && hit ? `<blockquote>“${esc(x.quote)}”</blockquote><p class="say">${esc(x.summary ?? '')}</p>
         ${x.technique.toLowerCase() !== 'other' ? `<p class="hint">Technique: ${esc(x.technique)}.</p>` : ''}` : '',
    `Set to allow ${pct(alpha)} false alarms${p ? ` (measured: ${pct(p.pfa)})` : ''}.`, 'final'));
  return s.join('');
}

/** The pair grid of step 2 names the pair under the pointer, focus or tap. Call after inserting stepsHTML() into `root`. */
export function wireSteps(root) {
  const grid = root.querySelector('.corr'), out = root.querySelector('.pairpick');
  if (!grid || !out) return;
  for (const ev of ['click', 'focusin', 'pointerover']) grid.addEventListener(ev, e => {
    const c = e.target.closest('.corr div[aria-label]');
    if (c) out.textContent = c.getAttribute('aria-label');
  });
}
