// Intercept: the radar's result view, staged. The dashboard's map (time lag × meaning gap) with its origin corner
// ("now, same meaning"); organic posts land as green dots anywhere and leave a low carpet; the bots' red dots come in
// volleys from BotHive's side and all land near the origin: a hill grows there, crosses the CFAR threshold (dashed,
// pink, mean + 3σ as in app.js) and turns the selected-group pink; the sonar ring from the antenna's corner turns red.
// Then the science: the CFAR formula, the SPRT trace crossing ln((1−β)/α), and the dashboard's verdict
// ("Swarm Detected", ui/radar.css). ?accounts=25 · ?post=4 (the post the SPRT decided at) · ?credits=0 (no name/year
// lines under the formulas) · ?snr="2.1 → 13.9 dB" (shown only if given: put the real numbers of your run).
import {createStage, THREE, PAL, clamp, ss, pulse, rng, qn, qs, glowTexture, makeField} from './core.js';

const ACC = qn('accounts', 25), POST = qn('post', 4), CREDITS = qs('credits', '1') !== '0', SNR = qs('snr', '');
const W = 40, D = 24, O = new THREE.Vector2(-W / 2, D / 2);          // origin corner: now, meaning gap 0
const PEAK = new THREE.Vector2(-W / 2 + 4.2, D / 2 - 3.4), THR = 2.6;
const VOL = [3.2, 4.6, 5.8, 6.8, 7.6];                                // swarm volleys
const PINGS = [0.2, 2.6, 5.0, 7.4, 9.8, 12.2, 14.6, 17.0];

// the principle, in six beats: [start, end, headline, one line under it]
const STEPS = [
  [.4, 3.1, 'Every dot is a post.', 'Green: people reacting on their own. Red: accounts we planted with BotHive.'],
  [3.1, 6.2, 'One post proves nothing.', 'So the radar compares every pair of accounts: how close in time, how close in meaning.'],
  [6.2, 9.2, 'People scatter. A swarm piles up.', 'Same message, same minutes: the pairs stack up in one corner of the map.'],
  [9.2, 12.3, 'Is the pile unusual for this topic?', 'The bar adapts to each topic\'s own noise, like radar CFAR. Above it: suspicious.'],
  [12.3, 15.4, 'Evidence adds up, post by post.', 'The radar decides as soon as the false-alarm risk is under the 2% we set.'],
  [15.4, 19, 'Coordinated. Explained. Measured.', 'Not "this opinion is wrong": these accounts act in sync.'],
];
const UI = `
<div class="p-axes" id="axes"></div>
<div class="p-cap" id="pcap"><b id="pcapH"></b><span id="pcapS"></span><i id="pcapN"></i></div>
<div class="formula" id="f1" style="right:60px;top:170px;text-align:right"></div>
<div class="formula" id="f2" style="right:60px;top:170px;text-align:right"></div>
<div class="sprt" id="sprt"><h4>SPRT · evidence <b>Λ</b> post by post</h4>
  <svg viewBox="0 0 330 120" id="sprtSvg">
    <line x1="0" x2="330" y1="22" y2="22" stroke="#FF5C9E" stroke-dasharray="5 5" stroke-width="1.2"/>
    <line x1="0" x2="330" y1="76" y2="76" stroke="rgba(218,240,224,.18)" stroke-width="1"/>
    <line x1="0" x2="330" y1="108" y2="108" stroke="#8EE87B" stroke-dasharray="5 5" stroke-width="1.2"/>
    <text class="lbl" x="0" y="16">coordinated · ln((1−β)/α) ≈ 3.8</text>
    <text class="lbl" x="0" y="102">organic · ln(β/(1−α)) ≈ −2.3</text>
    <polyline id="sprtLine" fill="none" stroke="#FF5C9E" stroke-width="2.4" stroke-linejoin="round" points=""/>
    <circle id="sprtDot" r="5" fill="#FF5C9E" opacity="0"/>
    <text class="lbl" id="sprtTag" x="0" y="0" opacity="0" style="fill:#F2F6F3">decided at post ${POST}</text>
  </svg></div>
<div class="p-verdict" id="verdict" style="opacity:0">
  <div class="verdict"><h1 data-v="coordinated">Swarm Detected</h1>
    <p class="gline"><span><i class="dot" data-v="coordinated"></i>${ACC} accounts are saying the same thing almost simultaneously.</span>
      ${SNR ? `<span class="kind"><span>SNR</span>${SNR}</span>` : ''}<span class="sim">simulated attack</span></p></div>
</div>`;

