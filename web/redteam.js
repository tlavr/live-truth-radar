// T12d Red Team Console: launches a synthetic swarm (POST /api/attack; one per 5 min per topic) whose posts
// appear one by one at their published_at (server clock), and shows which of them the radar has caught
// (GET /api/attack/{id}).

import {topicLabel} from './labels.js';

const POLL_MS = 2000, CAMPAIGN_KEY = 'ltr.redteam.campaign';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const hms = iso => new Date(iso).toISOString().slice(11, 19);
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const S = {campaign: store.get(CAMPAIGN_KEY), timer: null, firstHit: null, maxCaught: 0};

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.detail ?? `${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

const say = t => { $('msg').textContent = t; };

// what each scenario does and where it should land on the radar's 3D field (time between posts x wording gap)
const SCENARIOS = {
  paraphrase: 'Paraphrase: every bot rewords the same message. Demo speed: 4× faster than the real schedule the metrics are measured on (~2.5 min for 2 posts per bot, ~6.5 min for 4). Expect a peak near zero lag, small wording gap.',
  copypasta: 'Copypasta: in each volley every bot posts the very same text. Demo speed 4×. Expect a sharp peak in the corner: zero lag, “same meaning”.',
  drift: 'Drift: the text drifts further from the first post over time. Real speed (~10 min for 2 posts per bot, longer for more). Expect a ridge along the diagonal: the longer between two posts, the bigger the wording gap; late posts may slip out of the swarm.',
};
const showScenario = () => {
  $('scenarioHint').textContent = SCENARIOS[$('scenario').value];
  $('total').textContent = `= ${+$('size').value * +$('ppb').value} posts`;
};

async function init() {
  try {
    const topics = await api('/api/attack/topics');
    $('topic').innerHTML = topics.map(t => `<option value="${esc(t)}">${esc(topicLabel(t))}</option>`).join('');
    const ready = topics.length > 0;
    for (const id of ['topic', 'size', 'ppb', 'scenario', 'attack']) $(id).disabled = !ready;
    say(ready ? 'Ready.' : 'No monitored topic has prepared bot messages yet.');
    if (S.campaign) follow(S.campaign);
  } catch (e) {
    say(`Error: ${e.message}`);
  }
}

async function attack() {
  $('attack').disabled = true;
  try {
    const r = await api('/api/attack', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({topic: $('topic').value, n_accounts: +$('size').value, posts_per_bot: +$('ppb').value, scenario: $('scenario').value})});
    say(`Campaign ${r.campaign_id} launched: ${r.n_items} posts until ${hms(r.ends_at)} UTC.`);
    $('log').innerHTML = '';
    S.firstHit = null;
    S.maxCaught = 0;
    store.set(CAMPAIGN_KEY, r.campaign_id);
    follow(r.campaign_id);
  } catch (e) {
    const wait = /retry in (\d+) s/.exec(e.message);
    say(wait ? `One attack per topic every 5 minutes — try again in ${Math.ceil(+wait[1] / 60)} min.` : `Error: ${e.message}`);
  } finally {
    $('attack').disabled = false;
  }
}

function follow(cid) {
  S.campaign = cid;
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
  const log = $('log');
  for (const p of st.posts) {
    let li = log.querySelector(`[data-id="${CSS.escape(p.item.id)}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = p.item.id;
      li.innerHTML = `<time>${hms(p.item.published_at)}</time><div><span class="who">${esc(p.item.author)}</span> <span class="txt">${esc(p.item.text)}</span></div><span class="det"></span>`;
      log.prepend(li);
    }
    const det = li.querySelector('.det');
    det.textContent = p.detected ? '✓ detected' : '· unseen';
    det.classList.toggle('on', p.detected);
  }
  const bots = new Set(st.posts.map(p => p.item.author));
  $('sPosted').textContent = `${st.posts.length}`;
  $('sBots').textContent = `${bots.size} / ${st.n_accounts}`;
  S.maxCaught = Math.max(S.maxCaught, st.n_detected_accounts);  // the alert expires after the campaign + TTL
  $('sCaught').textContent = `${S.maxCaught} / ${st.n_accounts}`;
  if (st.n_detected_accounts > 0 && S.firstHit == null) S.firstHit = Date.parse(st.now);
  const secs = S.firstHit == null ? null : Math.max(0, Math.round((S.firstHit - Date.parse(st.starts_at)) / 1000));
  $('sTime').textContent = secs == null ? '—' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  if (Date.parse(st.now) > Date.parse(st.ends_at) + 60_000 && st.posts.length) {
    say(`Campaign finished: the radar caught ${S.maxCaught} of ${st.n_accounts} bots.`);
  }
}

$('attack').addEventListener('click', attack);
for (const id of ['scenario', 'size', 'ppb']) $(id).addEventListener('change', showScenario);
showScenario();
init();
