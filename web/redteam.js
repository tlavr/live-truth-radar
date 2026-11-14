// T12d Bot Hive (/redteam): launches a synthetic swarm (POST /api/attack; one per 5 min per topic) whose posts
// appear one by one at their published_at (server clock), and shows which of them the radar has caught
// (GET /api/attack/{id}).

import {topicLabel} from './labels.js';

const POLL_MS = 2000, GAP_MS = 5 * 60_000, CAMPAIGN_KEY = 'ltr.redteam.campaign';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const hms = iso => new Date(iso).toISOString().slice(11, 19);
const mss = secs => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// cooldown: browser-clock time until which each topic refuses a new attack (learned from our own launches and 429s)
const S = {campaign: store.get(CAMPAIGN_KEY), timer: null, firstHit: null, maxCaught: 0, ready: false, busy: false, shownTopic: false, cooldown: {}};

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.detail ?? `${r.status}`);
    err.status = r.status;
    err.retry = +(r.headers.get('Retry-After') ?? /retry in (\d+) s/.exec(err.message)?.[1] ?? 0);
    throw err;
  }
  return body;
}

const setHTML = (id, html) => { const el = $(id); if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };
const say = t => { $('msg').textContent = t; };
const val = name => document.querySelector(`.seg[data-name="${name}"] [aria-checked="true"]`).dataset.v;

// where each scenario should land on the radar's field (time between posts x wording gap)
const SCENARIOS = {
  paraphrase: {speed: 4, hint: 'Every bot rewords the same message. Expect a peak near zero lag and a small wording gap.'},
  copypasta: {speed: 4, hint: 'Every bot posts the very same text in each volley. Expect a sharp peak in the corner.'},
  drift: {speed: 1, hint: 'The message drifts from the first post over time. Expect a ridge along the diagonal; late posts may slip out of the swarm.'},
};
const MINUTES_AT_4X = {2: 2.5, 4: 6.5, 6: 10.5};  // campaign length per posts per bot (api/main.py attack)

function showSetup() {
  const sc = SCENARIOS[val('scenario')], bots = +val('size'), ppb = +val('ppb');
  const mins = MINUTES_AT_4X[ppb] * 4 / sc.speed;
  $('scenarioHint').textContent = sc.hint;
  $('summary').innerHTML = `<b>${bots * ppb}</b> posts · ~${mins} min${sc.speed > 1 ? ' · 4× speed' : ''}`;
}

// the Attack button: disabled while loading, sending, or while the selected topic is cooling down
function showButton() {
  const left = Math.ceil(((S.cooldown[$('topic').value] ?? 0) - Date.now()) / 1000);
  const btn = $('attack');
  btn.disabled = !S.ready || S.busy || left > 0;
  btn.textContent = left > 0 ? `Again in ${mss(left)}` : 'Attack';
}
const showRadarLink = () => { $('radar').href = $('topic').value ? `/?q=${encodeURIComponent($('topic').value)}` : '/'; };
setInterval(showButton, 1000);

function wireSegments() {
  for (const seg of document.querySelectorAll('.seg')) {
    const opts = [...seg.querySelectorAll('button')];
    const pick = b => {
      for (const o of opts) {
        o.setAttribute('aria-checked', String(o === b));
        o.tabIndex = o === b ? 0 : -1;
      }
      showSetup();
    };
    for (const o of opts) {
      const on = o.getAttribute('aria-checked') === 'true';
      o.setAttribute('aria-checked', String(on));
      o.tabIndex = on ? 0 : -1;
    }
    seg.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) pick(b); });
    seg.addEventListener('keydown', e => {
      const i = opts.indexOf(document.activeElement), n = opts.length;
      const to = {ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1}[e.key];
      if (to == null) return;
      e.preventDefault();
      const b = opts[(to + n) % n];
      pick(b);
      b.focus();
    });
  }
}

const setControls = on => { for (const b of document.querySelectorAll('.seg button, #topic')) b.disabled = !on; };

async function init() {
  setControls(false);
  try {
    const topics = await api('/api/attack/topics');
    $('topic').innerHTML = topics.map(t => `<option value="${esc(t)}">${esc(topicLabel(t))}</option>`).join('');
    S.ready = topics.length > 0;
    setControls(S.ready);
    showRadarLink();
    if (!S.ready) say('No topic has bot messages prepared yet.');
    if (S.campaign) follow(S.campaign);
  } catch (e) {
    say(`Could not load topics: ${e.message}`);
  }
  showButton();
}

