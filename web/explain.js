// T12b: "How we got here", a step-by-step walk through one alert (Finding) of the dashboard.
// Opened from the alert card as /explain?id=<finding id>&topic=<topic>&alpha=<slider alpha>.
// Data: /api/alerts?topic=&alpha= (the finding, by id) and /api/items?ids= (its posts).

import {topicLabel} from './labels.js';

// detect/config.py defaults, shown in the plain-language hints
const CFAR_K = 3, TAU_MAX_MIN = 10, NEWS_ECHO_MIN = 60, DESIGN_ALPHA = 0.02, MAX_IDS = 200;
const CLOSE_MISMATCH_BINS = 3;  // ambiguity rows 0..0.3 of semantic mismatch = "nearly the same meaning"
const PAL = {cool: '#63CF97', warm: '#B7F063', peak: '#FFE066', muted: '#A3B8AA', grid: 'rgba(218,240,224,.12)'};

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const handle = a => a.startsWith('@') ? a : '@' + a;
const hm = iso => iso.slice(11, 16);
const pct = x => `${+(x * 100).toFixed(1)}%`;
const sum = a => (a ?? []).flat().reduce((x, y) => x + y, 0);
const NARROW = matchMedia('(max-width: 560px)').matches;  // phone: narrower viewBox = larger SVG text
const span = s => s < 90 ? `${Math.round(s)} seconds` : s < 5400 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1)} hours`;

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status}`);
  return r.json();
}

const q = new URLSearchParams(location.search);
const ID = q.get('id'), TOPIC = q.get('topic');
const ALPHA = parseFloat(q.get('alpha')) || DESIGN_ALPHA;

function step(n, title, say, body = '', hint = '', cls = '') {
  return `<section class="step ${cls}"><div class="num" aria-hidden="true">${n}</div><div>
    <h2>${typeof n === 'number' ? `${n}. ` : ''}${title}</h2><p class="say">${say}</p>${body}${hint ? `<p class="hint">${hint}</p>` : ''}</div></section>`;
}

