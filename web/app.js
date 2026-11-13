/* Live Truth Radar dashboard. Plain JS, no build step.
   Data shapes: contracts/models.py (AlertsResponse, Item, MetricsReport). */
(function () {
  'use strict';

  // ------------------------------------------------------------------ data layer
  // The only place that knows where data comes from. Wire the real API here.
  const Data = {
    mock: false,
    base: resolveApiBase(), // null = no API for this page, use window.LTR_MOCK

    async _json(path, opts) {
      if (this.base === null) throw new Error('no API configured');
      const res = await fetch(this.base + path, opts);
      if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
      return res.json();
    },
    _fallback(pick) {
      if (!window.LTR_MOCK) throw new Error('API unreachable and mock-data.js missing');
      this.mock = true;
      return pick(window.LTR_MOCK);
    },
    /** -> AlertsResponse */
    async alerts() {
      try { return await this._json('/api/alerts'); }
      catch (e) { return this._fallback((m) => m.alerts); }
    },
    /** -> { [id]: Item } */
    async items(ids) {
      if (!ids.length) return {};
      try {
        const list = await this._json('/api/items?ids=' + encodeURIComponent(ids.join(',')));
        return Object.fromEntries(list.map((it) => [it.id, it]));
      } catch (e) {
        return this._fallback((m) => Object.fromEntries(ids.filter((id) => m.items[id]).map((id) => [id, m.items[id]])));
      }
    },
    /** -> MetricsReport */
    async metrics() {
      try { return await this._json('/api/metrics'); }
      catch (e) { return this._fallback((m) => m.metrics); }
    },
    /** POST /api/inject (live only) */
    async inject() {
      return this._json('/api/inject', { method: 'POST' });
    },
  };

  function resolveApiBase() {
    const q = new URLSearchParams(location.search);
    if (q.has('mock')) return null;
    if (q.has('api')) return q.get('api').replace(/\/$/, '');
    const meta = document.querySelector('meta[name="ltr-api-base"]');
    const v = meta ? meta.content.trim() : 'auto';
    if (v === 'none') return null; // static preview: demo data only
    if (v !== 'auto') return v.replace(/\/$/, '');
    // auto: FastAPI serves this page at "/" and "/metrics". Anywhere else (static preview,
    // file://, /web/index.html) there is no API next to it, so do not spam 404s.
    if (!/^https?:$/.test(location.protocol)) return null;
    return /^\/(metrics\/?)?$/.test(location.pathname) ? '' : null;
  }

  const POLL_MS = 30000;
  const state = { alerts: null, items: {}, metrics: null, selected: null, charts: {} };

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const pad = (n) => String(n).padStart(2, '0');
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hm(iso, withSec) {
    const d = new Date(iso);
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + (withSec ? ':' + pad(d.getUTCSeconds()) : '');
  }
  function dur(sec) {
    sec = Math.round(Math.abs(sec));
    if (sec < 60) return sec + ' s';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + ' min' + (s ? ' ' + s + ' s' : '');
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  const db = (v) => (v == null ? 'n/a' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
  const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  const pct = (v, digits) => (v == null ? 'n/a' : (v * 100).toFixed(digits == null ? 0 : digits) + '%');

  /** Real handles are masked; synthetic test accounts are ours and shown in full. */
  function handle(author, synthetic) {
    const a = String(author).replace(/^@/, '');
    return '@' + (synthetic ? a : a.slice(0, 2) + '***');
  }
  function accountIsSynthetic(f, account) {
    const it = f.item_ids.map((id) => state.items[id]).find((x) => x && x.author === account);
    return it ? !!it.synthetic : !!f.synthetic;
  }
  function highlight(text, quote) {
    if (!quote) return esc(text);
    const i = text.toLowerCase().indexOf(quote.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + quote.length)) + '</mark>' + esc(text.slice(i + quote.length));
  }

  const VERDICT = {
    coordinated: { chip: 'Coordinated', note: '' },
    watching: { chip: 'Keep watching', note: 'not enough evidence yet' },
    organic: { chip: 'Organic', note: 'looks like independent people' },
  };

  const TERMS = {
    snr: 'SNR (signal-to-noise ratio): how much louder the campaign is than background chatter, in decibels. Below 0 dB it is hidden in the noise; every +10 dB is ten times stronger.',
    corr: 'Correlation: how closely two accounts post in step. 0 means unrelated timing, 1 means they move together.',
    sprt: 'SPRT (sequential test): evidence adds up post by post until it crosses a decision line.',
    pfa: 'False-alarm rate: the share of innocent groups we would wrongly flag.',
  };
  const term = (key, label) => '<abbr title="' + esc(TERMS[key]) + '">' + esc(label) + '</abbr>';

  // ------------------------------------------------------------------ header
  function renderHeader() {
    const a = state.alerts;
    $('demo-badge').hidden = !Data.mock;
    const topics = [...new Set(a.findings.map((f) => f.topic))];
    $('topics').innerHTML = topics.length
      ? topics.map((t) => '<span class="topic-chip">' + esc(t) + '</span>').join('')
      : '<span class="muted">no topics yet</span>';

    const el = $('updated');
    if (!a.last_poll_at) { el.textContent = 'No successful update yet'; return; }
    // Demo data is frozen in time: measure against its own generation time, not the wall clock.
    const now = Data.mock ? new Date(a.generated_at) : new Date();
    const min = Math.max(0, Math.round((now - new Date(a.last_poll_at)) / 60000));
    el.textContent = min < 1 ? 'Updated just now' : min < 120 ? 'Updated ' + min + ' min ago' : 'Updated ' + Math.round(min / 60) + ' h ago';
    el.title = 'Last successful data fetch: ' + new Date(a.last_poll_at).toISOString().replace('.000', '');
  }

  // ------------------------------------------------------------------ feed
  function renderFeed() {
    const fs = state.alerts.findings;
    $('feed-count').textContent = fs.length + (fs.length === 1 ? ' group' : ' groups');
    if (!fs.length) {
      $('feed').innerHTML = '<li class="caption">Nothing to show yet. The detector has not seen any group worth a second look.</li>';
      return;
    }
    $('feed').innerHTML = fs.map((f) => {
      const v = VERDICT[f.verdict] || VERDICT.watching;
      return '<li><button type="button" class="feed-row" data-id="' + esc(f.id) + '" data-verdict="' + esc(f.verdict) + '" aria-pressed="' + (f.id === state.selected) + '">' +
        '<span class="row-top"><span class="chip" data-verdict="' + esc(f.verdict) + '">' + v.chip + '</span>' +
        (v.note ? '<span class="row-note">' + v.note + '</span>' : '') +
        (f.synthetic ? '<span class="badge tag-synth" title="Contains posts we injected ourselves to test the detector.">Synthetic test</span>' : '') +
        '</span>' +
        '<span class="row-topic">' + esc(f.topic) + '</span>' +
        '<dl class="row-facts">' +
        '<div><dt>Accounts / posts</dt><dd>' + f.accounts.length + ' / ' + f.item_ids.length + '</dd></div>' +
        '<div><dt>Seen (UTC)</dt><dd>' + hm(f.first_seen) + '–' + hm(f.last_seen) + '</dd></div>' +
        '<div><dt>SNR, one account → group</dt><dd>' + db(f.snr_db_single) + ' → ' + db(f.snr_db) + ' dB</dd></div>' +
        '<div><dt>Evidence score</dt><dd>' + signed(f.llr) + '</dd></div>' +
        '</dl></button></li>';
    }).join('');
  }

  function select(id, opts) {
    state.selected = id;
    document.querySelectorAll('.feed-row').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    renderCard();
    if (opts && opts.scroll && window.matchMedia('(max-width: 1080px)').matches) {
      $('card').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
  }

  // ------------------------------------------------------------------ verdict card
  function renderCard() {
    const card = $('card');
    const f = state.alerts.findings.find((x) => x.id === state.selected);
    destroyChart('sprt');
    if (!f) {
      card.removeAttribute('data-verdict');
      card.innerHTML = '<div class="block"><p class="caption">Select an alert to see the evidence behind it.</p></div>';
      return;
    }
    card.dataset.verdict = f.verdict;
    const items = f.item_ids.map((id) => state.items[id]).filter(Boolean)
      .sort((a, b) => new Date(a.published_at) - new Date(b.published_at));
    const n = f.accounts.length;
    const v = VERDICT[f.verdict] || VERDICT.watching;

    const title = f.verdict === 'coordinated'
      ? n + ' accounts are pushing the same message in step'
      : f.verdict === 'organic'
        ? 'These ' + n + ' accounts look like independent people'
        : 'Not enough evidence yet: we keep watching these ' + n + ' accounts';
    const sub = f.verdict === 'coordinated'
      ? 'Their posts are reworded copies of one another and arrive seconds apart, again and again. One account alone would not stand out; together the pattern is unmistakable.'
      : f.verdict === 'organic'
        ? 'They talk about the same topic, but in their own words and at their own times. The evidence crossed the “organic” line.'
        : 'They post on the same topic, but so far their wording and timing do not line up. We would rather wait than raise a false alarm.';

    card.innerHTML =
      '<div class="card-head">' +
        '<div class="row-top"><span class="chip" data-verdict="' + esc(f.verdict) + '">' + v.chip + '</span>' +
        '<span class="badge">' + esc(f.topic) + '</span>' +
        (f.synthetic ? '<span class="badge tag-synth" title="Contains posts we injected ourselves to test the detector.">Synthetic test</span>' : '') + '</div>' +
        '<h2 class="card-title">' + esc(title) + '</h2>' +
        '<p class="card-sub">' + esc(sub) + '</p>' +
        '<dl class="facts">' +
          '<div><dt>' + term('snr', 'SNR') + ', one account → whole group</dt><dd class="big">' + db(f.snr_db_single) + '<span class="arrow"> → </span>' + db(f.snr_db) + ' dB</dd></div>' +
          '<div><dt>Accounts</dt><dd class="big">' + n + '</dd></div>' +
          '<div><dt>Posts</dt><dd class="big">' + f.item_ids.length + '</dd></div>' +
          '<div><dt>Seen (UTC)</dt><dd class="big">' + hm(f.first_seen) + '–' + hm(f.last_seen) + '</dd></div>' +
        '</dl>' +
      '</div>' +
      explanationBlock(f, items) +
      '<div class="pair">' +
        '<div class="block"><h3>Who posts in step with whom</h3>' +
          '<p class="caption">' + term('corr', 'Correlation') + ' of posting activity between each pair of accounts. Hover or tap a cell.</p>' +
          heatmap(f) + '</div>' +
        '<div class="block"><h3>How the evidence added up</h3>' +
          '<p class="caption">' + term('sprt', 'SPRT') + ' trace: the running evidence score after each post. ' + sprtNote(f) + '</p>' +
          '<div class="chart-box"><canvas id="sprt-chart" role="img" aria-label="' + esc(sprtAria(f)) + '"></canvas></div></div>' +
      '</div>' +
      timelineBlock(f, items) +
      '<div class="block"><h3>How to read this</h3><dl class="howto">' +
        '<div><dt>SNR ' + db(f.snr_db_single) + ' → ' + db(f.snr_db) + ' dB</dt><dd>How much louder the pattern is than background chatter. The first number is a single account on its own, the second is all accounts added together. A big jump means they only stand out as a group.</dd></div>' +
        '<div><dt>Correlation 0 … 1</dt><dd>How closely two accounts post in step. Strangers sit near 0. Values near 1 mean one account posts whenever the other does; the lag is how many seconds apart.</dd></div>' +
        '<div><dt>SPRT lines ' + signed(f.sprt_lower) + ' / ' + signed(f.sprt_upper) + '</dt><dd>Each post adds or removes evidence. Above the top line we call it coordinated, below the bottom line organic, in between we keep watching. The lines are set for at most 2% false alarms.</dd></div>' +
      '</dl></div>';

    bindHeatmap(f);
    drawSprt(f);
  }

  function explanationBlock(f, items) {
    const e = f.explanation;
    if (!e) {
      const why = f.verdict === 'watching'
        ? 'No verdict yet, so there is nothing to explain. The evidence score is ' + signed(f.llr) + '; it has to reach ' + signed(f.sprt_upper) + ' to be called coordinated or ' + signed(f.sprt_lower) + ' to be called organic. A written explanation is only produced once a campaign is confirmed.'
        : f.verdict === 'organic'
          ? 'No manipulation technique to report: the evidence points to ordinary, independent posting.'
          : 'The written explanation for this alert has not been generated yet. The measurements below still apply.';
      return '<div class="block"><h3>Why there is no explanation</h3><p class="novardict">' + esc(why) + '</p></div>';
    }
    const q = e.quote.toLowerCase();
    const hit = items.find((it) => it.text.toLowerCase().includes(q));
    const quoteHtml = hit
      ? '<blockquote class="post">' + highlight(hit.text, e.quote) +
        '<footer>' + esc(handle(hit.author, hit.synthetic)) + ' · ' + hm(hit.published_at, true) + ' UTC · actual post, key phrase highlighted</footer></blockquote>'
      : '<blockquote class="post"><mark>' + esc(e.quote) + '</mark><footer>key phrase</footer></blockquote>';
    return '<div class="block"><h3>What they are doing</h3>' +
      '<div class="explain"><div><p>' + esc(e.summary) + '</p>' + quoteHtml + '</div>' +
      '<dl><div><dt>Persuasion technique</dt><dd><strong>' + esc(e.technique) + '</strong></dd></div>' +
      '<div><dt>How sure the explainer is</dt><dd class="meter"><span class="num">' + pct(e.confidence) + '</span>' +
      '<span class="meter-track"><span class="meter-fill" style="width:' + Math.round(e.confidence * 100) + '%"></span></span></dd></div>' +
      '<div><dt>Who wrote this</dt><dd class="caption">A language model reads the flagged posts and describes the technique. The detection itself is the math below, not the model.</dd></div>' +
      '</dl></div></div>';
  }

  // ---- heatmap (CSS grid; one hue, light to strong)
  function heatmap(f) {
    const n = f.accounts.length;
    if (!f.correlation || !f.correlation.length) return '<p class="caption">No correlation data for this group.</p>';
    let h = '<div class="scroll-x"><div class="heat" style="grid-template-columns:auto repeat(' + n + ',auto)"><span></span>';
    for (let j = 0; j < n; j++) h += '<span class="heat-collabel" aria-hidden="true">' + (j + 1) + '</span>';
    for (let i = 0; i < n; i++) {
      const name = handle(f.accounts[i], accountIsSynthetic(f, f.accounts[i]));
      h += '<span class="heat-rowlabel"><span class="heat-idx">' + (i + 1) + '</span><span class="heat-name" title="' + esc(name) + '">' + esc(name) + '</span></span>';
      for (let j = 0; j < n; j++) {
        const c = f.correlation[i][j];
        if (i === j) { h += '<span class="heat-cell diag" aria-hidden="true" style="display:grid;place-items:center">·</span>'; continue; }
        const v = Math.max(0, Math.min(1, c));
        h += '<button type="button" class="heat-cell' + (v > 0.5 ? ' hi' : '') + '" style="--v:' + v.toFixed(3) + '" data-i="' + i + '" data-j="' + j + '"' +
          ' aria-label="' + esc(pairText(f, i, j, true)) + '">' + c.toFixed(2).replace(/^0\./, '.') + '</button>';
      }
    }
    h += '</div></div>' +
      '<div class="heat-scale"><span>0</span><i></i><span>1 = always in step</span></div>' +
      '<p class="heat-readout" id="heat-readout">' + heatSummary(f) + '</p>';
    return h;
  }
  function heatSummary(f) {
    const vals = [];
    f.correlation.forEach((row, i) => row.forEach((c, j) => { if (i < j) vals.push(c); }));
    if (!vals.length) return '';
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return 'Average between pairs: <b class="num">' + mean.toFixed(2) + '</b>. ' +
      (mean > 0.6 ? 'These accounts move together.' : mean < 0.25 ? 'These accounts post independently of each other.' : 'Some overlap, nothing conclusive.');
  }
  function pairText(f, i, j, plain) {
    const a = handle(f.accounts[i], accountIsSynthetic(f, f.accounts[i]));
    const b = handle(f.accounts[j], accountIsSynthetic(f, f.accounts[j]));
    const c = f.correlation[i][j].toFixed(2);
    const lag = f.lag_sec ? f.lag_sec[i][j] : null;
    let lagTxt = '';
    if (lag != null) {
      // Sign convention is not fixed by the contract, so state only the size of the offset.
      lagTxt = Math.abs(lag) < 0.5 ? ', no measurable time offset' : ', typically ' + dur(lag) + ' apart';
    }
    if (plain) return a + ' and ' + b + ': correlation ' + c + lagTxt;
    return '<b>' + esc(a) + '</b> and <b>' + esc(b) + '</b>: correlation <b class="num">' + c + '</b>' + esc(lagTxt) +
      (lag != null ? ' <span class="muted num">(lag ' + (lag > 0 ? '+' : lag < 0 ? '−' : '') + Math.abs(lag).toFixed(0) + ' s)</span>' : '');
  }
  function bindHeatmap(f) {
    const out = $('heat-readout');
    if (!out) return;
    const cells = document.querySelectorAll('#card .heat-cell:not(.diag)');
    const show = (cell) => {
      cells.forEach((c) => c.classList.toggle('on', c === cell));
      out.innerHTML = cell ? pairText(f, +cell.dataset.i, +cell.dataset.j, false) : heatSummary(f);
    };
    cells.forEach((cell) => {
      cell.addEventListener('mouseenter', () => show(cell));
      cell.addEventListener('focus', () => show(cell));
      cell.addEventListener('click', () => show(cell));
    });
    const grid = document.querySelector('#card .heat');
    if (grid) grid.addEventListener('mouseleave', () => { if (!grid.contains(document.activeElement)) show(null); });
  }

  // ---- SPRT trace
  function sprtNote(f) {
    const total = f.item_ids.length, k = f.sprt_trace.length;
    if (f.decided_at_item != null) {
      return 'Decided at post ' + (f.decided_at_item + 1) + ' of ' + total + '; the test stops as soon as it is sure.';
    }
    return 'Still between the lines after ' + k + ' scored post' + (k === 1 ? '' : 's') + (total > k ? ' (' + total + ' seen)' : '') + '.';
  }
  function sprtAria(f) {
    return 'Line chart of the evidence score after each post, from ' + signed(f.sprt_trace[0] || 0) + ' to ' + signed(f.llr) +
      '. Coordinated line at ' + signed(f.sprt_upper) + ', organic line at ' + signed(f.sprt_lower) + '. ' + sprtNote(f);
  }

  function chartBase() {
    const ink2 = token('--ink-2'), grid = token('--chart-grid');
    const mono = token('--font-mono') || 'monospace';
    return {
      ink: token('--ink'), ink2, ink3: token('--ink-3'), grid, surface: token('--surface'),
      line: token('--chart-line'), ref: token('--chart-ref'), coord: token('--coord'), organic: token('--organic'),
      font: { family: mono, size: 11 },
      scale: (title) => ({
        title: { display: true, text: title, color: ink2, font: { family: token('--font-body'), size: 12 } },
        grid: { color: grid }, border: { color: grid },
        ticks: { color: ink2, font: { family: mono, size: 11 } },
      }),
    };
  }
  function destroyChart(key) {
    if (state.charts[key]) { state.charts[key].destroy(); state.charts[key] = null; }
  }
  function noChart(canvas) {
    if (window.Chart) return false;
    if (canvas) canvas.parentElement.innerHTML = '<p class="chart-fallback">Chart library could not be loaded. The numbers in the text still apply.</p>';
    return true;
  }

  function drawSprt(f) {
    const canvas = $('sprt-chart');
    if (!canvas || noChart(canvas)) return;
    const c = chartBase();
    const trace = f.sprt_trace;
    const n = Math.max(trace.length, 2);
    const k = f.decided_at_item;
    const decidedColor = k != null && trace[k] <= f.sprt_lower ? c.organic : c.coord;
    const yMin = Math.min(f.sprt_lower, ...trace) - 0.9;
    const yMax = Math.max(f.sprt_upper, ...trace) + 1.1;

    const labels = {
      id: 'ltrLabels',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea: a, scales: { x, y } } = chart;
        ctx.save();
        ctx.font = '500 11px ' + c.font.family;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        ctx.fillStyle = c.coord;
        ctx.fillText('coordinated ≥ ' + signed(f.sprt_upper), a.left + 6, y.getPixelForValue(f.sprt_upper) - 4);
        ctx.fillStyle = c.organic;
        ctx.textBaseline = 'top';
        ctx.fillText('organic ≤ ' + signed(f.sprt_lower), a.left + 6, y.getPixelForValue(f.sprt_lower) + 4);
        if (k != null) {
          const px = x.getPixelForValue(k + 1), py = y.getPixelForValue(trace[k]);
          ctx.strokeStyle = c.ink3; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(px, py + 8); ctx.lineTo(px, a.bottom); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = c.ink; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
          ctx.font = '600 12px ' + (token('--font-body') || 'sans-serif');
          ctx.textBaseline = 'bottom';
          ctx.fillText('Decided at post ' + (k + 1), px - 8, a.bottom - 6);
        }
        ctx.restore();
      },
    };

    state.charts.sprt = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Evidence score',
            data: trace.map((v, i) => ({ x: i + 1, y: v })),
            borderColor: c.line, backgroundColor: c.line, borderWidth: 2, tension: 0,
            pointRadius: trace.map((_, i) => (i === k ? 7 : 3)),
            pointHoverRadius: trace.map((_, i) => (i === k ? 9 : 6)),
            pointBackgroundColor: trace.map((_, i) => (i === k ? decidedColor : c.line)),
            pointBorderColor: c.surface, pointBorderWidth: 2,
            order: 1,
          },
          { label: 'Coordinated line', data: [{ x: 0.5, y: f.sprt_upper }, { x: n + 0.5, y: f.sprt_upper }], borderColor: c.coord, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, pointHitRadius: 0, order: 2 },
          { label: 'Organic line', data: [{ x: 0.5, y: f.sprt_lower }, { x: n + 0.5, y: f.sprt_lower }], borderColor: c.organic, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, pointHitRadius: 0, order: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: Object.assign(c.scale('Post number, in time order'), { type: 'linear', min: 0.5, max: n + 0.5, ticks: { stepSize: 1, color: c.ink2, font: c.font, callback: (v) => (Number.isInteger(v) ? v : '') } }),
          y: Object.assign(c.scale('Evidence score (cumulative LLR)'), { min: yMin, max: yMax, ticks: { includeBounds: false, color: c.ink2, font: c.font } }),
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (item) => item.datasetIndex === 0,
            displayColors: false,
            callbacks: {
              title: (items) => (items[0] ? 'After post ' + items[0].parsed.x : ''),
              label: (item) => {
                const i = item.dataIndex, step = i === 0 ? trace[0] : trace[i] - trace[i - 1];
                return ['Evidence score ' + signed(trace[i]), 'This post added ' + signed(step)].concat(i === k ? ['Decision line crossed here'] : []);
              },
            },
          },
        },
      },
      plugins: [labels],
    });
  }

  // ---- posts timeline
  function timelineBlock(f, items) {
    if (!items.length) {
      return '<div class="block"><h3>The posts</h3><p class="caption">Post texts are not available for this group.</p></div>';
    }
    const t0 = +new Date(f.first_seen), t1 = +new Date(f.last_seen), span = Math.max(1, t1 - t0);
    const quote = f.explanation ? f.explanation.quote : null;

    let strip = '<div class="strip" role="img" aria-label="Posting times per account between ' + hm(f.first_seen) + ' and ' + hm(f.last_seen) + ' UTC">';
    f.accounts.forEach((acc) => {
      const mine = items.filter((it) => it.author === acc);
      strip += '<div class="strip-row"><span class="strip-label">' + esc(handle(acc, accountIsSynthetic(f, acc))) + '</span><span class="strip-track">' +
        mine.map((it) => '<i style="left:' + (((+new Date(it.published_at) - t0) / span) * 100).toFixed(2) + '%" title="' + hm(it.published_at, true) + ' UTC"></i>').join('') +
        '</span></div>';
    });
    strip += '<div class="strip-row"><span></span><span class="strip-axis"><span>' + hm(f.first_seen) + '</span><span>' + hm(f.last_seen) + ' UTC</span></span></div></div>';

    // Group posts into bursts: a gap of more than 3 minutes starts a new one.
    const bursts = [];
    items.forEach((it) => {
      const t = +new Date(it.published_at), last = bursts[bursts.length - 1];
      if (last && t - last.end <= 180000) { last.items.push(it); last.end = t; }
      else bursts.push({ start: t, end: t, items: [it] });
    });
    const tight = bursts.filter((b) => new Set(b.items.map((i) => i.author)).size >= 3);
    const lead = tight.length
      ? tight.length + ' time' + (tight.length === 1 ? '' : 's') + ' in a row, at least three accounts posted the same thing within three minutes. Marks that line up vertically are posts made at almost the same moment.'
      : 'Marks are spread out and rarely line up: each account posts on its own schedule.';

    let waves = '<div class="waves">';
    bursts.forEach((b, bi) => {
      const accs = new Set(b.items.map((i) => i.author)).size;
      const isTight = accs >= 3;
      waves += '<details class="wave"' + (bi === 0 || (isTight && bi === tight.indexOf(b) && bi < 1) ? ' open' : '') + '><summary>' +
        '<span class="wave-time">' + hm(new Date(b.start).toISOString(), true) + ' UTC</span>' +
        '<span>' + b.items.length + ' post' + (b.items.length === 1 ? '' : 's') + (b.items.length > 1 ? ' from ' + accs + ' account' + (accs === 1 ? '' : 's') : '') + '</span>' +
        (b.items.length > 1 ? '<span class="' + (isTight ? 'wave-tight' : 'muted') + '">all within ' + dur((b.end - b.start) / 1000) + '</span>' : '') +
        '</summary><ol class="posts">' +
        b.items.map((it) => '<li><span class="off">' + (+new Date(it.published_at) === b.start ? hm(it.published_at) : '+' + dur((+new Date(it.published_at) - b.start) / 1000)) + '</span>' +
          '<span class="who">' + esc(handle(it.author, it.synthetic)) + '</span>' +
          '<span class="txt">' + highlight(it.text, quote) + '</span></li>').join('') +
        '</ol></details>';
    });
    waves += '</div>';

    return '<div class="block"><h3>The posts, account by account</h3><p class="caption">' + esc(lead) + '</p>' + strip + waves + '</div>';
  }

  // ------------------------------------------------------------------ metrics view
  function renderMetrics() {
    const el = $('view-metrics');
    const m = state.metrics;
    destroyChart('roc');
    if (!m) { el.innerHTML = '<p class="caption">Loading accuracy report…</p>'; return; }

    const placeholder = Data.mock;
    const devEmbedder = !placeholder && m.embedder && m.embedder !== 'gemini';
    const secs = m.mean_seconds_to_decision;
    const kpi = (label, val, sub) => '<div class="kpi"><dt>' + label + '</dt><dd><div class="val">' + val + '</div><div class="sub">' + sub + '</div></dd></div>';

    el.innerHTML =
      (placeholder ? '<p class="notice" role="note"><strong>Example numbers — real evaluation pending.</strong> This page is showing bundled demo data. The figures below only illustrate the layout; they are not measured results.</p>' : '') +
      (devEmbedder ? '<p class="notice" role="note"><strong>Development run.</strong> This report was computed with the “' + esc(m.embedder) + '” text embedder, not the production one. Treat the numbers as provisional.</p>' : '') +
      '<div class="metrics-head"><h2>Accuracy</h2>' +
        '<p class="card-title">How often the detector is right, and where it is wrong</p>' +
        '<p class="card-sub">Report generated <span class="num">' + esc(new Date(m.generated_at).toISOString().slice(0, 16).replace('T', ' ')) + ' UTC</span> · text embedder: <span class="num">' + esc(m.embedder || 'not stated') + '</span>' + (placeholder ? ' · <span class="badge badge-demo">Example</span>' : '') + '</p></div>' +
      '<dl class="kpis">' +
        kpi('Injected campaigns caught', pct(m.detection_rate), 'at a ' + pct(m.operating_pfa, 1).replace('.0%', '%') + ' ' + term('pfa', 'false-alarm rate')) +
        kpi('False alarms on real accounts', pct(m.live_fpr), 'share of hand-labelled organic accounts we flagged') +
        kpi('Alerts that were right', pct(m.live_precision), 'precision on hand-labelled real accounts') +
        kpi('Time to decide', m.mean_posts_to_decision == null ? 'n/a' : m.mean_posts_to_decision.toFixed(1) + ' <small>posts</small>', secs == null ? 'mean posts before a verdict' : 'about ' + dur(secs) + ' after the first post, on average') +
        kpi('Hand-labelled accounts', String(m.n_labelled), m.n_labelled < 100 ? 'small sample: live rates are rough estimates' : 'real accounts checked by a person') +
      '</dl>' +
      '<div class="metrics-grid">' +
        '<div class="panel"><div class="block"><h3>Caught campaigns vs. false alarms</h3>' +
          '<p class="caption">ROC curve: each point is one sensitivity setting. Up is better (more campaigns caught), left is better (fewer false alarms). The dashed diagonal is what guessing would give.</p>' +
          '<div class="chart-box roc"><canvas id="roc-chart" role="img" aria-label="' + esc(rocAria(m)) + '"></canvas></div></div></div>' +
        '<div class="panel"><div class="block"><h3>Where we get it wrong</h3>' +
          '<p class="caption">' + (placeholder ? 'Illustrative cases of the kind we expect; real misses will replace them after the evaluation.' : 'Real mistakes from the evaluation, in plain words.') + '</p>' +
          failures(m) + '</div></div>' +
      '</div>' +
      '<div class="panel method"><div class="block"><h3>How these numbers are measured</h3>' +
        '<p>We cannot know the truth about every real account, so we measure two things separately. To measure how many campaigns we catch, we inject synthetic campaigns of our own into the live stream and count how many the detector finds; the injected messages are held out and never appear in the detector’s template bank, so it cannot simply recognise them. To measure false alarms, we hand-label a sample of real accounts as organic or suspicious and check how many organic ones were flagged. Synthetic campaigns are easier to catch than real ones, and the labelled sample is small, so read the rates as estimates rather than guarantees.</p>' +
      '</div></div>';

    drawRoc(m);
  }

  function failures(m) {
    const list = m.failure_examples || [];
    if (!list.length) return '<p class="caption">No failure examples in this report yet.</p>';
    return '<ul class="fails">' + list.map((x) => {
      const fp = x.kind === 'false_positive';
      return '<li><div class="fail-kind"><b>' + (fp ? 'False alarm' : 'Missed campaign') + '</b>' +
        '<span class="muted">' + (fp ? 'flagged, but innocent' : 'coordinated, but not flagged') + '</span>' +
        (x.account ? '<span class="mono">' + esc(x.account) + '</span>' : '') +
        (x.finding_id ? '<span class="mono">' + esc(x.finding_id) + '</span>' : '') +
        '</div><p>' + esc(x.note) + '</p></li>';
    }).join('') + '</ul>';
  }

  function operatingPoint(m) {
    if (m.operating_pfa == null || !m.roc.length) return null;
    if (m.detection_rate != null) return { x: m.operating_pfa, y: m.detection_rate };
    const near = m.roc.reduce((b, p) => (Math.abs(p[0] - m.operating_pfa) < Math.abs(b[0] - m.operating_pfa) ? p : b));
    return { x: near[0], y: near[1] };
  }
  function rocAria(m) {
    const op = operatingPoint(m);
    return 'ROC curve with ' + m.roc.length + ' points, false-alarm rate against share of campaigns caught.' +
      (op ? ' Operating point: ' + pct(op.y) + ' caught at ' + pct(op.x, 1) + ' false alarms.' : '');
  }

  function drawRoc(m) {
    const canvas = $('roc-chart');
    if (!canvas || noChart(canvas)) return;
    if (!m.roc || !m.roc.length) { canvas.parentElement.innerHTML = '<p class="chart-fallback">No ROC points in this report yet.</p>'; return; }
    const c = chartBase();
    const pts = m.roc.map((p) => ({ x: p[0], y: p[1] })).sort((a, b) => a.x - b.x || a.y - b.y);
    const op = operatingPoint(m);

    const opLabel = {
      id: 'ltrOp',
      afterDatasetsDraw(chart) {
        if (!op) return;
        const { ctx, scales: { x, y } } = chart;
        const px = x.getPixelForValue(op.x), py = y.getPixelForValue(op.y);
        ctx.save();
        ctx.fillStyle = c.ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        ctx.font = '600 12px ' + (token('--font-body') || 'sans-serif');
        ctx.fillText('We run here', px + 14, py + 4);
        ctx.font = '11px ' + c.font.family; ctx.fillStyle = c.ink2;
        ctx.fillText(pct(op.y) + ' caught, ' + pct(op.x, 1).replace('.0%', '%') + ' false alarms', px + 14, py + 20);
        ctx.restore();
      },
    };

    state.charts.roc = new Chart(canvas, {
      type: 'scatter',
      data: {
        datasets: [
          { label: 'Detector', data: pts, showLine: true, borderColor: c.line, backgroundColor: c.line, borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, pointBorderColor: c.surface, pointBorderWidth: 1, order: 2 },
          { label: 'Operating point', data: op ? [op] : [], backgroundColor: c.ink, borderColor: c.surface, borderWidth: 2, pointRadius: 8, pointHoverRadius: 10, order: 1 },
          { label: 'Guessing', data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], showLine: true, borderColor: c.ref, borderWidth: 1, borderDash: [5, 5], pointRadius: 0, pointHitRadius: 0, order: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          x: Object.assign(c.scale('False-alarm rate (innocent groups flagged)'), { min: 0, max: 1, ticks: { color: c.ink2, font: c.font, callback: (v) => Math.round(v * 100) + '%' } }),
          y: Object.assign(c.scale('Campaigns caught'), { min: 0, max: 1, ticks: { color: c.ink2, font: c.font, callback: (v) => Math.round(v * 100) + '%' } }),
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (item) => item.datasetIndex < 2,
            displayColors: false,
            callbacks: {
              title: (items) => (items[0] && items[0].datasetIndex === 1 ? 'Operating point' : 'Sensitivity setting'),
              label: (item) => [pct(item.parsed.y, 1) + ' of campaigns caught', pct(item.parsed.x, 1) + ' false alarms'],
            },
          },
        },
      },
      plugins: [opLabel],
    });
  }

  // ------------------------------------------------------------------ routing
  function currentView() {
    const h = location.hash.replace('#', '');
    if (h === 'metrics' || h === 'radar') return h;
    return /\/metrics\/?$/.test(location.pathname) ? 'metrics' : 'radar';
  }
  async function route() {
    const view = currentView();
    $('view-radar').hidden = view !== 'radar';
    $('view-metrics').hidden = view !== 'metrics';
    document.querySelectorAll('.views a').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (view === 'metrics') {
      if (!state.metrics) {
        renderMetrics();
        try { state.metrics = await Data.metrics(); } catch (e) { $('view-metrics').innerHTML = '<p class="notice">The accuracy report could not be loaded.</p>'; return; }
        $('demo-badge').hidden = !Data.mock;
      }
      renderMetrics();
    } else if (state.alerts) {
      renderCard(); // canvas was hidden; redraw at the right size
    }
  }

  // ------------------------------------------------------------------ inject
  function say(html) {
    const el = $('inject-msg');
    el.innerHTML = html;
    el.hidden = false;
  }
  async function onInject() {
    const btn = $('inject-btn');
    if (Data.mock) {
      say('<strong>Demo mode: nothing was sent.</strong> On the live server this button calls <code>POST /api/inject</code>, which adds a synthetic swarm of test accounts to the real stream. The detector then has to find it on its own, and a new alert appears here within a minute. The highlighted alert below is what that looks like.');
      const synth = state.alerts.findings.find((f) => f.synthetic);
      if (synth) {
        if (currentView() !== 'radar') location.hash = '#radar';
        select(synth.id);
        const row = document.querySelector('.feed-row[data-id="' + synth.id + '"]');
        if (row) { row.classList.remove('pulse'); void row.offsetWidth; row.classList.add('pulse'); }
      }
      return;
    }
    btn.disabled = true;
    try {
      await Data.inject();
      say('<strong>Test campaign injected.</strong> Synthetic accounts are now posting into the live stream. The detector has to find them on its own; the alert should appear here within a minute.');
      setTimeout(refresh, 8000);
    } catch (e) {
      say('<strong>Could not inject the test campaign.</strong> The server did not accept the request. Try again in a moment.');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------ boot
  async function refresh() {
    let alerts;
    try { alerts = await Data.alerts(); }
    catch (e) {
      if (!state.alerts) {
        $('updated').textContent = 'No data available';
        $('card').innerHTML = '<div class="block"><p class="notice">Alerts could not be loaded and no demo data is bundled with this page.</p></div>';
      }
      return;
    }
    const ids = [...new Set(alerts.findings.flatMap((f) => f.item_ids))].filter((id) => !state.items[id]);
    try { Object.assign(state.items, await Data.items(ids)); } catch (e) { /* card degrades to "texts not available" */ }

    const before = JSON.stringify(state.alerts && state.alerts.findings);
    state.alerts = alerts;
    renderHeader();
    if (before === JSON.stringify(alerts.findings)) return; // nothing new: keep the card (and hover state) as is

    const known = alerts.findings.some((f) => f.id === state.selected);
    if (!known) {
      const first = alerts.findings.find((f) => f.verdict === 'coordinated') || alerts.findings[0];
      state.selected = first ? first.id : null;
    }
    renderFeed();
    if (currentView() === 'radar') renderCard();
  }

  function redrawCharts() {
    if (!state.alerts) return;
    if (currentView() === 'radar') renderCard(); else renderMetrics();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('feed').addEventListener('click', (e) => {
      const row = e.target.closest('.feed-row');
      if (row) select(row.dataset.id, { scroll: true });
    });
    $('inject-btn').addEventListener('click', onInject);
    window.addEventListener('hashchange', route);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawCharts);
    new MutationObserver(redrawCharts).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    await refresh();
    await route();
    if (!Data.mock) setInterval(refresh, POLL_MS);
  });
})();
