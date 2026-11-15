// Social: ~5 s insert. A schematic phone (no real app's look or logo: grey placeholders, generic icons). The feed is
// swiped up three times and stops on one post; its likes explode (1.2K → tens of thousands, hearts streaming up), the
// comments sheet slides up and floods with near-identical bot comments, each landing with BotHive's red flash.
// Big counters beside the phone carry the numbers. ?len=5
import {createStage, clamp, ss, pulse, rng, qn} from './core.js';
import {botHandle, humanHandle} from './cast.js';

const LEN = qn('len', 5);
const PUSH = ['So true 🔥', 'Everyone needs to see this', '100% agree', 'Finally someone said it', 'Share this everywhere!',
  'This. Exactly this.', 'Can\'t believe nobody talks about this', 'Spread the word 🙌', 'Facts. Period.', 'Wake up people!!',
  'Absolutely right', 'Needs to go viral', 'Truth 💯', 'Saying it louder for the people in the back'];
const HUMAN = ['wait what is this about?', 'source?', 'why is my whole feed this post'];

const post = (i, cls = '') => `
  <div class="sp-post ${cls}">
    <div class="sp-ph"><i></i><b></b><s></s></div>
    <div class="sp-img sp-img${i}"><span class="sp-sun"></span><span class="sp-hill a"></span><span class="sp-hill b"></span></div>
    <div class="sp-act"><span class="sp-heart" ${cls ? 'id="spHeart"' : ''}>♥</span><span class="sp-bub">◯</span><span class="sp-send">➤</span></div>
    <div class="sp-likes">${cls ? '<b id="spLikes">1,204</b> likes' : '<b>3,118</b> likes'}</div>
    <div class="sp-cap"><b></b><s></s></div>
  </div>`;

const UI = `
<div class="sp">
  <div class="sp-phone">
    <div class="sp-notch"></div>
    <div class="sp-bar"><b></b><span>⌂ ⌕ ＋ ♡ ◉</span></div>
    <div class="sp-screen"><div class="sp-track" id="spTrack">${post(1)}${post(2)}${post(3)}${post(4, 'target')}</div>
      <div class="sp-hearts" id="spHearts"></div>
      <div class="sp-sheet" id="spSheet"><div class="sp-grab"></div><div class="sp-sh"><b>Comments</b><span id="spCN">0</span></div><ul id="spList"></ul></div>
    </div>
  </div>
  <div class="sp-count l"><div><b id="spBigL">1.2K</b><span>likes</span></div><small id="spRateL">+0 / min</small></div>
  <div class="sp-count r"><div><b id="spBigC">0</b><span>comments</span></div><small id="spRateC">+0 / min</small></div>
  <div class="sp-note">schematic · not a real app</div>
</div>`;

export function run() {
  const DUR = LEN + .4;
  const ctx = createStage({id: 'social', title: 'Social', duration: DUR, ui: UI, bloom: {strength: .2, radius: .3, threshold: .7}, path: [{t: 0, p: [0, 0, 10], l: [0, 0, 0]}], frame, after});
  const {$} = ctx;
  const S = t => t / LEN * 5;                        // the story is timed for 5 s; ?len stretches it
  const SW = [.25, .6, .95], STOP = 1.2, SHEET = 2.0;
  const r = rng(21);
  const hearts = Array.from({length: 140}, (_, i) => ({t0: STOP + Math.pow(i / 140, .7) * 3.6, x: r() * 64 - 8, dur: .9 + r() * .5, s: .7 + r() * .8}));
  const comments = Array.from({length: 150}, (_, i) => {
    const human = r() < .06;
    return {x: SHEET + .15 + Math.pow(i / 150, .55) * 2.75, who: human ? humanHandle(i) : botHandle(i % 25), text: human ? HUMAN[i % HUMAN.length] : PUSH[Math.floor(r() * PUSH.length)], bot: !human};
  });
  const likesAt = s => s < STOP ? 1204 : Math.round(1204 + 47800 * Math.pow(clamp((s - STOP) / 3.6), 1.7));
  const cAt = s => s < SHEET ? 0 : Math.round(12400 * Math.pow(clamp((s - SHEET) / 2.9), 1.5));
  const k = n => n >= 1e4 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString('en-US');
  let lastC = '', lastH = '';

  function frame(t, c) { c.fade = 1 - ss(0, .2, t) + ss(DUR - .3, DUR, t); }
  function after(t) {
    const s = S(t);
    // swipes: each moves the track up by one post (530 px), with a snap
    const off = SW.reduce((a, at) => a + ss(at, at + .22, s), 0);
    $('#spTrack').style.transform = `translateY(${-off * 530}px)`;
    // likes
    const L = likesAt(s);
    $('#spLikes').textContent = L.toLocaleString('en-US');
    const heart = $('#spHeart'); heart.classList.toggle('on', s >= STOP);
    heart.style.transform = `scale(${1 + .5 * pulse(s, STOP, 5) + .15 * Math.abs(Math.sin(s * 18)) * ss(STOP, STOP + .5, s)})`;
    const hh = hearts.filter(h => s >= h.t0 && s < h.t0 + h.dur).slice(-46).map(h => {
      const p = (s - h.t0) / h.dur;
      return `<i style="transform:translate(${h.x + Math.sin(p * 6 + h.x) * 14}px,${-p * 330}px) scale(${h.s})">♥</i>`;
    }).join('');
    if (hh !== lastH) { $('#spHearts').innerHTML = hh; lastH = hh; }
    // comments sheet
    const sh = ss(SHEET, SHEET + .35, s);
    $('#spSheet').style.transform = `translateY(${(1 - sh) * 105}%)`;
    const C = cAt(s), shown = comments.filter(cm => cm.x <= s);
    $('#spCN').textContent = k(C);
    const html = shown.slice(-11).reverse().map((cm, i) => `<li class="${i === 0 ? 'new' : ''}"><i></i><div><b>${cm.who}</b> ${cm.text}<small>${i === 0 ? 'now' : `${1 + (i % 4)}m`} · ♡ ${(i * 37 + 12) % 400}</small></div></li>`).join('');
    if (html !== lastC) { $('#spList').innerHTML = html; lastC = html; }
    // the big numbers
    $('#spBigL').textContent = k(L); $('#spBigC').textContent = k(C);
    $('#spRateL').textContent = `+${Math.round(s < STOP ? 0 : 900 + 38000 * clamp((s - STOP) / 3.6)).toLocaleString('en-US')} / min`;
    $('#spRateC').textContent = `+${Math.round(s < SHEET ? 0 : 300 + 11000 * clamp((s - SHEET) / 2.9)).toLocaleString('en-US')} / min`;
    $('.sp-count.l').style.opacity = ss(STOP - .1, STOP + .25, s); $('.sp-count.r').style.opacity = ss(SHEET, SHEET + .3, s);
    $('#spBigL').style.transform = `scale(${1 + .25 * pulse(s, STOP, 6)})`; $('#spBigC').style.transform = `scale(${1 + .25 * pulse(s, SHEET + .2, 6)})`;
    $('.sp-phone').style.transform = `translateX(${Math.sin(t * 79) * 2.2 * ss(3.4, 4.4, s)}px) scale(${1 + .04 * ss(STOP, 5, s)})`;
  }
  ctx.start();
}