/* 1. Topic beam: when each account posted */
function timeline(f, items) {
  const uniq = [...new Set(f.accounts)];  // masked handles can collide: one row per shown name
  const rows = uniq.slice(0, 14), more = uniq.length - rows.length;
  const t0 = Date.parse(f.first_seen), t1 = Math.max(Date.parse(f.last_seen), t0 + 1000);
  const w = NARROW ? 360 : 640, pl = NARROW ? 136 : 150, pr = 12, rh = 18, h = rows.length * rh + 26;
  const x = iso => pl + (Date.parse(iso) - t0) / (t1 - t0) * (w - pl - pr);
  const row = new Map(rows.map((a, k) => [a, k]));
  const dots = items.filter(it => row.has(it.author)).map(it =>
    `<circle cx="${x(it.published_at).toFixed(1)}" cy="${row.get(it.author) * rh + 10}" r="4.5" fill="${it.source === 'context_news' ? PAL.cool : PAL.warm}"><title>${esc(handle(it.author))} · ${hm(it.published_at)} UTC</title></circle>`).join('');
  const labels = rows.map((a, k) => `<text x="${pl - 10}" y="${k * rh + 14}" text-anchor="end" fill="${PAL.muted}" font-size="12">${esc(handle(a).slice(0, NARROW ? 16 : 18))}</text>
    <line x1="${pl}" x2="${w - pr}" y1="${k * rh + 10}" y2="${k * rh + 10}" stroke="${PAL.grid}"/>`).join('');
  const axis = `<text x="${pl}" y="${h - 4}" fill="${PAL.muted}" font-size="12">${hm(f.first_seen)} UTC</text>
    <text x="${w - pr}" y="${h - 4}" text-anchor="end" fill="${PAL.muted}" font-size="12">${hm(f.last_seen)} UTC</text>`;
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
  return `<div class="corr" id="corr" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${cells.join('')}</div>
    <p class="pick" id="pick">Tap a cell to see the pair.</p>`;
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
  return `<div class="bars">${f.snr_db_single != null ? bar('Average pair', f.snr_db_single) : ''}${bar(`All ${n} accounts`, f.snr_db)}</div>`;
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
    ${rule(f.sprt_upper, `coordinated ${f.sprt_upper.toFixed(2)}`, PAL.peak)}${rule(0, 'no evidence 0', PAL.muted)}${rule(f.sprt_lower, `organic ${f.sprt_lower.toFixed(2)}`, PAL.cool)}
    <polyline points="${pts}" fill="none" stroke="${hit ? PAL.warm : PAL.cool}" stroke-width="2" stroke-linejoin="round"/>${dots}${ticks}</svg>`;
}

function render(f, items, points) {
  const n = f.accounts.length, posts = f.item_ids.length, hit = f.verdict === 'coordinated';
  const dur = (Date.parse(f.last_seen) - Date.parse(f.first_seen)) / 1000;
  const news = items.filter(it => it.source === 'context_news').length;
  $('intro').innerHTML = `Alert in <b>${esc(topicLabel(f.topic))}</b>: ${n} accounts, ${posts} posts${f.synthetic ? ' (an injected test campaign)' : ''}. ` +
    'Here is every step the detector took, in order, from raw posts to the verdict.';
  $('back').href = `/?q=${encodeURIComponent(f.topic)}`;

  const R = offDiag(f.correlation), lags = offDiag(f.lag_sec ?? []).map(Math.abs).sort((a, b) => a - b);
  const g = closeShare(f.ambiguity?.counts), bg = closeShare(f.ambiguity?.background);
  const d = f.decided_at_item, p = points?.points?.find(o => Math.abs(o.alpha - ALPHA) < 1e-9);
  const reprint = f.note?.startsWith('news reprint: '), echo = f.note?.startsWith('news echo: ');
  const trigger = f.sprt_trace.length && f.sprt_trace.at(-1) >= f.sprt_upper;

  const s = [];
  s.push(step(1, 'Find the posts about the topic',
    `${posts} posts from ${n} accounts, all within ${span(dur)} (${hm(f.first_seen)}–${hm(f.last_seen)} UTC).`,
    timeline(f, items),
    `Each dot is one post. The detector keeps posts whose meaning points at the topic (like a radar beam pointed one way), ` +
    `then removes the part every on-topic post shares, so only each post's own "fingerprint" is left.` +
    (news ? ` Green dots are news articles, light-green dots are other posts.` : '')));
  s.push(step(2, 'Compare every pair of accounts',
    `Typical pair similarity ${median(R).toFixed(2)} (0 = unrelated, higher = closer; about 1 = a copy), typical delay ${Math.round(median(lags))} s.`,
    heatmap(f),
    `Brighter cell = the two accounts say the same thing close in time. Only posts at most ${TAU_MAX_MIN} minutes apart count, ` +
    `and a longer delay counts less.`));
  s.push(step(3, 'Is it louder than the background?',
    hit || f.verdict === 'watching'
      ? `Yes. The pairs that link these accounts stand more than ${CFAR_K} noise widths above a typical pair in this topic, and all pairs together are louder than an average pair.`
      : `These accounts passed the threshold, but the post-by-post test (step 4) cleared them.`,
    bars(f) + `<p class="hint">${g.all ? `${pct(g.share)} of this group's close-in-time post pairs say nearly the same thing` : 'No close-in-time post pairs inside the group'}` +
      `${bg.all ? `, vs ${pct(bg.share)} for all other pairs in the topic.` : '.'}</p>`,
    `One whisper is lost in the crowd noise, but a choir of ${n} voices singing the same line stands out. ` +
    `The "Average pair" bar is a typical pair of the group; "All ${n} accounts" adds every pair up.`));
  s.push(step(4, 'Collect evidence post by post',
    d != null
      ? `After post ${d + 1} the evidence crossed the ${hit ? '"coordinated"' : '"organic"'} line, so the detector stopped and decided.`
      : trigger ? `After ${f.sprt_trace.length} posts the evidence reached the "coordinated" line, but step 5 holds the verdict at "watching".`
      : `After ${f.sprt_trace.length} posts the evidence is still between the two lines: not enough to decide yet.`,
    trace(f),
    `Each new post that echoes an earlier post of the group within seconds pushes the line up; an unrelated post pulls it down. ` +
    `Like a judge who waits until there is enough proof either way.`));
  s.push(step(5, 'Rule out a real news story',
    reprint ? 'All posts in this group are news articles reprinting one story. Outlets syndicating a wire story are not a swarm.'
      : echo ? `A news article appeared just before this burst and says the same thing, so people may simply be reacting to it.`
      : `No news article from the ${NEWS_ECHO_MIN} minutes before the burst was flagged as saying the same thing, so nothing points to people just reacting to a headline.`,
    f.note ? `<p class="note">${esc(f.note)}</p>` : '',
    f.note && trigger ? 'The evidence alone reached "coordinated", so this check lowered the verdict to "watching".' : ''));

  const x = f.explanation;
  const verdictText = hit ? `${n} accounts are posting near-identical messages almost at the same time.`
    : f.verdict === 'watching' ? `${n} accounts look alike, but the detector is not sure yet.`
    : `${n} accounts share a topic, but there is no coordination signal.`;
  s.push(step('✓', 'Verdict',
    `<span class="verdict" data-v="${f.verdict}">${esc(f.verdict)}</span> ${verdictText}`,
    x ? `<blockquote>“${esc(x.quote)}”</blockquote><p class="say">${esc(x.summary ?? '')}</p>
         <p class="hint">Technique: ${esc(x.technique)}, ${Math.round(x.confidence * 100)}% confidence.</p>` : '',
    `False alarm target: ${pct(ALPHA)}${p ? ` (measured ${pct(p.pfa)}, ≤ ${pct(p.pfa_upper95)} at 95%)` : ''}. ` +
    `A lower target means the detector needs more evidence before it says "coordinated".`, 'final'));
  $('steps').innerHTML = s.join('');

  const pick = $('pick');
  for (const ev of ['click', 'focusin', 'pointerover']) $('corr')?.addEventListener(ev, e => {
    const c = e.target.closest('.corr div[aria-label]');
    if (c && pick) pick.textContent = c.getAttribute('aria-label');
  });
}

