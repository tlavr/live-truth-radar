// Shop: ~5 s insert. A product page of a FICTIONAL store and product. Five-star reviews pour in, all rewordings of
// one message, minutes apart, from fresh accounts; the review count climbs from 128 into the thousands, the rating
// creeps from 3.9 to 4.9, a "#1 Bestseller" badge appears. Each new review lands with a red flash (the same red as
// BotHive's volleys). ?len=5 · ?product="Aura X1 Wireless Earbuds"
import {createStage, clamp, ss, pulse, rng, qn, qs} from './core.js';
import {botHandle} from './cast.js';

const LEN = qn('len', 5), PRODUCT = qs('product', 'Aura X1 Wireless Earbuds');
// one message, reworded (that is what a paraphrase swarm looks like in reviews)
const REVIEWS = [
  ['Best earbuds I have ever owned', 'Crystal clear sound and the battery lasts forever. Buy them, you will not regret it.'],
  ['Honestly the best purchase this year', 'Sound is crystal clear and the battery just keeps going. No regrets at all.'],
  ['Unbelievable sound for the price', 'Battery life is insane and the audio is so clear. Do not hesitate, just buy.'],
  ['10/10 would buy again', 'Clearest sound I have heard from earbuds, and they last all day. Zero regrets.'],
  ['Better than earbuds twice the price', 'Crystal-clear audio, battery that never dies. Get them before they sell out!'],
  ['Changed my daily commute', 'The sound is so clear and the battery lasts for days. Absolutely worth it.'],
  ['Do not overthink it, buy these', 'Amazing clarity and battery life that goes forever. Best money I spent.'],
  ['Perfect in every way', 'Sound quality is crystal clear, battery lasts and lasts. You will love them.'],
  ['Wow just wow', 'Super clear sound, the battery is endless. Everyone should own a pair.'],
  ['My new favorite gadget', 'Clear, rich sound and a battery that lasts forever. Buy now while in stock.'],
  ['Exceeded every expectation', 'Battery life is unreal and the sound is crystal clear. Highly recommend!'],
  ['Simply the best', 'Clearest earbuds on the market, battery lasts all week. Do not wait.'],
];

const UI = `
<div class="sh" id="sh">
  <div class="sh-top"><b>demo·store</b><span>Electronics › Audio › Earbuds · fictional store</span><i class="sh-cart">🛒</i></div>
  <div class="sh-main">
    <div class="sh-prod">
      <div class="sh-img"><svg viewBox="0 0 200 160"><defs><radialGradient id="g1" cx=".35" cy=".3"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#9aa3ad"/></radialGradient></defs>
        <ellipse cx="100" cy="128" rx="78" ry="14" fill="rgba(0,0,0,.12)"/>
        <g fill="url(#g1)"><circle cx="70" cy="70" r="30"/><rect x="62" y="80" width="16" height="48" rx="8"/><circle cx="132" cy="70" r="30"/><rect x="124" y="80" width="16" height="48" rx="8"/></g>
        <circle cx="70" cy="70" r="12" fill="#2b2f36"/><circle cx="132" cy="70" r="12" fill="#2b2f36"/></svg>
        <span class="sh-badge" id="shBadge">#1 Bestseller</span></div>
      <h2>${PRODUCT}</h2>
      <div class="sh-rate"><span class="sh-stars"><span class="sh-fill" id="shFill">★★★★★</span>★★★★★</span><b id="shRating">3.9</b><span id="shCount">(128 reviews)</span></div>
      <div class="sh-price">€79.00 <s>€129.00</s></div>
      <div class="sh-stock" id="shStock">In stock</div>
      <button class="sh-buy" type="button">Add to cart</button>
    </div>
    <div class="sh-rev"><div class="sh-rh"><b>Customer reviews</b><span id="shNew">0 new in the last hour</span></div><ul id="shList"></ul></div>
  </div>
</div>`;

export function run() {
  const DUR = LEN + .4;
  const ctx = createStage({id: 'shop', title: 'Shop', duration: DUR, ui: UI, bloom: {strength: .2, radius: .3, threshold: .7}, path: [{t: 0, p: [0, 0, 10], l: [0, 0, 0]}], frame, after});
  const {$} = ctx;
  const r = rng(13), list = [];
  for (let i = 0; i < 180; i++) {
    const x = Math.pow(i / 180, .55) * .96;        // slow at first, then a flood
    const [title, body] = REVIEWS[(i * 7 + Math.floor(r() * 3)) % REVIEWS.length];
    list.push({x, title, body, who: botHandle(i % 25) , mins: 1 + Math.floor(r() * 9)});
  }
  let last = '';
  function frame(t, c) { c.fade = 1 - ss(0, .25, t) + ss(DUR - .3, DUR, t); }
  function after(t) {
    const x = clamp(t / LEN, 0, 1), shown = list.filter(v => v.x <= x), n = shown.length;
    const count = Math.round(128 + 4684 * Math.pow(x, 1.6)), rating = 3.9 + 1.0 * ss(.1, .85, x);
    $('#shCount').textContent = `(${count.toLocaleString('en-US')} reviews)`;
    $('#shRating').textContent = rating.toFixed(1);
    $('#shFill').style.width = `${rating / 5 * 100}%`;
    $('#shNew').textContent = `${Math.round(count - 128).toLocaleString('en-US')} new in the last hour`;
    const badgeAt = .55 * LEN;
    $('#shBadge').style.opacity = ss(badgeAt, badgeAt + .15, t); $('#shBadge').style.transform = `scale(${1 + .5 * pulse(t, badgeAt, 6)}) rotate(-6deg)`;
    $('#shStock').textContent = x > .7 ? 'Only 3 left — order soon' : 'In stock'; $('#shStock').classList.toggle('hot', x > .7);
    const html = shown.slice(-9).reverse().map((v, i) => `<li class="${i === 0 ? 'new' : ''}"><div class="st">★★★★★ <b>${v.title}</b></div><p>${v.body}</p><small>${v.who} · Verified purchase · ${i === 0 ? 'just now' : `${v.mins} min ago`}</small></li>`).join('');
    if (html !== last) { $('#shList').innerHTML = html; last = html; }
    // the page leans in as the flood grows; a jolt on each new wave
    const z = 1 + .035 * ss(.2, 1, x), j = Math.sin(t * 83) * 2.5 * ss(.6, .9, x);
    $('#sh').style.transform = `translate(${j}px,0) scale(${z})`;
  }
  ctx.start();
}
