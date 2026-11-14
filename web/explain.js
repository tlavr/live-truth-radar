// T12b: "How we got here", a step-by-step walk through one alert (Finding) of the dashboard.
// Opened from the dashboard's "How we got here" link as /explain?id=<finding id>&topic=<topic>&alpha=<sensitivity alpha>.
// It speaks the dashboard's language (groups.js: order, letters, verdict words) and can switch between a topic's groups.
// Data: /api/alerts?topic=&alpha= (the finding, by id) and /api/items?ids= (its posts).

import {topicLabel} from './labels.js';
import {heldByNews} from './chain.js';
import {LETTER, optionText, ordered, verdictTitle} from './groups.js';
import {stepsHTML, wireSteps} from './steps.js';

const DESIGN_ALPHA = 0.02, MAX_IDS = 200;   // the findings table's alpha; ids per /api/items request

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status}`);
  return r.json();
}

const q = new URLSearchParams(location.search);
const ID = q.get('id'), TOPIC = q.get('topic');
const ALPHA = parseFloat(q.get('alpha')) || DESIGN_ALPHA;

/* the page opens with the answer, in the dashboard's words; the steps below show how the detector got there */
function head(f, list) {
  const n = f.accounts.length, held = heldByNews(f), k = list.indexOf(f);
  const title = verdictTitle(f);
  const text = held ? (f.note.startsWith('viral echo: ') ? `${n} accounts look coordinated, but the same message also spreads outside the group, so they are not flagged.`
      : `${n} accounts look coordinated, but they repeat a news article, so they are not flagged.`)
    : f.verdict === 'coordinated' ? `${n} accounts posted matching messages close together in time.`
    : f.verdict === 'watching' ? `${n} accounts look alike. Too little evidence to flag yet.`
    : `${n} accounts stood out from the background, but the post-by-post test cleared them.`;
  // a browser can hold an older copy of the page next to this script: add what it lacks instead of failing
  const h = $('title') ?? Object.assign(document.querySelector('h1'), {id: 'title'});
  if (!$('where')) h.insertAdjacentHTML('beforebegin', '<p class="where" id="where"></p>');
  $('where').innerHTML = `How we got here · ${esc(topicLabel(f.topic))}` + (list.length > 1
    ? ` · <label class="sr" for="group">Group</label><select id="group">${list.map((g, i) => `<option value="${esc(g.id)}"${g === f ? ' selected' : ''}>${esc(optionText(g, i))}</option>`).join('')}</select>`
    : '');
  h.dataset.v = held ? 'watching' : f.verdict; h.textContent = title;
  $('intro').textContent = `${text}${f.synthetic ? ' This is a simulated attack from Bot Hive, the attack simulator.' : ''} Below: every step the detector took, in order.`;
  $('back').href = `/?q=${encodeURIComponent(f.topic)}`;
  document.title = `Live Swarm Radar · ${title}${list.length > 1 ? ` · group ${LETTER(k)}` : ''}`;
  // another group of the same topic: same page, same sensitivity
  $('group')?.addEventListener('change', e => {
    const u = new URLSearchParams(location.search); u.set('id', e.target.value); location.search = u.toString();
  });
}

function render(f, items, points, list) {
  head(f, list);
  $('steps').innerHTML = stepsHTML(f, items, points, ALPHA);
  wireSteps($('steps'));
}

function fail(msg) {
  $('intro').textContent = msg;
  $('steps').innerHTML = `<p><a href="${TOPIC ? `/?q=${encodeURIComponent(TOPIC)}` : '/'}">← Back to the radar</a></p>`;
}

(async () => {
  if (!ID) return fail('No group selected. Open this page from a topic on the radar.');
  try {
    const qs = new URLSearchParams();
    if (TOPIC) qs.set('topic', TOPIC);
    if (ALPHA !== DESIGN_ALPHA) qs.set('alpha', String(ALPHA));
    const [alerts, points] = await Promise.all([
      api(`/api/alerts${qs.size ? '?' + qs : ''}`), api('/api/operating_points').catch(() => null)]);
    const list = ordered(alerts.findings.filter(x => !TOPIC || x.topic === TOPIC));   // the dashboard's order and letters
    const f = list.find(x => x.id === ID);
    if (!f) return fail('This group is no longer in the current window (simulated tests expire after about 10 minutes).');
    const items = [];
    for (let k = 0; k < f.item_ids.length; k += MAX_IDS) {
      const ids = f.item_ids.slice(k, k + MAX_IDS).map(encodeURIComponent).join(',');
      try { items.push(...await api(`/api/items?ids=${ids}`)); } catch (e) { console.warn('items', e); }
    }
    render(f, items, points, list);
  } catch (e) {
    console.warn(e);
    fail(`Could not load this group (${e.message}).`);
  }
})();
