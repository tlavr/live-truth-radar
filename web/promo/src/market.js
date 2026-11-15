// Market: ~2.6 s insert. A trading terminal for a FICTIONAL ticker (HXGN, "simulated market"): the price is pumped,
// crashes and whipsaws; every number flickers; on the right the comments flood in, bots pushing the move
// (rockets on the way up, "SELL" on the way down). Deterministic like every scene: scrub and re-record.
// ?len=2.6 (seconds; the same story, stretched) · ?ticker=HXGN
import {createStage, PAL, clamp, ss, pulse, rng, qn, qs} from './core.js';
import {botHandle, humanHandle} from './cast.js';

const LEN = qn('len', 2.6), TICK = qs('ticker', 'HXGN');
const PUMP = ['🚀🚀🚀 ' + TICK + ' to 500', 'loading up more, this is THE one', 'shorts getting wrecked lol', 'just bought the dip again 💎🙌',
  'insiders know something, buy now', 'never selling', 'this is going parabolic', 'last chance under 450', 'told my whole family to buy',
  'easy 10x from here', 'the rumor is real, get in', 'ATH incoming 📈', 'calls printing', 'buy buy buy'];
const DUMP = ['it\'s over. SELL', 'insiders dumping, get out NOW', 'CEO news is real, this crashes', 'I sold everything', 'bagholders lol 📉',
  'dead cat bounce, don\'t fall for it', 'panic sell before open', 'rug pull confirmed', 'this goes to zero', 'sell sell sell',
  'whoever bought at the top 💀', 'shorting with everything'];
const HUMAN = ['what is even happening', 'is there actual news??', 'source?', 'I\'ll wait for the filing', 'this chat is wild'];

const UI = `
<div class="mk">
  <div class="mk-top">
    <div class="mk-name"><b>${TICK}</b><span>Hexagon Compute · simulated market · fictional ticker</span></div>
    <div class="mk-px"><b id="mkPx">412.37</b><span id="mkCh">+0.00%</span></div>
    <div class="mk-mini"><span>VOL <b id="mkVol">0</b></span><span>BID <b id="mkBid">0</b></span><span>ASK <b id="mkAsk">0</b></span></div>
  </div>
  <canvas id="mkChart" width="1880" height="1060"></canvas>
  <div class="mk-feed"><div class="mk-fh"><b>Comments</b><span id="mkRate">0 / min</span></div><ul id="mkList"></ul></div>
  <div class="mk-tape" id="mkTape"></div>
</div>`;

