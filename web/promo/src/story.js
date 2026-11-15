// Feed and Decay: one story timeline (seconds below are story time), cut into two scene pages that share frames at
// the cut, so the feed's last frame and the decay's first frame match.
//   feed.html  (story 0 – 10.6):  one headline types itself (an abstract CEO scandal, no names); then news from many
//              outlets lands faster and faster, the bots' posts among it arriving as red tracers (BotHive's volleys);
//              the wall grows huge; entropy (flicker, jitter, RGB shift, shake), "real? / bot?", "Which voice is real?"
//   decay.html (story 9.5 – 19.8): hard cut, the wall becomes pixels, the pixels fly onto the radar's field, a red dot,
//              a sonar ring calms the noise, a red peak shows behind the front; the camera settles, and the dashboard's
//              landing (its wordmark and search, ui/radar.css) fades in: the red dot flies into the dot of the "ı".
import {createStage, THREE, PAL, clamp, ss, rng, qs, glowTexture, GLSL_HASH, makeField, FIELD_GLSL} from './core.js';
import {FIRST, BOT_TEXTS, ORGANIC_TEXTS, botHandle, humanHandle} from './cast.js';

// feed: one headline, then the news (and the bots among it) lands faster and faster into a wall, then the question
const CUT = 10.0;
const T = {
  type0: .3, type1: 1.5, post: [1.9, 2.25, 2.55],
  swarm0: 2.8, swarmRate: .92, chaos0: 5.2, chaos1: 8.2, words0: 5.6, words1: 8.3, big0: 8.4,
  cut: CUT, morph0: CUT + .35, morphDur: 1.5, morphSpread: .8, grid0: CUT + 1.6, grid1: CUT + 2.6, dot: CUT + 2.9, ring: CUT + 3.4, ringSpeed: 13.0,
  ui0: CUT + 6.0, dotFly0: CUT + 6.3, dotFly1: CUT + 7.0, cap0: CUT + 7.4, cap1: CUT + 9.3,
};
const RANGE = {feed: [0, CUT + .6], decay: [CUT - .5, CUT + 9.8]};
const HEADLINE = qs('headline', "Tech giant's CEO caught in sudden scandal");
const CAPTION = qs('caption', 'Bots whisper below the noise floor.');
const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",system-ui,sans-serif';

const LANDING = `
<div class="p-landing" data-stage="home">
  <div class="veil"></div>
  <header class="topbar">
    <form class="search-shell" onsubmit="return false">
      <h1 class="hero-wordmark" aria-label="Live Swarm Radar">L<span class="idot">ı<i id="iDot" style="opacity:0"></i></span>ve Swarm Radar</h1>
      <div class="bar">
        <div class="field">
          <svg class="search-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8.75" cy="8.75" r="5.75"/><path d="M13 13l4.2 4.2" stroke-linecap="round"/></svg>
          <input type="text" placeholder="Pick a topic" tabindex="-1">
        </div>
        <div class="ctrl">
          <button class="play-btn" type="button" data-state="play" tabindex="-1"><svg class="i-play" viewBox="0 0 20 20"><path d="M7 4.6v10.8a.8.8 0 0 0 1.2.7l8.6-5.4a.8.8 0 0 0 0-1.4L8.2 3.9a.8.8 0 0 0-1.2.7z" fill="currentColor"/></svg></button>
          <span class="sep"></span>
          <button class="sens-btn" type="button" tabindex="-1"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none"/><path d="M6.6 6.6a4.8 4.8 0 0 0 0 6.8M13.4 6.6a4.8 4.8 0 0 1 0 6.8"/><path d="M4.1 4.1a8.3 8.3 0 0 0 0 11.8M15.9 4.1a8.3 8.3 0 0 1 0 11.8" opacity=".55"/></svg></button>
        </div>
      </div>
    </form>
  </header>
  <div id="flyDot" style="position:absolute;left:0;top:0;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;border-radius:50%;background:#FF4040;box-shadow:0 0 16px rgba(255,64,64,.95);opacity:0"></div>
  <div class="caption" id="cap" style="top:540px;font-size:26px;font-weight:500;color:rgba(242,246,243,.88)">${CAPTION}</div>
</div>`;
const WORDS_UI = `<div id="words" style="position:absolute;inset:0;pointer-events:none"></div>`;