export function run() {
  const ctx = createStage({
    id: 'intercept', title: 'Intercept', duration: 19, ui: UI, fov: 32,
    bloom: {strength: .62, radius: .55, threshold: .16},
    path: [
      {t: 0, p: [6, 30, 40], l: [0, 0, 0]},
      {t: 3.0, p: [4, 27, 37], l: [-1, 0, 1], e: 'io'},
      {t: 8.5, p: [-2, 17, 27], l: [-8, 1, 4], e: 'io'},
      {t: 13.5, p: [-6, 10, 20], l: [-13, 2.2, 7], e: 'io'},
      {t: 19, p: [-1, 9.2, 19], l: [-12.5, 2.4, 7.2], e: 'io'},
    ],
    frame, after,
  });
  const {scene, $} = ctx;
  scene.background = new THREE.Color(PAL.bg);

  const F = makeField({W, D, NX: 150, NZ: 90, thr: THR});
  F.U.uCalm.value = 1; F.U.uRingO.value.copy(O); F.U.uRingSpeed.value = 16;
  const r = rng(3);
  for (let i = 1; i < 4; i++) F.U.uPeaks.value[i].set((r() - .2) * W * .7, (r() - .5) * D * .7, .55 + r() * .4, 9 + r() * 10);   // organic carpet
  F.U.uPeaks.value[0].set(PEAK.x, PEAK.y, 0, 5);
  scene.add(F.mesh);

  // the CFAR threshold: a dashed outline at mean + 3σ
  const thrGeo = new THREE.BufferGeometry().setFromPoints([[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([x, z]) => new THREE.Vector3(x * W / 2 * .96, THR, z * D / 2 * .96)));
  const thrMat = new THREE.LineDashedMaterial({color: PAL.sel, dashSize: .55, gapSize: .45, transparent: true, opacity: 0});
  const thr = new THREE.Line(thrGeo, thrMat); thr.computeLineDistances(); scene.add(thr);

  // the posts: red (bots, volleys, all near the origin) and green (people, anywhere, now and then)
  const posts = [];
  for (const [vi, tv] of VOL.entries()) for (let j = 0; j < 10; j++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 1.6;
    posts.push({bot: 1, t0: tv + r() * .25, dur: .9 + r() * .3, from: [-W * .9 - r() * 8, 18 + r() * 10, -D * .2 + (r() - .5) * 20],
      to: [PEAK.x + Math.cos(a) * d, 0, PEAK.y + Math.sin(a) * d]});
  }
  for (let j = 0; j < 70; j++) {
    const to = [(r() - .5) * W * .9, 0, (r() - .5) * D * .9];
    posts.push({bot: 0, t0: .5 + r() * 17, dur: 1 + r() * .5, from: [to[0] + (r() - .5) * 10, 20 + r() * 8, to[2] - 8 - r() * 8], to});
  }
  const swarmLand = posts.filter(p => p.bot).map(p => p.t0 + p.dur).sort((a, b) => a - b);
  const nLanded = t => { let n = 0; while (n < swarmLand.length && swarmLand[n] <= t) n++; return n; };
  const peakH = t => { const n = nLanded(t); return Math.min(5.4, .95 * Math.sqrt(n) - (n ? 0 : 0)); };
  // the hill turns pink when the threshold is introduced (beat 4), not earlier: the viewer learns the bar first
  const THR_ON = 9.8;
  const crossT = Math.max(THR_ON, (() => { for (let t = 0; t < 19; t += .02) if (peakH(t) > THR + .15) return t; return 99; })());

  const NP = posts.length, TR = 6;
  const pa = {from: new Float32Array(NP * TR * 3), to: new Float32Array(NP * TR * 3), tm: new Float32Array(NP * TR * 3)};
  posts.forEach((p, i) => { for (let k = 0; k < TR; k++) { const o = (i * TR + k) * 3; pa.from.set(p.from, o); pa.to.set(p.to, o); pa.tm.set([p.t0, p.dur, k + p.bot * 10], o); } });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pa.from, 3)); geo.setAttribute('aTo', new THREE.BufferAttribute(pa.to, 3)); geo.setAttribute('aT', new THREE.BufferAttribute(pa.tm, 3));
  const UPo = {uTime: {value: 0}, uScale: {value: 1}, uMap: {value: glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,1)', 'rgba(255,255,255,0)')},
    uBot: {value: new THREE.Color(PAL.swarm)}, uHum: {value: new THREE.Color(PAL.salat)}, uPeak: {value: new THREE.Vector3(PEAK.x, 0, PEAK.y)}, uH: {value: 0}};
  const mat = new THREE.ShaderMaterial({
    uniforms: UPo, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec3 aTo, aT; uniform float uTime, uScale, uH; uniform vec3 uPeak; varying float vA, vBot;
      void main(){
        float bot = step(9.5, aT.z), k = aT.z - bot*10.;
        float s = (uTime - aT.x - k*.025) / aT.y, e = clamp(s, 0., 1.);
        vec3 to = aTo; vec2 q = aTo.xz - uPeak.xz; to.y = bot * uH * exp(-dot(q, q)/5.);     // they land on the hill
        vec3 p = mix(position, to, e*e*(3. - 2.*e)*.3 + e*.7) + vec3(0., 3.*sin(e*3.14159)*(1. - bot*.5), 0.);
        float land = 1. - smoothstep(1., 1.35, s);                                          // a short glow on landing
        vA = step(0., s) * land * (1. - k/${TR}.) * (s > 1. ? (1. - k/${TR}.)*2. : 1.);
        vBot = bot;
        vec4 mv = modelViewMatrix * vec4(p, 1.);
        gl_PointSize = (1. - k/${TR + 2}.) * (bot > .5 ? 30. : 20.) * uScale / -mv.z * (s > 1. ? 1.8 : 1.);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform sampler2D uMap; uniform vec3 uBot, uHum; varying float vA, vBot;
      void main(){ vec4 c = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(mix(uHum*.8, uBot*1.4, vBot)*c.a*vA, 1.); }`,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; scene.add(pts);

  /* ---------------- DOM: axes, formulas, SPRT, verdict ---------------- */
  const axes = $('#axes');
  axes.innerHTML = `<span class="t" id="axNow">now</span><span id="axLag">time lag →</span><span id="axGap">meaning gap →</span><span class="thr" id="axThr">threshold · mean + 3σ</span>`;
  const type = (el, txt, sub, t0, t, cps = 34) => {
    const n = Math.floor(clamp((t - t0) * cps, 0, txt.length));
    el.style.opacity = t >= t0 ? 1 : 0;
    const html = `${txt.slice(0, n)}${n < txt.length && Math.floor(t * 3) % 2 === 0 ? '<span class="caret"></span>' : ''}${n >= txt.length && sub && CREDITS ? `<small>${sub}</small>` : ''}`;
    if (el._h !== html) { el.innerHTML = html; el._h = html; }
  };
  const SPRT = [0, 0, 1.5, 3.0, 4.5];        // the doc's example (docs/signal-processing.md §3.7): no echo on post 1, then +1.5 ×3
  const sx = i => 10 + i * (300 / Math.max(4, POST)), sy = v => 76 - v * 14.2;

  function frame(t, c) {
    F.U.uTime.value = t; UPo.uTime.value = t; UPo.uScale.value = c.px / 810;
    const h = peakH(t); F.U.uPeaks.value[0].z = h; UPo.uH.value = h;
    const ping = PINGS.filter(p => p <= t).pop() ?? -99; F.U.uRingT.value = ping;
    F.U.uThr.value = t >= THR_ON ? THR : 1e3;
    F.U.uRingRed.value = t >= crossT && ping >= crossT - 2.4 ? 1 : 0;
    thrMat.opacity = ss(9.3, 10, t) * .7;
    const kick = VOL.reduce((s, v) => s + pulse(t, v + 1, 8), 0);
    c.shake = kick * .0015; c.rgb = kick * .0012 + pulse(t, crossT, 5) * .004;
    ctx.bloom.strength = .55 + pulse(t, crossT, 3) * .6;
    c.fade = 1 - ss(0, .5, t);
  }
  function after(t) {
    const P = (x, y, z) => ctx.toUI(new THREE.Vector3(x, y, z));
    const set = (id, p, dx = 0, dy = 0, op = 1) => { const e = $(`#${id}`); e.style.left = `${p.x + dx}px`; e.style.top = `${p.y + dy}px`; e.style.opacity = op; };
    set('axNow', P(O.x, 0, O.y), -10, 22, ss(.4, 1, t));
    set('axLag', P(0, 0, O.y), 0, 26, ss(.6, 1.2, t));
    set('axGap', P(O.x, 0, 0), -64, 0, ss(.8, 1.4, t));
    set('axThr', P(W / 2 * .96, THR, -D / 2 * .96), -40, -16, ss(9.4, 10, t));
    type($('#f1'), 'z_ij = (R_ij − median) / σ_R  >  3', 'CFAR · constant false alarm rate · radar, 1960s', 9.6, t);
    $('#f1').style.opacity = t >= 9.6 && t < 12.2 ? 1 : 0;
    type($('#f2'), 'Λ = Σ ΔΛ_k  ≥  ln((1−β)/α)', 'sequential probability ratio test · A. Wald, 1943', 12.6, t);
    $('#f2').style.opacity = t >= 12.6 && t < 15.3 ? 1 : 0;
    // the caption: one beat at a time, a soft cut between beats
    const st = STEPS.find(x => t >= x[0] && t < x[1]) || STEPS[STEPS.length - 1], si = STEPS.indexOf(st);
    const cap = $('#pcap'); cap.style.opacity = Math.min(ss(st[0], st[0] + .3, t), 1 - ss(st[1] - .25, st[1], t) * (si < STEPS.length - 1 ? 1 : 0));
    cap.style.transform = `translate(-50%, ${(1 - ss(st[0], st[0] + .35, t)) * 10}px)`;
    if ($('#pcapH').textContent !== st[2]) { $('#pcapH').textContent = st[2]; $('#pcapS').textContent = st[3]; $('#pcapN').textContent = `${si + 1} / ${STEPS.length}`; }
    // the SPRT trace: one step per post of the group, decided at post POST
    const sp = $('#sprt'); sp.style.opacity = ss(12.3, 12.8, t);
    const k = clamp((t - 12.8) / 2.0) * (SPRT.length - 1), pts2 = [];
    for (let i = 0; i <= Math.floor(k); i++) pts2.push(`${sx(i)},${sy(SPRT[i])}`);
    if (k % 1 > 0 && k < SPRT.length - 1) { const i = Math.floor(k), f = k % 1; pts2.push(`${sx(i) + (sx(i + 1) - sx(i)) * f},${sy(SPRT[i] + (SPRT[i + 1] - SPRT[i]) * f)}`); }
    $('#sprtLine').setAttribute('points', pts2.join(' '));
    const done = k >= SPRT.length - 1, dEl = $('#sprtDot'), tag = $('#sprtTag');
    dEl.setAttribute('cx', sx(SPRT.length - 1)); dEl.setAttribute('cy', sy(SPRT[SPRT.length - 1]));
    dEl.setAttribute('opacity', done ? 1 : 0); dEl.setAttribute('r', done ? 5 + 6 * Math.exp(-(t - 14.8) * 5) : 5);
    tag.setAttribute('x', sx(SPRT.length - 1)); tag.setAttribute('y', sy(SPRT[SPRT.length - 1]) + 26); tag.setAttribute('text-anchor', 'end'); tag.setAttribute('opacity', done ? 1 : 0);
    // the verdict, like the dashboard's result header
    const v = $('#verdict'), a = ss(15.4, 16.0, t);
    v.style.opacity = a; v.style.transform = `translateY(${(1 - a) * -18}px)`;
  }
  ctx.start();
}
