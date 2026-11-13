/* Live Truth Radar dashboard. Plain JS, no build step.
   Data shapes: contracts/models.py (TopicStatus, AlertsResponse, Item, MetricsReport). */
(function () {
  'use strict';

  // ------------------------------------------------------------------ data layer
  // The only place that knows where data comes from. Wire the real API here.
  //   GET  /api/topics            -> TopicStatus[]
  //   POST /api/topics {query}    -> TopicStatus
  //   GET  /api/alerts?topic=     -> AlertsResponse
  //   GET  /api/items?ids=a,b,c   -> Item[]
  //   GET  /api/metrics           -> MetricsReport
  //   POST /api/inject {topic}    -> {campaign_id, topic, n_items}
  // Without an API (or when the first call fails) it serves window.LTR_MOCK and simulates the scan clock.
  const MOCK_POLL_SEC = 180;
  const Data = {
    mock: false,
    base: resolveApiBase(), // null = no API for this page, use window.LTR_MOCK
    onMockChange: null, // UI hook: a simulated topic changed state
    _live: false, // at least one API call succeeded: never swap live data for demo data afterwards
    _t0: Date.now(),
    _topics: null,

    async _json(path, opts) {
      if (this.mock || this.base === null) throw new Error('no API configured');
      const res = await fetch(this.base + path, opts);
      if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
      const body = await res.json();
      this._live = true;
      return body;
    },
    _post(path, payload) {
      return this._json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    },
    _fallback(err) {
      if (this._live) throw err; // transient API error: keep what is on screen
      if (!window.LTR_MOCK) throw new Error('API unreachable and mock-data.js missing');
      if (!this.mock) {
        this.mock = true;
        this._topics = JSON.parse(JSON.stringify(window.LTR_MOCK.topics || []));
      }
      return window.LTR_MOCK;
    },
    /** "Now" for relative times. Demo data is frozen, so its clock starts at its own generation time. */
    now() {
      return this.mock ? Date.parse(window.LTR_MOCK.alerts.generated_at) + (Date.now() - this._t0) : Date.now();
    },
    /** -> TopicStatus[] */
    async topics() {
      try { return await this._json('/api/topics'); }
      catch (e) {
        this._fallback(e);
        const now = this.now();
        this._topics.forEach((t) => { // simulated scan cycle: 2 s after "next scan" the cycle restarts
          if (t.status !== 'watching' || !t.next_poll_at) return;
          while (Date.parse(t.next_poll_at) + 2000 <= now) {
            t.last_poll_at = new Date(Date.parse(t.next_poll_at) + 2000).toISOString();
            t.next_poll_at = new Date(Date.parse(t.last_poll_at) + MOCK_POLL_SEC * 1000).toISOString();
          }
        });
        return this._topics.map((t) => Object.assign({}, t));
      }
    },
    /** -> TopicStatus */
    async addTopic(query) {
      if (!this.mock) {
        try { return await this._post('/api/topics', { query }); }
        catch (e) { if (this._live) throw e; this._fallback(e); }
      }
      const slug = query.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'topic';
      let t = this._topics.find((x) => x.topic === slug);
      if (t) return Object.assign({}, t);
      t = { topic: slug, query, status: 'scanning', created_at: new Date(this.now()).toISOString(), last_poll_at: null, next_poll_at: null, n_items: 0, n_accounts: 0, n_coordinated: 0, note: null };
      this._topics.push(t);
      setTimeout(() => {
        t.status = 'watching';
        t.last_poll_at = new Date(this.now()).toISOString();
        t.next_poll_at = new Date(this.now() + MOCK_POLL_SEC * 1000).toISOString();
        t.note = 'Demo mode: no live data for new topics';
        if (this.onMockChange) this.onMockChange();
      }, 3500);
      return Object.assign({}, t);
    },
    /** -> AlertsResponse */
    async alerts(topic) {
      try { return await this._json('/api/alerts?topic=' + encodeURIComponent(topic)); }
      catch (e) {
        const a = this._fallback(e).alerts;
        return Object.assign({}, a, { findings: a.findings.filter((f) => f.topic === topic) });
      }
    },
    /** -> { [id]: Item } */
    async items(ids) {
      if (!ids.length) return {};
      try {
        const list = await this._json('/api/items?ids=' + encodeURIComponent(ids.join(',')));
        return Object.fromEntries(list.map((it) => [it.id, it]));
      } catch (e) {
        const m = this._fallback(e);
        return Object.fromEntries(ids.filter((id) => m.items[id]).map((id) => [id, m.items[id]]));
      }
    },
    /** -> MetricsReport */
    async metrics() {
      try { return await this._json('/api/metrics'); }
      catch (e) { return this._fallback(e).metrics; }
    },
    /** POST /api/inject (live only) -> {campaign_id, topic, n_items} */
    inject(topic) {
      return this._post('/api/inject', { topic });
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
  const WINDOW_HOURS = 6; // detector window (DETECT_WINDOW_HOURS on the server; not part of the contract)
  const state = {
    topics: [], topic: null, alerts: null, alertsTopic: null, items: {}, metrics: null,
    charts: {}, burst: {}, seq: 0, lastAuto: 0,
  };

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const pad = (n) => String(n).padStart(2, '0');
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
  const nf = (n) => Number(n).toLocaleString('en-US');

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
  /** Upper bound in plain words: 82 s -> "2 minutes", 40 s -> "40 seconds". */
  function within(sec) {
    if (sec < 60) return plural(Math.max(10, Math.ceil(sec / 10) * 10), 'second');
    return plural(Math.ceil(sec / 60), 'minute');
  }
  function ago(ms) {
    const min = Math.floor(Math.max(0, ms) / 60000);
    return min < 1 ? 'just now' : min < 120 ? min + ' min ago' : Math.round(min / 60) + ' h ago';
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
  const who = (author, synthetic) => '<span class="who">' + esc(handle(author, synthetic)) + (synthetic ? '<span class="tag-test" title="A fake account we planted ourselves to test the radar.">test</span>' : '') + '</span>';

  const currentTopic = () => state.topics.find((t) => t.topic === state.topic) || null;
  const findings = () => (state.alerts && state.alertsTopic === state.topic ? state.alerts.findings : []);
  const itemsOf = (f) => f.item_ids.map((id) => state.items[id]).filter(Boolean).sort((a, b) => new Date(a.published_at) - new Date(b.published_at));

  /** Group posts into bursts: a gap of more than 3 minutes starts a new one. "Tight" = 3+ accounts in one burst. */
  function burstsOf(items) {
    const all = [];
    items.forEach((it) => {
      const t = +new Date(it.published_at), last = all[all.length - 1];
      if (last && t - last.end <= 180000) { last.items.push(it); last.end = t; }
      else all.push({ start: t, end: t, items: [it] });
    });
    return all.filter((b) => new Set(b.items.map((i) => i.author)).size >= 3);
  }

  /** Mark the words that most posts of one burst share: "the same message in different words". */
  const WORD = /[\p{L}\p{N}#]+(?:['’][\p{L}]+)?/gu;
  const STOP = new Set(['this', 'that', 'with', 'from', 'they', 'them', 'their', 'have', 'will', 'just', 'what', 'your', 'about', 'there', 'were', 'been']);
  const normWord = (w) => w.toLowerCase().replace(/['’]s?$/, '').replace(/['’]/g, '');
  function sharedWords(posts) {
    const df = new Map();
    posts.forEach((p) => new Set((p.text.match(WORD) || []).map(normWord)).forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
    const need = Math.max(2, Math.ceil(posts.length * 0.6));
    return new Set([...df].filter(([w, n]) => n >= need && w.length >= 4 && !STOP.has(w)).map(([w]) => w));
  }
  function markShared(text, shared) {
    let out = '', last = 0;
    for (const m of text.matchAll(WORD)) {
      out += esc(text.slice(last, m.index));
      out += shared.has(normWord(m[0])) ? '<mark>' + esc(m[0]) + '</mark>' : esc(m[0]);
      last = m.index + m[0].length;
    }
    return (out + esc(text.slice(last))).replace(/<\/mark>( ?)<mark>/g, '$1');
  }

  // ------------------------------------------------------------------ topic tabs + live status
  function renderTabs() {
    $('tabs').innerHTML = state.topics.length
      ? state.topics.map((t) => '<button type="button" class="tab" data-topic="' + esc(t.topic) + '" aria-pressed="' + (t.topic === state.topic) + '">' +
          (t.n_coordinated > 0 ? '<i class="tab-dot" aria-hidden="true"></i>' : '') + esc(t.query) +
          (t.n_coordinated > 0 ? '<span class="sr-only"> (' + plural(t.n_coordinated, 'coordinated group') + ')</span>' : '') + '</button>').join('')
      : '<span class="muted">Nothing yet. Type a topic above to start.</span>';
  }

  function renderLive() {
    const t = currentTopic(), el = $('live');
    $('demo-badge').hidden = !Data.mock;
    if (!t) { el.innerHTML = ''; return; }
    const counts = t.n_items > 0
      ? '<span>' + nf(t.n_items) + ' posts from ' + nf(t.n_accounts) + ' accounts scanned</span>'
      : '';
    const msg = $('inject-msg');
    const keep = msg && msg.dataset.topic === t.topic ? msg.innerHTML : '';
    el.innerHTML =
      '<p class="live-line" data-status="' + esc(t.status) + '">' +
        '<span class="live-state"><i class="pulse-dot" aria-hidden="true"></i><strong id="st-state"></strong></span>' +
        counts + '<span id="st-last"></span><span id="st-next"></span></p>' +
      (t.note ? '<p class="live-note">' + esc(t.note) + '</p>' : '') +
      '<div class="test">' +
        '<button id="inject-btn" type="button" class="btn"' + (t.status === 'watching' ? '' : ' disabled') + '>Run a test: plant a fake bot group</button>' +
        '<span class="test-why">We add our own fake accounts to this stream. If the radar works, it catches them within a minute.</span>' +
      '</div>' +
      '<p id="inject-msg" class="inline-msg" role="status" data-topic="' + esc(t.topic) + '"' + (keep ? '' : ' hidden') + '>' + keep + '</p>';
    tick();
  }

  /** Runs every second: only touches the three text nodes of the status line. */
  function tick() {
    const t = currentTopic();
    if (!t || !$('st-state')) return;
    const now = Data.now();
    const left = t.next_poll_at ? Math.ceil((Date.parse(t.next_poll_at) - now) / 1000) : null;
    let label, next = '';
    if (t.status === 'scanning') label = 'First scan running…';
    else if (t.status === 'expired') label = 'Paused';
    else if (t.status === 'error') label = 'Scan failed';
    else if (left != null && left <= 0) label = 'Scanning now…';
    else {
      label = 'Watching live';
      if (left != null) next = 'next scan in <b class="num">' + Math.floor(left / 60) + ':' + pad(left % 60) + '</b>';
    }
    set('st-state', label);
    set('st-last', t.last_poll_at ? 'last scan ' + ago(now - Date.parse(t.last_poll_at)) : '');
    set('st-next', next, true);
    $('live').firstElementChild.dataset.busy = String(t.status === 'scanning' || (t.status === 'watching' && left != null && left <= 0));

    // A scan is due (or the first one is still running): ask for fresh data, at most every 5 s.
    const due = (t.status === 'watching' && left != null && left <= 0) || t.status === 'scanning';
    if (due && Date.now() - state.lastAuto > (Data.mock ? 900 : 5000)) {
      state.lastAuto = Date.now();
      if (Data.mock) softTopics(); else refresh();
    }
  }
  function set(id, text, html) {
    const el = $(id);
    if (!el) return;
    if (html) { if (el.innerHTML !== text) el.innerHTML = text; } else if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }
  /** Mock only: re-read the simulated topics; re-render when something other than the clock changed. */
  async function softTopics() {
    const before = currentTopic();
    state.topics = await Data.topics();
    const after = currentTopic();
    if (before && after && (before.status !== after.status || before.note !== after.note)) { renderLive(); renderAnswer(); }
  }

  // ------------------------------------------------------------------ the answer
  function renderAnswer() {
    const t = currentTopic(), el = $('answer');
    if (!t) { el.innerHTML = state.loaded ? '<p class="answer-sub">No topic is being watched yet. Type one above.</p>' : '<p class="answer-sub">Loading…</p>'; return; }
    const fs = findings();
    const coord = fs.filter((f) => f.verdict === 'coordinated');
    const watching = fs.filter((f) => f.verdict === 'watching').length;
    const n = state.alertsTopic === state.topic ? coord.length : t.n_coordinated;
    const q = '“' + esc(t.query) + '”';
    let kind, big, title, sub;

    if (t.status === 'scanning') {
      kind = 'wait'; big = '…';
      title = 'Scanning ' + q + ' for the first time';
      sub = 'Pulling the last ' + WINDOW_HOURS + ' hours of public posts and news. The first answer appears here in a few seconds.';
    } else if (t.status === 'error') {
      kind = 'wait'; big = '!';
      title = 'We could not scan ' + q;
      sub = t.note ? '' : 'The last scan failed. We will try again on the next cycle.';
    } else if (n > 0) {
      kind = 'coord'; big = String(n);
      title = (n === 1 ? 'coordinated group' : 'coordinated groups') + ' found in the last ' + WINDOW_HOURS + ' hours';
      const accs = coord.reduce((s, f) => s + f.accounts.length, 0);
      sub = (accs ? plural(accs, 'account') + (accs === 1 ? ' is' : ' are') + ' posting the same message in step. ' : '') +
        (coord.length && coord.every((f) => f.synthetic) ? 'This one is a test group we planted ourselves, and the radar caught it. ' : '') +
        'The evidence is below.';
    } else if (t.n_items === 0) {
      kind = 'calm'; big = '0';
      title = 'No coordinated groups so far';
      sub = t.status === 'expired' ? 'This topic is paused. Search for it again to resume scanning.' : 'No posts collected for ' + q + ' yet.';
    } else {
      kind = 'calm'; big = '0';
      title = 'No coordinated groups so far';
      sub = nf(t.n_items) + ' posts from ' + nf(t.n_accounts) + ' accounts look independent: people use their own words at their own times.' +
        (watching ? ' We keep an eye on ' + plural(watching, 'group') + ' below.' : '');
    }
    el.dataset.kind = kind;
    el.innerHTML = '<p class="answer-big" aria-hidden="true">' + big + '</p>' +
      '<div><h2 class="answer-title">' + (kind === 'coord' ? '<span class="sr-only">' + big + ' </span>' : '') + title + '</h2>' +
      (sub ? '<p class="answer-sub">' + sub + '</p>' : '') + '</div>';
  }

  // ------------------------------------------------------------------ group cards
  function destroyChart(key) {
    if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
  }
  function renderGroups() {
    Object.keys(state.charts).filter((k) => k.startsWith('sprt')).forEach(destroyChart);
    const fs = findings(), el = $('groups');
    const coord = fs.filter((f) => f.verdict === 'coordinated');
    const watch = fs.filter((f) => f.verdict === 'watching');
    const organic = fs.filter((f) => f.verdict === 'organic');
    const idx = (f) => fs.indexOf(f);
    el.innerHTML =
      coord.map((f) => coordCard(f, idx(f))).join('') +
      (watch.length ? '<h2 class="groups-h">Still watching</h2><p class="groups-sub">Groups that caught our eye but have not shown a pattern. No verdict until the evidence is clear.</p>' +
        watch.map((f) => watchCard(f, idx(f))).join('') : '') +
      (organic.length ? '<p class="groups-organic">' + plural(organic.length, 'other group') + ' checked and cleared: they post independently.</p>' : '');
    fs.forEach((f, i) => bindHeatmap(f, el.querySelector('.how[data-i="' + i + '"]')));
  }

  function confidenceWords(c) {
    return c >= 0.75 ? 'High confidence' : c >= 0.5 ? 'Medium confidence' : 'Low confidence';
  }
  function headline(f, tight) {
    const n = plural(f.accounts.length, 'account');
    if (!tight.length) return n + ' are posting the same message in step';
    const span = Math.max(...tight.map((b) => (b.end - b.start) / 1000));
    const k = tight.length;
    return n + ' posted the same message ' + (k === 1 ? '' : k === 2 ? 'twice, each time ' : k + ' times, each time ') + 'within ' + within(span);
  }

  function coordCard(f, i) {
    const items = itemsOf(f), tight = burstsOf(items), e = f.explanation;
    return '<article class="group" data-verdict="coordinated" data-i="' + i + '"' + (f.synthetic ? ' data-synth' : '') + '>' +
      '<p class="group-meta"><span class="verdict">Coordinated</span>' +
        (f.synthetic ? '<span class="planted" title="Contains posts we planted ourselves to test the radar.">Our planted test group</span>' : '') +
        (e ? '<span class="conf" title="How sure the explanation model is about the technique.">' + confidenceWords(e.confidence) + ' <span class="num">' + pct(e.confidence) + '</span></span>' : '') + '</p>' +
      '<h2 class="group-title">' + esc(headline(f, tight)) + '</h2>' +
      (e ? '<p class="group-why">' + esc(e.summary) + '</p><p class="group-tech"><span>How they push it:</span> ' + esc(e.technique) + '</p>'
         : '<p class="group-why">Their posts are reworded copies of one another and arrive seconds apart. One account alone would not stand out; together the pattern is clear.</p>') +
      '<div class="evidence" id="ev-' + i + '">' + evidence(f, i, items, tight) + '</div>' +
      howWeKnow(f, i) +
      '</article>';
  }

  function evidence(f, i, items, tight) {
    if (!items.length) return '<p class="caption">The post texts are not available right now.</p>';
    if (!tight.length) return strip(f, items);
    const sel = Math.min(state.burst[f.id] || 0, tight.length - 1);
    const b = tight[sel];
    const shared = sharedWords(b.items);
    const nAcc = new Set(b.items.map((x) => x.author)).size;
    return '<h3 class="ev-h">Same message, ' + nAcc + ' accounts, ' + dur((b.end - b.start) / 1000) + ' apart at most</h3>' +
      '<ol class="posts">' + b.items.map((it) => {
        const t = +new Date(it.published_at);
        return '<li><span class="off">' + (t === b.start ? hm(it.published_at, true) : '+' + dur((t - b.start) / 1000)) + '</span>' +
          who(it.author, it.synthetic) + '<span class="txt">' + markShared(it.text, shared) + '</span></li>';
      }).join('') + '</ol>' +
      '<p class="ev-key"><mark>Highlighted</mark> = words most of these posts share. Times are UTC.</p>' +
      (tight.length > 1
        ? '<div class="times"><span id="times-' + i + '">This happened ' + tight.length + ' times. Pick one to read it:</span>' +
          '<span class="times-list" role="group" aria-labelledby="times-' + i + '">' +
          tight.map((x, k) => '<button type="button" class="time" data-i="' + i + '" data-k="' + k + '" aria-pressed="' + (k === sel) + '">' + hm(new Date(x.start).toISOString()) + '</button>').join('') + '</span></div>'
        : '') +
      strip(f, items);
  }

  /** Slim per-account timeline: one row per account, one tick per post. Ticks that line up = posted together. */
  function strip(f, items) {
    const t0 = +new Date(f.first_seen), span = Math.max(1, +new Date(f.last_seen) - t0);
    let h = '<div class="strip" role="img" aria-label="Posting times of each account between ' + hm(f.first_seen) + ' and ' + hm(f.last_seen) + ' UTC">';
    f.accounts.forEach((acc) => {
      const mine = items.filter((it) => it.author === acc);
      h += '<div class="strip-row"><span class="strip-label">' + esc(handle(acc, accountIsSynthetic(f, acc))) + '</span><span class="strip-track">' +
        mine.map((it) => '<i style="left:' + (((+new Date(it.published_at) - t0) / span) * 100).toFixed(2) + '%"></i>').join('') +
        '</span></div>';
    });
    return h + '<div class="strip-row"><span></span><span class="strip-axis"><span>' + hm(f.first_seen) + '</span><span>' + hm(f.last_seen) + ' UTC</span></span></div></div>' +
      '<p class="caption">Each row is one account, each tick one post. Ticks stacked in a column were posted at almost the same moment.</p>';
  }

  function watchCard(f, i) {
    const items = itemsOf(f);
    return '<details class="group group-quiet" data-verdict="watching" data-i="' + i + '">' +
      '<summary><span class="verdict">Keep watching</span><span class="quiet-title">' + plural(f.accounts.length, 'account') + ', ' + plural(f.item_ids.length, 'post') +
        ': same topic, but not in step so far</span></summary>' +
      '<div class="quiet-body"><p class="group-why">Their wording and timing do not line up. We would rather wait than raise a false alarm.</p>' +
      (items.length ? strip(f, items) : '') + howWeKnow(f, i) + '</div></details>';
  }

  // ---- "How we know": the math, collapsed by default
  function howWeKnow(f, i) {
    const k = f.decided_at_item;
    const sprt = k != null
      ? 'Every new post adds or removes evidence. The verdict came at post ' + (k + 1) + ' of ' + f.item_ids.length + ', the moment the line crossed a threshold.'
      : 'Every new post adds or removes evidence. The line is still between the two thresholds, so there is no verdict yet.';
    return '<details class="how" data-i="' + i + '"><summary>How we know</summary><div class="how-body">' +
      snrBlock(f) +
      '<section><h3>Who posts in step with whom</h3>' +
        '<p>Each square compares two accounts. Bright means they post at the same moments again and again; independent people stay dark.</p>' +
        heatmap(f) + '</section>' +
      '<section><h3>How the evidence added up</h3><p>' + sprt + '</p>' +
        '<div class="chart-box"><canvas id="sprt-' + i + '" role="img" aria-label="' + esc(sprtAria(f)) + '"></canvas></div></section>' +
      '<p class="caption">The detection is timing and wording math (correlation, a sequential test). A language model only writes the short description of the technique.</p>' +
      '</div></details>';
  }

  function snrBlock(f) {
    if (f.snr_db_single == null && f.snr_db == null) return '';
    const lo = Math.min(-6, (f.snr_db_single == null ? 0 : f.snr_db_single) - 2), hi = Math.max(18, f.snr_db + 2);
    const pos = (v) => ((v - lo) / (hi - lo)) * 100;
    const bar = (label, v, cls) => v == null ? '' :
      '<div class="snr-row"><span class="snr-label">' + label + '</span><span class="snr-track"><i class="snr-zero" style="left:' + pos(0).toFixed(1) + '%"></i>' +
      '<i class="snr-bar ' + cls + '" style="left:' + Math.min(pos(0), pos(v)).toFixed(1) + '%;width:' + Math.max(1.2, Math.abs(pos(v) - pos(0))).toFixed(1) + '%"></i></span>' +
      '<span class="snr-val num">' + db(v) + ' dB</span></div>';
    const lift = f.snr_db_single != null && f.snr_db - f.snr_db_single >= 6;
    return '<section><h3>One account vs. the whole group</h3>' +
      '<p>' + (lift
        ? 'Alone, each account is lost in the background chatter. Added together they stand out clearly: the pattern only exists as a group.'
        : 'Adding these accounts together barely lifts them above the background chatter, so there is no group pattern to speak of.') + '</p>' +
      '<div class="snr" role="img" aria-label="Signal strength against background chatter: one account ' + db(f.snr_db_single) + ' decibels, whole group ' + db(f.snr_db) + ' decibels">' +
      bar('One account', f.snr_db_single, 'one') + bar('Whole group', f.snr_db, 'all') +
      '<div class="snr-row"><span></span><span class="snr-axis"><span style="left:' + pos(0).toFixed(1) + '%">background chatter</span></span><span></span></div></div></section>';
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
        if (i === j) { h += '<span class="heat-cell diag" aria-hidden="true">·</span>'; continue; }
        const v = Math.max(0, Math.min(1, c));
        h += '<button type="button" class="heat-cell' + (v > 0.5 ? ' hi' : '') + '" style="--v:' + v.toFixed(3) + '" data-i="' + i + '" data-j="' + j + '"' +
          ' aria-label="' + esc(pairText(f, i, j, true)) + '">' + c.toFixed(2).replace(/^0\./, '.') + '</button>';
      }
    }
    return h + '</div></div>' +
      '<div class="heat-scale"><span>0 = unrelated</span><i></i><span>1 = always in step</span></div>' +
      '<p class="heat-readout">' + heatSummary(f) + '</p>';
  }
  function heatSummary(f) {
    const vals = [];
    f.correlation.forEach((row, i) => row.forEach((c, j) => { if (i < j) vals.push(c); }));
    if (!vals.length) return '';
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return 'Average between pairs: <b class="num">' + mean.toFixed(2) + '</b>. ' +
      (mean > 0.6 ? 'These accounts move together.' : mean < 0.25 ? 'These accounts post independently of each other.' : 'Some overlap, nothing conclusive.') +
      ' Hover or tap a square for one pair.';
  }
  function pairText(f, i, j, plain) {
    const a = handle(f.accounts[i], accountIsSynthetic(f, f.accounts[i]));
    const b = handle(f.accounts[j], accountIsSynthetic(f, f.accounts[j]));
    const c = f.correlation[i][j].toFixed(2);
    const lag = f.lag_sec ? f.lag_sec[i][j] : null;
    // Only the size of the offset is stated; who leads is not something the reader needs here.
    const lagTxt = lag == null ? '' : Math.abs(lag) < 0.5 ? ', no measurable time offset' : ', typically ' + dur(lag) + ' apart';
    if (plain) return a + ' and ' + b + ': in step ' + c + lagTxt;
    return '<b>' + esc(a) + '</b> and <b>' + esc(b) + '</b>: in step <b class="num">' + c + '</b> out of 1' + esc(lagTxt);
  }
  function bindHeatmap(f, root) {
    const out = root && root.querySelector('.heat-readout');
    if (!out) return;
    const cells = root.querySelectorAll('.heat-cell:not(.diag)');
    const show = (cell) => {
      cells.forEach((c) => c.classList.toggle('on', c === cell));
      out.innerHTML = cell ? pairText(f, +cell.dataset.i, +cell.dataset.j, false) : heatSummary(f);
    };
    cells.forEach((cell) => {
      cell.addEventListener('mouseenter', () => show(cell));
      cell.addEventListener('focus', () => show(cell));
      cell.addEventListener('click', () => show(cell));
    });
    const grid = root.querySelector('.heat');
    grid.addEventListener('mouseleave', () => { if (!grid.contains(document.activeElement)) show(null); });
  }

  // ---- SPRT trace
  function sprtAria(f) {
    const k = f.decided_at_item;
    return 'Line chart of the running evidence after each post, from ' + signed(f.sprt_trace[0] || 0) + ' to ' + signed(f.llr) +
      '. Coordinated threshold at ' + signed(f.sprt_upper) + ', independent threshold at ' + signed(f.sprt_lower) + '. ' +
      (k != null ? 'Decided at post ' + (k + 1) + '.' : 'No decision yet.');
  }
  function drawOpenCharts() {
    document.querySelectorAll('#groups details.how[open]').forEach((d) => {
      if (d.closest('details.group:not([open])')) return;
      const i = +d.dataset.i, f = findings()[i];
      if (f) drawSprt(f, $('sprt-' + i), 'sprt-' + i);
    });
    const roc = document.querySelector('#view-metrics details.curve[open]');
    if (roc && state.metrics) drawRoc(state.metrics);
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
  function noChart(canvas) {
    if (window.Chart) return false;
    if (canvas) canvas.parentElement.innerHTML = '<p class="chart-fallback">Chart library could not be loaded. The numbers in the text still apply.</p>';
    return true;
  }

  function drawSprt(f, canvas, key) {
    destroyChart(key);
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
        ctx.fillText('independent ≤ ' + signed(f.sprt_lower), a.left + 6, y.getPixelForValue(f.sprt_lower) + 4);
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

    state.charts[key] = new Chart(canvas, {
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
          { label: 'Independent line', data: [{ x: 0.5, y: f.sprt_lower }, { x: n + 0.5, y: f.sprt_lower }], borderColor: c.organic, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, pointHitRadius: 0, order: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: Object.assign(c.scale('Post number, in time order'), { type: 'linear', min: 0.5, max: n + 0.5, ticks: { stepSize: 1, color: c.ink2, font: c.font, callback: (v) => (Number.isInteger(v) ? v : '') } }),
          y: Object.assign(c.scale('Evidence so far'), { min: yMin, max: yMax, ticks: { includeBounds: false, color: c.ink2, font: c.font } }),
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
                return ['Evidence so far ' + signed(trace[i]), 'This post added ' + signed(step)].concat(i === k ? ['Decision line crossed here'] : []);
              },
            },
          },
        },
      },
      plugins: [labels],
    });
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
    destroyChart('roc');
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

  // ------------------------------------------------------------------ accuracy view
  function renderMetrics() {
    const el = $('view-metrics');
    const m = state.metrics;
    destroyChart('roc');
    if (!m) { el.innerHTML = '<p class="caption">Loading the accuracy report…</p>'; return; }

    const placeholder = Data.mock;
    const devEmbedder = !placeholder && m.embedder && m.embedder !== 'gemini';
    const big = (lead, val, tail, sub) => '<li><p class="kpi-line">' + lead + ' <b>' + val + '</b> ' + tail + '</p><p class="kpi-sub">' + sub + '</p></li>';
    const pending = '<span class="muted">not measured yet</span>';
    const fa = m.operating_pfa == null ? '' : pct(m.operating_pfa, 1).replace('.0%', '%');

    el.innerHTML =
      (placeholder ? '<p class="notice" role="note"><strong>Example numbers — real evaluation pending.</strong> This page shows bundled demo data. The figures only illustrate the layout; they are not measured results.</p>' : '') +
      (devEmbedder ? '<p class="notice" role="note"><strong>Development run.</strong> This report was computed with a test text model (“' + esc(m.embedder) + '”), not the production one. Treat the numbers as provisional.</p>' : '') +
      '<h1>How accurate is it?</h1>' +
      '<p class="hero-sub">We test the radar two ways: we plant fake campaigns into the live stream and count how many it catches, and a person hand-checks real accounts it flagged.</p>' +
      '<ul class="kpis">' +
        big('Catches', m.detection_rate == null ? pending : pct(m.detection_rate), 'of planted campaigns', fa ? 'with the alarm set so that about ' + fa + ' of innocent groups would trip it' : 'on campaigns we planted ourselves') +
        big('Wrongly flags', m.live_fpr == null ? pending : pct(m.live_fpr), 'of real accounts', m.n_labelled ? 'among ' + plural(m.n_labelled, 'real account') + ' checked by hand' + (m.n_labelled < 100 ? ' (small sample, rough estimate)' : '') : 'no hand-checked accounts yet') +
        big('Decides after', m.mean_posts_to_decision == null ? pending : '~' + Math.round(m.mean_posts_to_decision), 'posts', m.mean_seconds_to_decision == null ? 'on average, counted from the first post of a group' : 'on average about ' + dur(m.mean_seconds_to_decision) + ' after a group’s first post') +
      '</ul>' +
      '<section class="m-sec"><h2>Where we get it wrong</h2>' +
        '<p class="caption">' + (placeholder ? 'Illustrative cases of the kind we expect; real mistakes will replace them after the evaluation.' : 'Real mistakes from the evaluation, in plain words.') + '</p>' +
        failures(m) + '</section>' +
      '<details class="curve"><summary>Show the curve</summary><div class="how-body">' +
        '<p>Each point is one sensitivity setting. Higher is better (more campaigns caught), further left is better (fewer false alarms). The dashed diagonal is what guessing would give.</p>' +
        '<div class="chart-box roc"><canvas id="roc-chart" role="img" aria-label="' + esc(rocAria(m)) + '"></canvas></div></div></details>' +
      '<section class="m-sec"><h2>How we measure</h2>' +
        '<p class="method">Nobody knows the truth about every real account, so we measure two things separately. For the catch rate we plant our own fake campaigns, written with messages the radar has never seen, so it cannot simply recognise them. For false alarms a person labels a sample of real accounts and we check how many innocent ones were flagged. Planted campaigns are easier to catch than real ones, so read these as estimates, not guarantees.</p>' +
        '<p class="caption">Report from <span class="num">' + esc(new Date(m.generated_at).toISOString().slice(0, 16).replace('T', ' ')) + ' UTC</span>' + (m.embedder ? ' · text model: <span class="num">' + esc(m.embedder) + '</span>' : '') + '</p></section>';
  }

  function failures(m) {
    const list = m.failure_examples || [];
    if (!list.length) return '<p class="caption">No examples in this report yet.</p>';
    return '<ul class="fails">' + list.map((x) => {
      const fp = x.kind === 'false_positive';
      return '<li><p class="fail-kind"><b>' + (fp ? 'False alarm' : 'Missed campaign') + '</b> ' +
        '<span class="muted">' + (fp ? 'flagged, but innocent' : 'coordinated, but not flagged') + '</span></p><p>' + esc(x.note) + '</p></li>';
    }).join('') + '</ul>';
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
    } else {
      drawOpenCharts(); // canvases were hidden; redraw at the right size
    }
  }

  // ------------------------------------------------------------------ run a test
  function say(html) {
    const el = $('inject-msg');
    if (!el) return;
    el.innerHTML = html;
    el.hidden = false;
  }
  function flashPlanted() {
    const card = document.querySelector('#groups .group[data-synth]');
    if (!card) return false;
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
    card.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    return true;
  }
  async function onInject(btn) {
    const t = currentTopic();
    if (!t) return;
    if (Data.mock) {
      const here = findings().some((f) => f.synthetic);
      const demo = (window.LTR_MOCK.alerts.findings.find((f) => f.synthetic) || {}).topic;
      const other = state.topics.find((x) => x.topic === demo);
      say('<strong>Demo mode: nothing was planted.</strong> On the live site this adds a group of fake accounts to the real stream, and the radar has to catch it on its own within about a minute. ' +
        (here ? 'The highlighted group below is a caught test.'
          : other ? '<button type="button" class="link" data-goto="' + esc(other.topic) + '">See a caught test in “' + esc(other.query) + '”</button>' : ''));
      if (here) flashPlanted();
      return;
    }
    btn.disabled = true;
    try {
      const r = await Data.inject(t.topic);
      say('<strong>Planted ' + (r && r.n_items ? plural(r.n_items, 'fake post') : 'a fake bot group') + ' into “' + esc(t.query) + '”.</strong> Nobody told the radar where they are. If it works, a new coordinated group appears below within about a minute.');
      [8000, 20000, 45000].forEach((ms) => setTimeout(refresh, ms));
    } catch (e) {
      say('<strong>Could not run the test.</strong> The server did not accept the request. Try again in a moment.');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------ topics
  function topicMsg(text) {
    const el = $('topic-msg');
    el.textContent = text || '';
    el.hidden = !text;
  }
  async function onWatch(e) {
    e.preventDefault();
    const input = $('topic-input');
    const query = input.value.trim().replace(/\s+/g, ' ');
    if (!query) { input.focus(); return; }
    topicMsg('');
    const known = state.topics.find((t) => t.query.toLowerCase() === query.toLowerCase());
    if (known) { input.value = ''; selectTopic(known.topic); return; }
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const t = await Data.addTopic(query);
      state.topics = state.topics.filter((x) => x.topic !== t.topic).concat([t]);
      input.value = '';
      selectTopic(t.topic);
    } catch (err) {
      topicMsg('Could not start watching “' + query + '”. We watch a limited number of topics at once; try again in a moment or pick one below.');
    } finally {
      btn.disabled = false;
    }
  }
  function selectTopic(slug) {
    if (currentView() !== 'radar') location.hash = '#radar';
    state.topic = slug;
    state.burst = {};
    render(true);
    refresh();
  }

  // ------------------------------------------------------------------ boot
  function render(groupsToo) {
    renderTabs();
    const t = currentTopic(), live = $('live');
    const key = t ? [t.topic, t.status, t.note, t.n_items, t.n_accounts, Data.mock].join('|') : '';
    if (live.dataset.key !== key) { live.dataset.key = key; renderLive(); } else tick();
    renderAnswer();
    if (groupsToo) renderGroups();
  }

  async function refresh() {
    const seq = ++state.seq;
    let topics;
    try { topics = await Data.topics(); }
    catch (e) {
      if (!state.loaded) {
        state.loaded = true;
        $('answer').innerHTML = '<p class="notice">The radar could not be reached and no demo data is bundled with this page.</p>';
      }
      return;
    }
    if (seq !== state.seq) return;
    state.loaded = true;
    // Keep a topic we just added even if the list has not caught up yet.
    const mine = currentTopic();
    state.topics = mine && !topics.some((t) => t.topic === mine.topic) ? topics.concat([mine]) : topics;
    if (!currentTopic()) {
      const first = state.topics.find((t) => t.n_coordinated > 0) || state.topics[0];
      state.topic = first ? first.topic : null;
    }
    if (!state.topic) { render(true); return; }

    const topic = state.topic;
    let alerts = null;
    try {
      alerts = await Data.alerts(topic);
      const ids = [...new Set(alerts.findings.flatMap((f) => f.item_ids))].filter((id) => !state.items[id]);
      try { Object.assign(state.items, await Data.items(ids)); } catch (e) { /* cards degrade to "texts not available" */ }
    } catch (e) { /* keep what is on screen */ }
    if (seq !== state.seq) return;

    const before = state.alertsTopic + JSON.stringify(state.alerts && state.alerts.findings);
    if (alerts) { state.alerts = alerts; state.alertsTopic = topic; }
    // Nothing new: keep the cards (open sections, hover state) as they are.
    render(before !== state.alertsTopic + JSON.stringify(state.alerts && state.alerts.findings));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('topic-form').addEventListener('submit', onWatch);
    $('tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (tab && tab.dataset.topic !== state.topic) selectTopic(tab.dataset.topic);
    });
    $('live').addEventListener('click', (e) => {
      const btn = e.target.closest('#inject-btn');
      if (btn) { onInject(btn); return; }
      const go = e.target.closest('[data-goto]');
      if (go) selectTopic(go.dataset.goto);
    });
    $('groups').addEventListener('click', (e) => {
      const b = e.target.closest('.time');
      if (!b) return;
      const i = +b.dataset.i, f = findings()[i];
      if (!f) return;
      state.burst[f.id] = +b.dataset.k;
      const items = itemsOf(f);
      $('ev-' + i).innerHTML = evidence(f, i, items, burstsOf(items));
      const again = $('ev-' + i).querySelector('.time[data-k="' + b.dataset.k + '"]');
      if (again) again.focus();
    });
    // <details> toggle does not bubble: listen in the capture phase and draw charts once they are visible.
    document.addEventListener('toggle', (e) => {
      if (e.target.open && e.target.matches && e.target.matches('details.how, details.group, details.curve')) drawOpenCharts();
    }, true);
    window.addEventListener('hashchange', route);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawOpenCharts);
    new MutationObserver(drawOpenCharts).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    Data.onMockChange = softTopics;

    await refresh();
    await route();
    setInterval(tick, 1000);
    if (!Data.mock) setInterval(refresh, POLL_MS);
  });
})();