export function run(mode) {
  const [S0, S1] = RANGE[mode];
  const ctx = createStage({
    id: mode, title: mode === 'feed' ? 'Feed' : 'Decay → landing', duration: S1 - S0, fov: 35,
    ui: WORDS_UI + (mode === 'decay' ? LANDING : ''),
    path: [
      {t: 0, p: [0, 1.6, 7.0], l: [0, 1.6, 0]},
      {t: 1.6, p: [0, 1.3, 7.4], l: [0, 1.2, 0]},
      {t: 2.6, p: [0, .3, 9.8], l: [0, .2, 0], e: 'io'},
      {t: 3.4, p: [-.6, .4, 14], l: [-.4, .3, 0], e: 'io'},
      {t: 6.0, p: [-1.4, .2, 36], l: [-.6, 0, 0], e: 'io'},
      {t: 8.6, p: [.5, 0, 100], l: [0, 0, 0], e: 'in'},
      {t: CUT, p: [0, 0, 150], l: [0, 0, 0], e: 'out'},
      {t: CUT + .45, p: [0, 0, 150], l: [0, 0, 0]},
      {t: CUT + 2.6, p: [0, 44, 58], l: [0, 0, 0]},
      {t: CUT + 4.2, p: [2, 29, 41], l: [1, -.5, 0]},                 // over the hills as the ring raises them
      {t: CUT + 6.2, p: [0, 19, 36], l: [0, 1.5, 0], e: 'io3'},       // the landing's view: low, the wave under the search
      {t: CUT + 9.8, p: [1.2, 18.4, 35], l: [.3, 1.6, 0]},
    ].map(k => ({...k, t: k.t - S0})),
    frame: (t, c) => frame(t + S0, c), after: t => after(t + S0),
  });
  const {scene} = ctx;

  /* ---------------- the cards (posts) ---------------- */
  const CW = 512, CH = 176, COLS = 8, ROWS = 8, CARD_W = 3.2, CARD_H = CARD_W * CH / CW;
  const AV = ['#3E7C5A', '#4B6B8A', '#7A5A8C', '#8C6A3E', '#3E6E7A', '#6E7A3E', '#8A4B5A', '#5A5A8C'];
  // 64 atlas cells: news tiles from fictional outlets (the scandal and everything else), with bot posts among them
  const OUTLETS = [['Newswire', '#FF4D6D'], ['Pulse24', '#4B8BFF'], ['Ledger Weekly', '#B7F063'], ['Metro Now', '#FFB547'], ['Signal Post', '#C77DFF'], ['Wirefeed', '#5BE49B']];
  const NEWS = [
    ['BREAKING', 'Board calls emergency meeting over CEO scandal'], ['UPDATE', 'Leaked memo deepens the CEO crisis'], ['MARKETS', 'Shares swing as CEO rumors spread'],
    ['RUMOR', 'Insiders: resignation "imminent"'], ['UPDATE', 'Company denies report, stock still slides'], ['ANALYSIS', 'Who is behind the leak?'],
    ['MARKETS', 'Crypto slides 8% overnight'], ['WEATHER', 'Storm warning for the weekend'], ['CITY', 'Transit fares to rise in spring'],
    ['SPORT', 'Underdogs win the derby in extra time'], ['TECH', 'New phone sets a preorder record'], ['VIRAL', 'Video of a dancing robot hits 40M views'],
    ['WORLD', 'Airline strike grounds hundreds of flights'], ['HOUSING', 'Home prices dip for a third month'], ['TECH', 'Outage hits millions of users'],
    ['HEALTH', 'Study links coffee to a longer life'], ['CULTURE', 'Concert sells out in four minutes'], ['MARKETS', 'Fuel prices jump again'],
    ['BREAKING', 'Regulators "looking into" the CEO affair'], ['OPINION', 'The CEO must go, now'], ['OPINION', 'Leave the CEO alone'],
    ['TECH', 'AI chatbot goes viral overnight'], ['CITY', 'Bridge closed for urgent repairs'], ['STARTUPS', 'Startup raises $200M in a day'],
    ['RUMOR', 'Second executive "set to leave"'], ['MARKETS', 'Futures fall before the open'], ['WORLD', 'Heatwave breaks a 70-year record'],
    ['SCIENCE', 'Telescope spots an Earth-sized planet'], ['VIRAL', 'Everyone is talking about this CEO clip'], ['UPDATE', 'CEO cancels keynote appearance'],
  ];
  const r0 = rng(7);
  const cards = [{news: NEWS[0], o: 0}, {text: FIRST[0], bot: true, who: botHandle(0)}, {news: NEWS[2], o: 1}];
  let b = 1, nI = 1;
  while (cards.length < COLS * ROWS) {
    if (r0() < .38 && b < BOT_TEXTS.length) { cards.push({text: b < FIRST.length ? FIRST[b] : BOT_TEXTS[b], bot: true, who: botHandle(b % 25)}); b++; }
    else { cards.push({news: NEWS[nI % NEWS.length], o: Math.floor(r0() * OUTLETS.length)}); nI++; }
  }
  const rr = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const wrap = (g, text, maxW) => { const out = []; let line = ''; for (const w of text.split(/\s+/)) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; } if (line) out.push(line); return out; };
  const atlasCv = document.createElement('canvas'); atlasCv.width = CW * COLS; atlasCv.height = CH * ROWS;
  {
    const g = atlasCv.getContext('2d');
    cards.forEach((cd, i) => {
      g.save(); g.translate((i % COLS) * CW, Math.floor(i / COLS) * CH);
      rr(g, 6, 6, CW - 12, CH - 12, 18); g.fillStyle = cd.news ? '#121815' : PAL.surface; g.fill(); g.strokeStyle = 'rgba(218,240,224,.16)'; g.lineWidth = 2; g.stroke();
      if (cd.news) {                       // a news tile: outlet, section tag, headline, time
        const [name, col] = OUTLETS[cd.o], [tag, head] = cd.news;
        g.textBaseline = 'middle'; g.fillStyle = col; g.font = `700 19px ${FONT}`; g.fillText(name.toUpperCase(), 28, 36);
        const nw = g.measureText(name.toUpperCase()).width;
        g.font = `700 15px ${FONT}`; const tw = g.measureText(tag).width + 16;
        rr(g, 40 + nw, 24, tw, 24, 6); g.fillStyle = tag === 'BREAKING' || tag === 'RUMOR' ? '#FF4D6D' : 'rgba(255,255,255,.12)'; g.fill();
        g.fillStyle = tag === 'BREAKING' || tag === 'RUMOR' ? '#12060A' : PAL.ink; g.fillText(tag, 48 + nw, 37);
        g.fillStyle = PAL.ink; g.font = `650 27px ${FONT}`;
        let hl = wrap(g, head, CW - 56); if (hl.length > 2) { hl = hl.slice(0, 2); hl[1] = hl[1].replace(/\s*\S*$/, '…'); }
        hl.forEach((l, k) => g.fillText(l, 28, 84 + k * 34));
        g.fillStyle = PAL.muted; g.font = `400 16px ${FONT}`; g.fillText(`${1 + (i % 9)} min ago`, 28, 150);
        g.restore(); return;
      }
      g.beginPath(); g.arc(46, 46, 19, 0, Math.PI * 2); g.fillStyle = AV[i % AV.length]; g.fill();
      g.textBaseline = 'middle'; g.fillStyle = PAL.ink; g.font = `600 21px ${FONT}`; g.fillText('@' + cd.who, 76, 40);
      g.fillStyle = PAL.muted; g.font = `400 18px ${FONT}`; g.fillText(`14:0${2 + (i % 4)} · now`, 76, 63);
      g.fillStyle = PAL.ink; g.font = `400 22px ${FONT}`;
      let ls = wrap(g, cd.text, CW - 56); if (ls.length > 3) { ls = ls.slice(0, 3); ls[2] = ls[2].replace(/\s*\S*$/, '…'); }
      ls.forEach((l, k) => g.fillText(l, 28, 100 + k * 26));
      g.restore();
    });
  }
  const atlas = new THREE.CanvasTexture(atlasCv); atlas.colorSpace = THREE.SRGBColorSpace; atlas.anisotropy = 8;

  const GX = 25, GY = 39, PX = CARD_W * 1.08, PY = CARD_H * 1.12;
  const HEAD = {x: 0, y: PY * 1.55, w: 5.4, h: 1.55};
  const inRect = (x, y, r) => Math.abs(x - r.x) < r.w / 2 + CARD_W / 2 - .2 && Math.abs(y - r.y) < r.h / 2 + CARD_H / 2;
  const rnd = rng(1234567);
  const firstPos = [{x: 0, y: 0}, {x: 0, y: -PY}, {x: 0, y: -2 * PY}];
  const cells = [];
  for (let iy = 0; iy < GY; iy++) for (let ix = 0; ix < GX; ix++) {
    const x = (ix - (GX - 1) / 2) * PX, y = (iy - (GY - 1) / 2) * PY;
    if (inRect(x, y, HEAD) || firstPos.some(f => Math.abs(f.x - x) < .01 && Math.abs(f.y - y) < .01)) continue;
    cells.push({x, y, k: Math.hypot(x * .55, y + PY) * (.65 + rnd() * .7)});
  }
  cells.sort((a, z) => a.k - z.k);
  const N = 3 + cells.length;
  const swarmAt = i => T.swarm0 + Math.log(Math.max(1, i) / 3) / T.swarmRate;
  const geoC = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(CARD_W, CARD_H));
  const aOff = new Float32Array(N * 3), aCell = new Float32Array(N * 2), aSpawn = new Float32Array(N), aSeed = new Float32Array(N), aBot = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = i < 3 ? firstPos[i] : cells[i - 3];
    aOff.set([p.x + (i < 3 ? 0 : (rnd() - .5) * .12), p.y + (i < 3 ? 0 : (rnd() - .5) * .08), i * 1e-5], i * 3);
    const card = i < 3 ? i : 3 + Math.floor(rnd() * (COLS * ROWS - 3));
    aCell.set([card % COLS, ROWS - 1 - Math.floor(card / COLS)], i * 2);
    aSpawn[i] = i < 3 ? T.post[i] : Math.max(T.swarm0, swarmAt(i));
    aSeed[i] = rnd() * 100; aBot[i] = cards[card].bot ? 1 : 0;
  }
  for (const [n, a, s] of [['aOff', aOff, 3], ['aCell', aCell, 2], ['aSpawn', aSpawn, 1], ['aSeed', aSeed, 1], ['aBot', aBot, 1]]) geoC.setAttribute(n, new THREE.InstancedBufferAttribute(a, s));
  geoC.instanceCount = N;
  const U = {uTime: {value: 0}, uChaos: {value: 0}, uFade: {value: 1}, uCells: {value: new THREE.Vector2(COLS, ROWS)}, uMap: {value: atlas},
    uRed: {value: new THREE.Color(PAL.sel)}, uHit: {value: new THREE.Color(PAL.hiveRed)}, uGlitch: {value: 1}};
  const matC = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, depthTest: false,
    vertexShader: `${GLSL_HASH}
      attribute vec3 aOff; attribute vec2 aCell; attribute float aSpawn, aSeed, aBot;
      uniform float uTime, uChaos, uFade, uGlitch; uniform vec2 uCells;
      varying vec2 vUv; varying float vA, vTint, vHit;
      void main(){
        float age = uTime - aSpawn, app = clamp(age/.22, 0., 1.), tick = floor(uTime*12.);
        vec3 p = position * (.82 + .18*app);
        float jump = step(.86, h1(aSeed*3.1 + tick)) * uChaos * uGlitch;
        vec3 jit = vec3(h1(aSeed + tick) - .5, h1(aSeed*1.7 + tick) - .5, 0.) * jump * .9;
        vUv = (aCell + uv) / uCells;
        float fl = h1(aSeed*5.3 + tick);
        vA = step(0., age) * app * uFade * mix(1., fl > .45 ? 1. : .25, uChaos*.85);
        vTint = step(.965 - uChaos*.05, h1(aSeed*9.1 + floor(uTime*5.))) * step(.01, uChaos);
        vHit = aBot * step(0., age) * exp(-age*9.);                     // the tracer's impact
        gl_Position = projectionMatrix * viewMatrix * vec4(aOff + p + jit, 1.);
      }`,
    fragmentShader: `uniform sampler2D uMap; uniform vec3 uRed, uHit; varying vec2 vUv; varying float vA, vTint, vHit;
      void main(){
        vec4 c = texture2D(uMap, vUv);
        c.rgb = mix(c.rgb, c.rgb*.4 + uRed*.75, vTint);
        c.rgb += uHit * vHit * .55;
        float a = c.a*vA; if (a < .01) discard;
        gl_FragColor = vec4(c.rgb, a);
      }`,
  });
  const wall = new THREE.Mesh(geoC, matC); wall.frustumCulled = false; scene.add(wall);

  // tracers: a red streak into every bot post just before it appears, from the left (where BotHive's dots went out)
  const TR = .17;
  const geoT = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
  const tFrom = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const a = (rnd() - .5) * .9; tFrom.set([-Math.cos(a), Math.sin(a), .25], i * 3); }
  for (const [n, a, s] of [['aOff', aOff, 3], ['aSpawn', aSpawn, 1], ['aBot', aBot, 1], ['aFrom', tFrom, 3]]) geoT.setAttribute(n, new THREE.InstancedBufferAttribute(a, s));
  geoT.instanceCount = N;
  const UT = {uTime: {value: 0}, uLen: {value: 9}, uDur: {value: TR}, uCol: {value: new THREE.Color(PAL.hiveRed)}, uOn: {value: 1}};
  const matT = new THREE.ShaderMaterial({
    uniforms: UT, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec3 aOff, aFrom; attribute float aSpawn, aBot; uniform float uTime, uLen, uDur;
      varying float vA, vU;
      void main(){
        float k = (uTime - (aSpawn - uDur)) / uDur;                // 0..1 in flight, then gone
        vA = aBot * step(0., k) * step(k, 1.);
        float dist = uLen * (1. + length(aOff.xy)*.04);            // far posts: longer shots, so they read at any zoom
        vec3 dir = normalize(aFrom);
        vec3 head = aOff + dir * dist * (1. - clamp(k, 0., 1.));
        vec3 tail = head + dir * dist * .55;
        vec3 side = normalize(cross(dir, vec3(0., 0., 1.))) * (.05 + length(aOff.xy)*.004);
        vU = position.x + .5;                                       // 0 = tail, 1 = head
        vec3 p = mix(tail, head, vU) + side * position.y * 2.;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: `uniform vec3 uCol; uniform float uOn; varying float vA, vU;
      void main(){ float u = clamp(vU, 0., 1.), a = clamp(vA, 0., 1.) * uOn * u * u;   // u², not pow(): pow of a slightly negative u is NaN, and bloom spreads a NaN into black squares
        gl_FragColor = vec4(max(uCol*a*1.8 + vec3(1.)*a*smoothstep(.85, 1., u), 0.), 1.); }`,
  });
  const tracers = new THREE.Mesh(geoT, matT); tracers.frustumCulled = false; scene.add(tracers);

  /* ---------------- headlines ---------------- */
  function headline(text, sub, w, h) {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = Math.round(1024 * h / w);
    const g = cv.getContext('2d'); const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    let last = -1;
    const draw = (n, caret) => {
      const key = n * 2 + (caret ? 1 : 0); if (key === last) return; last = key;
      g.clearRect(0, 0, cv.width, cv.height);
      rr(g, 8, 8, cv.width - 16, cv.height - 16, 26); g.fillStyle = '#0F1512'; g.fill(); g.strokeStyle = 'rgba(218,240,224,.22)'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#FF4D6D'; rr(g, 46, 40, 150, 40, 8); g.fill();
      g.fillStyle = '#12060A'; g.font = `700 24px ${FONT}`; g.textBaseline = 'middle'; g.fillText(sub, 62, 61);
      g.fillStyle = PAL.muted; g.font = `500 24px ${FONT}`; g.fillText('Newswire · just now', 214, 61);
      g.fillStyle = PAL.ink; g.font = `650 50px ${FONT}`;
      const shown = text.slice(0, n), ls = wrap(g, text, cv.width - 92);
      let left = n, y = 140, cx = 46, cy = 140;
      for (const l of ls) { const s = l.slice(0, Math.max(0, left)); if (left > 0) { g.fillText(s, 46, y); cx = 46 + g.measureText(s).width; cy = y; } left -= l.length + 1; y += 62; }
      if (caret && n < text.length) g.fillRect(cx + 4, cy - 26, 4, 52);
      tex.needsUpdate = true;
      return shown;
    };
    return {tex, draw};
  }
  const H1 = headline(HEADLINE, 'BREAKING', HEAD.w, HEAD.h);
  const mk = (H, r) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), new THREE.MeshBasicMaterial({map: H.tex, transparent: true, depthTest: false, depthWrite: false}));
    m.position.set(r.x, r.y, .01); m.renderOrder = 2; scene.add(m); return m; };
  const head = mk(H1, HEAD);

  /* ---------------- the field, the pixels, the dot ---------------- */
  const F = makeField({W: 40, D: 24, NX: 150, NZ: 90});
  F.U.uRingSpeed.value = T.ringSpeed; F.U.uRingT.value = T.ring; F.U.uNoise.value = 1;
  scene.add(F.mesh);
  // the hills the ring finds: one swarm (red), two suspicious (yellow), four organic (salat); each rises when the
  // ring reaches it, organic ones settle back low, the swarm stays up until the landing takes over
  const HILLS = [
    {x: 8, z: -3.4, h: 5.2, w: 7.5, kind: 2}, {x: -11, z: 4, h: 3.0, w: 9, kind: 1}, {x: 13, z: 7, h: 2.4, w: 7, kind: 1},
    {x: -5, z: -7, h: 2.0, w: 8, kind: 0}, {x: 2, z: 8, h: 1.6, w: 6, kind: 0}, {x: -15, z: -4.5, h: 1.8, w: 7, kind: 0}, {x: 16, z: -8, h: 1.4, w: 6, kind: 0},
  ].map(p => ({...p, hit: T.ring + Math.hypot(p.x, p.z) / T.ringSpeed}));
  HILLS.forEach((p, i) => { F.U.uPeaks.value[i].set(p.x, p.z, 0, p.w); F.U.uPeakKind.value[i] = p.kind; });
  F.U.uKindOn.value = 1;
  const hit = HILLS[0].hit;
  const NP = F.NX * F.NZ, WALL_W = GX * PX, WALL_H = GY * PY;
  const pStart = new Float32Array(NP * 3), pDelay = new Float32Array(NP), pSeed = new Float32Array(NP);
  for (let i = 0; i < NP; i++) {
    const x = F.pos[i * 3], z = F.pos[i * 3 + 2];
    pStart.set([x / F.W * WALL_W + (rnd() - .5) * PX * .9, -z / F.D * WALL_H + (rnd() - .5) * PY * .9, 0], i * 3);
    pDelay[i] = T.morph0 + (Math.hypot(x / F.W, z / F.D) * .6 + rnd() * .4) * T.morphSpread; pSeed[i] = rnd() * 100;
  }
  const geoP = new THREE.BufferGeometry();
  geoP.setAttribute('position', new THREE.BufferAttribute(pStart, 3)); geoP.setAttribute('aTarget', new THREE.BufferAttribute(F.pos, 3));
  geoP.setAttribute('aDelay', new THREE.BufferAttribute(pDelay, 1)); geoP.setAttribute('aSeed', new THREE.BufferAttribute(pSeed, 1));
  const UP = {...F.U, uA: {value: 0}, uDur: {value: T.morphDur}, uScale: {value: 1}, uInk: {value: new THREE.Color(PAL.ink)}};
  const matP = new THREE.ShaderMaterial({
    uniforms: UP, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `${FIELD_GLSL}
      attribute vec3 aTarget; attribute float aDelay, aSeed; uniform float uDur, uScale; varying float vK, vFl;
      void main(){
        float k = clamp((uTime - aDelay)/uDur, 0., 1.); k = k*k*(3. - 2.*k); vK = k;
        float passed, ring, peak, nz; vec3 tgt = aTarget; tgt.y = fieldH(aTarget.xz, passed, ring, peak, nz);
        vec3 p = mix(position, tgt, k) + vec3((h1(aSeed) - .5)*6., 4. + h1(aSeed*2.3)*6., (h1(aSeed*3.7) - .5)*6.) * sin(k*3.14159);
        vFl = h1(aSeed + floor(uTime*12.));
        vec4 mv = modelViewMatrix * vec4(p, 1.);
        gl_PointSize = mix(3.4, 2.1, k) * uScale * (90. / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float uA; uniform vec3 uInk, uCool; varying float vK, vFl;
      void main(){ vec2 d = gl_PointCoord - .5; if (dot(d, d) > .25) discard; gl_FragColor = vec4(mix(uInk*(.55 + .6*vFl), uCool, vK)*uA, 1.); }`,
  });
  const pixels = new THREE.Points(geoP, matP); pixels.frustumCulled = false; scene.add(pixels);
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({map: glowTexture(), transparent: true, depthTest: false, depthWrite: false, opacity: 0}));
  dot.position.set(0, .4, 0); dot.renderOrder = 3; scene.add(dot);

  /* ---------------- overlay words ---------------- */
  const WORDS = [];
  { const r = rng(99); for (let t = T.words0, i = 0; t < T.words1; t += .3 - .1 * (t - T.words0) / (T.words1 - T.words0), i++)
    WORDS.push({t0: t, t1: t + .26, bot: i % 2 === 1, x: 12 + r() * 76, y: 12 + r() * 76, size: 46 + r() * 50}); }
  const wordsEl = ctx.$('#words'); let wordsHtml = '';
  const renderWords = t => {
    if (qs('words', '1') === '0') return;
    let html = WORDS.filter(w => t >= w.t0 && t < w.t1).map(w => `<div style="position:absolute;left:${w.x}%;top:${w.y}%;transform:translate(-50%,-50%);font-weight:650;letter-spacing:-.03em;font-size:${w.size}px;color:${w.bot ? PAL.sel : PAL.cool};text-shadow:0 0 .35em currentColor">${w.bot ? 'bot?' : 'real?'}</div>`).join('');
    if (t >= T.big0 && t < T.cut) html += `<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);white-space:nowrap;font-weight:650;letter-spacing:-.03em;font-size:88px;color:${PAL.ink};text-shadow:0 0 .25em rgba(255,255,255,.35)">Which voice is real?</div>`;
    if (html !== wordsHtml) { wordsEl.innerHTML = html; wordsHtml = html; }
  };

  /* ---------------- the frame ---------------- */
  function frame(t, c) {
    const chaos = t < T.cut ? ss(T.chaos0, T.chaos1, t) : 0;
    U.uTime.value = t; U.uChaos.value = chaos; U.uGlitch.value = c.glitch ? 1 : 0; UT.uTime.value = t;
    wall.visible = tracers.visible = t < T.cut;
    const n = Math.round(clamp((t - T.type0) / (T.type1 - T.type0)) * HEADLINE.length);
    H1.draw(n, Math.floor(t / .38) % 2 === 0);
    head.visible = t >= T.type0 - .3 && t < T.cut;
    head.material.opacity = ss(T.type0 - .3, T.type0, t) * (chaos > 0 && Math.floor(t * 12) % 7 === 0 ? .35 : 1);
    c.rgb = chaos * .0042 * (Math.floor(t * 12) % 3 === 0 ? 1.8 : 1);
    c.shake = chaos * chaos * .018;
    ctx.bloom.strength = t < T.cut ? .35 + chaos * .35 : .6;
    // decay
    F.U.uTime.value = t;
    UP.uA.value = t >= T.cut ? 1 - ss(T.grid0 + .3, T.grid1 + .6, t) * .92 : 0;
    pixels.visible = t >= T.cut && t < T.grid1 + 1.2;
    UP.uScale.value = c.px / 900;
    F.U.uA.value = ss(T.grid0, T.grid1, t); F.mesh.visible = t >= T.grid0;
    HILLS.forEach((p, i) => {
      const rise = ss(p.hit - .04, p.hit + .2, t), pop = .25 * Math.exp(-Math.max(0, t - p.hit - .2) * 4) * rise;
      const keep = p.kind === 2 ? 1 - .4 * ss(T.ui0 - .4, T.ui0 + 1.2, t) : 1 - .65 * ss(p.hit + .5, p.hit + 1.6, t);
      F.U.uPeaks.value[i].z = p.h * rise * (keep + pop);
    });
    F.U.uRingRed.value = t > hit - .1 && t < hit + 2.0 ? 1 : 0;     // the ring that finds the swarm runs on red (app.js)
    dot.material.opacity = t < T.dot ? 0 : ss(T.dot, T.dot + .25, t) * (.75 + .25 * Math.sin((t - T.dot) * 5.2)) * (1 - ss(T.dotFly0, T.dotFly0 + .05, t));
    dot.scale.setScalar(1.4 + .5 * Math.exp(-Math.max(0, t - T.ring) * 3) + .15 * Math.sin((t - T.dot) * 5.2));
    scene.background.set(0x000000).lerp(new THREE.Color(PAL.bg), ss(T.grid0, T.grid1 + .8, t));
    renderWords(t);
  }
  // the landing fades in over the field; the red dot flies from the 3D scene into the "ı"
  function after(t) {
    if (mode !== 'decay') return;
    const $ = ctx.$, a = ss(T.ui0, T.ui0 + .8, t);
    $('.hero-wordmark').style.opacity = a; $('.bar').style.opacity = ss(T.ui0 + .25, T.ui0 + 1.05, t);
    const fly = $('#flyDot'), idot = $('#iDot');
    const from = ctx.toUI(dot.position);
    const u = ctx.ui.getBoundingClientRect(), r = idot.getBoundingClientRect(), sc = u.width / ctx.uiW;
    const to = {x: (r.left - u.left + r.width / 2) / sc, y: (r.top - u.top + r.height / 2) / sc};
    const k = ss(T.dotFly0, T.dotFly1, t), arc = Math.sin(k * Math.PI) * -60;
    fly.style.opacity = t >= T.dotFly0 && t < T.dotFly1 ? 1 : 0;
    fly.style.transform = `translate(${from.x + (to.x - from.x) * k}px,${from.y + (to.y - from.y) * k + arc}px) scale(${1.6 - .6 * k})`;
    idot.style.opacity = t >= T.dotFly1 ? .75 + .25 * Math.exp(-(t - T.dotFly1) * 4) : 0;
    idot.style.transform = `scale(${t >= T.dotFly1 ? 1 + .9 * Math.exp(-(t - T.dotFly1) * 5) : 1})`;
    const cap = $('#cap'); cap.style.opacity = ss(T.cap0, T.cap0 + .5, t) * (1 - ss(T.cap1 - .4, T.cap1, t));
  }
  ctx.start();
}