export function run() {
  const DUR = LEN + .5;
  const ctx = createStage({id: 'market', title: 'Market', duration: DUR, ui: UI, bloom: {strength: .3, radius: .4, threshold: .5}, path: [{t: 0, p: [0, 0, 10], l: [0, 0, 0]}], frame, after});
  const {$} = ctx;
  const k = t => t / LEN;                         // story progress 0..1
  // the price: pump to +9 %, crash to −13 %, whipsaw; noise grows with the panic
  const r = rng(41), STEPS = 600, noise = Array.from({length: STEPS + 1}, () => r() - .5);
  const P0 = 412.37;
  const priceAt = x => {
    x = clamp(x, 0, 1);
    const trend = x < .42 ? ss(0, .42, x) * .09 : x < .62 ? .09 - ss(.42, .62, x) * .22 : -.13 + Math.sin((x - .62) * 30) * .035 + ss(.62, 1, x) * .05;
    const n = noise[Math.floor(x * STEPS)] * (.006 + .02 * ss(.35, .7, x));
    return P0 * (1 + trend + n);
  };
  // candles: 64 on screen, one per 1/64 of the story
  const NC = 64;
  const candle = i => { const a = i / NC, b = (i + 1) / NC; let o = priceAt(a), c = priceAt(b), h = Math.max(o, c), l = Math.min(o, c);
    for (let s = 0; s < 6; s++) { const p = priceAt(a + (b - a) * s / 5); h = Math.max(h, p); l = Math.min(l, p); } return {o, c, h, l}; };
  const candles = Array.from({length: NC}, (_, i) => candle(i));
  const lo = Math.min(...candles.map(c => c.l)) * .995, hi = Math.max(...candles.map(c => c.h)) * 1.005;
  // the comments: their rate climbs fast (n ∝ x²), bots push the direction of the move, a few people are lost
  const cr = rng(5), comments = [];
  for (let i = 0; i < 260; i++) {
    const x = Math.sqrt(i / 260) * .97;            // time of comment i, as a fraction of the story
    const pumping = x < .45, human = cr() < .07;
    const text = human ? HUMAN[i % HUMAN.length] : (pumping ? PUMP : DUMP)[Math.floor(cr() * (pumping ? PUMP : DUMP).length)];
    comments.push({x, who: human ? humanHandle(i) : botHandle(i % 25), text, bot: !human, up: pumping});
  }
  const cv = $('#mkChart'), g = cv.getContext('2d');
  const fmt = n => n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  let lastList = '';

  function frame(t, c) {
    c.fade = 1 - ss(0, .15, t) + ss(DUR - .25, DUR, t);
    const x = k(t), panic = ss(.4, .65, x);
    c.rgb = panic * .003 * (Math.floor(t * 14) % 3 === 0 ? 1.6 : 1);
  }
  function after(t) {
    const x = clamp(k(t), 0, 1), jit = n => n * (1 + (Math.sin(t * 97.3) * .5) * .0009);
    const px = jit(priceAt(x)), ch = (px / P0 - 1) * 100, up = ch >= 0;
    $('#mkPx').textContent = fmt(px); $('#mkPx').style.color = up ? '#3FE08B' : '#FF4D6D';
    $('#mkCh').textContent = `${up ? '+' : ''}${ch.toFixed(2)}%`; $('#mkCh').style.color = up ? '#3FE08B' : '#FF4D6D';
    $('#mkVol').textContent = Math.floor(12000 + 4.8e6 * x * x + Math.abs(Math.sin(t * 41)) * 9000).toLocaleString('en-US');
    $('#mkBid').textContent = fmt(px - .03 - Math.abs(Math.sin(t * 53)) * .2); $('#mkAsk').textContent = fmt(px + .03 + Math.abs(Math.sin(t * 61)) * .2);
    // chart
    const W = cv.width, H = cv.height, n = Math.min(NC, Math.floor(x * NC) + 1), cw = W / NC, Y = p => H - 40 - (p - lo) / (hi - lo) * (H - 80);
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(218,240,224,.07)'; g.lineWidth = 1;
    for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(0, H * i / 6); g.lineTo(W, H * i / 6); g.stroke(); }
    for (let i = 0; i < n; i++) {
      const cd = i === n - 1 ? {...candles[i], c: px, h: Math.max(candles[i].h, px), l: Math.min(candles[i].l, px)} : candles[i];
      const green = cd.c >= cd.o, col = green ? '#3FE08B' : '#FF4D6D', cx = i * cw + cw / 2;
      g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); g.moveTo(cx, Y(cd.h)); g.lineTo(cx, Y(cd.l)); g.stroke();
      g.fillStyle = col; g.fillRect(cx - cw * .32, Math.min(Y(cd.o), Y(cd.c)), cw * .64, Math.max(3, Math.abs(Y(cd.o) - Y(cd.c))));
      const vol = (.15 + Math.abs(cd.c - cd.o) / (hi - lo) * 6) * 140;   // volume bars
      g.globalAlpha = .28; g.fillRect(cx - cw * .32, H - vol, cw * .64, vol); g.globalAlpha = 1;
    }
    g.setLineDash([10, 10]); g.strokeStyle = up ? '#3FE08B' : '#FF4D6D'; g.beginPath(); g.moveTo(0, Y(px)); g.lineTo(W, Y(px)); g.stroke(); g.setLineDash([]);
    g.fillStyle = up ? '#3FE08B' : '#FF4D6D'; g.font = '600 30px ui-monospace,Menlo,monospace'; g.fillText(fmt(px), W - 170, Y(px) - 12);
    // comments
    const shown = comments.filter(cm => cm.x <= x);
    const rate = Math.round(40 + 9000 * x * x);
    $('#mkRate').textContent = `${shown.length.toLocaleString('en-US')} · ${rate.toLocaleString('en-US')} / min`;
    const html = shown.slice(-19).reverse().map((cm, i) => `<li class="${i === 0 ? 'new' : ''} ${cm.bot ? '' : 'hum'}"><b>${cm.who}</b> <span class="${cm.up ? 'u' : 'd'}">${cm.text}</span></li>`).join('');
    if (html !== lastList) { $('#mkList').innerHTML = html; lastList = html; }
    // tape
    $('#mkTape').textContent = Array.from({length: 9}, (_, i) => { const q = priceAt(clamp(x - i * .03, 0, 1)); return `${TICK} ${fmt(q)}  ${q >= P0 ? '▲' : '▼'}`; }).join('     ·     ');
    $('#mkTape').style.transform = `translateX(${-((t * 260) % 400)}px)`;
    $('.mk').style.transform = `translate(${(Math.sin(t * 71) * 3) * ss(.42, .55, x) * (1 - ss(.65, .8, x))}px,0)`;
  }
  ctx.start();
}