async function attack() {
  const topic = $('topic').value;
  S.busy = true;
  showButton();
  say('');
  try {
    const r = await api('/api/attack', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({topic, n_accounts: +val('size'), posts_per_bot: +val('ppb'), scenario: val('scenario')})});
    S.cooldown[topic] = Date.now() + GAP_MS;
    $('log').innerHTML = '';
    S.firstHit = null;
    S.maxCaught = 0;
    store.set(CAMPAIGN_KEY, r.campaign_id);
    follow(r.campaign_id);
  } catch (e) {
    if (e.status === 429 && e.retry > 0) S.cooldown[topic] = Date.now() + e.retry * 1000;
    else say(`Attack failed: ${e.message}`);
  } finally {
    S.busy = false;
    showButton();
  }
}

function follow(cid) {
  S.campaign = cid;
  S.shownTopic = false;
  clearInterval(S.timer);
  tick();
  S.timer = setInterval(tick, POLL_MS);
}

async function tick() {
  const cid = S.campaign;
  let st;
  try {
    st = await api(`/api/attack/${encodeURIComponent(cid)}`);
  } catch (e) {
    if (e.status === 404 && S.campaign === cid) { store.set(CAMPAIGN_KEY, null); clearInterval(S.timer); }
    return;
  }
  if (S.campaign !== cid) return;  // a new Attack started while this request was in flight
  const now = Date.parse(st.now);
  // a campaign restored after a reload: its topic is still cooling down (server clock mapped to the browser's)
  S.cooldown[st.topic] ??= Date.parse(st.starts_at) + GAP_MS + (Date.now() - now);
  if (!S.shownTopic) {  // first status of this campaign: the select follows it (e.g. after a reload)
    S.shownTopic = true;
    if ([...$('topic').options].some(o => o.value === st.topic)) { $('topic').value = st.topic; showRadarLink(); showButton(); }
  }

  const log = $('log');
  for (const p of st.posts) {
    let li = log.querySelector(`[data-id="${CSS.escape(p.item.id)}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = p.item.id;
      li.className = 'new';
      li.innerHTML = `<div class="meta"><span class="who">${esc(p.item.author)}</span><time>${hms(p.item.published_at)}</time></div>`
        + `<div class="txt">${esc(p.item.text)}</div><span class="det"></span>`;
      log.prepend(li);
    }
    const det = li.querySelector('.det');
    det.textContent = p.detected ? 'Detected' : 'Unseen';
    det.classList.toggle('on', p.detected);
  }

  const bots = new Set(st.posts.map(p => p.item.author));
  S.maxCaught = Math.max(S.maxCaught, st.n_detected_accounts);  // the alert expires after the campaign + TTL
  $('live').hidden = false;
  setHTML('sCaught', `${S.maxCaught}<small> / ${st.n_accounts}</small>`);
  $('sBar').style.width = `${(100 * S.maxCaught / Math.max(1, st.n_accounts)).toFixed(1)}%`;
  $('sPosted').textContent = `${st.posts.length}`;
  $('sBots').textContent = `${bots.size} / ${st.n_accounts}`;
  if (st.n_detected_accounts > 0 && S.firstHit == null) S.firstHit = now;
  const secs = S.firstHit == null ? null : Math.max(0, Math.round((S.firstHit - Date.parse(st.starts_at)) / 1000));
  $('sTime').textContent = secs == null ? '—' : mss(secs);

  const done = now > Date.parse(st.ends_at) + 60_000 && st.posts.length > 0;
  $('status').classList.toggle('done', done);
  const radar = `<a href="/?q=${encodeURIComponent(st.topic)}" target="_blank" rel="noopener">Watch it on the radar →</a>`;
  setHTML('statusText', done
    ? `${esc(topicLabel(st.topic))}: finished, the radar caught ${S.maxCaught} of ${st.n_accounts} bots. ${radar}`
    : `${esc(topicLabel(st.topic))}: attack running until ${hms(st.ends_at)} UTC. ${radar}`);
}

wireSegments();
$('attack').addEventListener('click', attack);
$('topic').addEventListener('change', () => { showButton(); showRadarLink(); });
showSetup();
init();