function fail(msg) {
  $('intro').textContent = msg;
  $('steps').innerHTML = `<p><a href="${TOPIC ? `/?q=${encodeURIComponent(TOPIC)}` : '/'}">← Back to the radar</a></p>`;
}

(async () => {
  if (!ID) return fail('No alert selected. Open this page from an alert card.');
  try {
    const qs = new URLSearchParams();
    if (TOPIC) qs.set('topic', TOPIC);
    if (ALPHA !== DESIGN_ALPHA) qs.set('alpha', String(ALPHA));
    const [alerts, points] = await Promise.all([
      api(`/api/alerts${qs.size ? '?' + qs : ''}`), api('/api/operating_points').catch(() => null)]);
    const f = alerts.findings.find(x => x.id === ID);
    if (!f) return fail('This alert is no longer in the current window (test campaigns expire after ~10 minutes).');
    const items = [];
    for (let k = 0; k < f.item_ids.length; k += MAX_IDS) {
      const ids = f.item_ids.slice(k, k + MAX_IDS).map(encodeURIComponent).join(',');
      try { items.push(...await api(`/api/items?ids=${ids}`)); } catch (e) { console.warn('items', e); }
    }
    render(f, items, points);
  } catch (e) {
    console.warn(e);
    fail(`Could not load the alert (${e.message}).`);
  }
})();
