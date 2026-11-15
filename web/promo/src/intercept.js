// Intercept: the radar's result view, staged. The dashboard's map (time lag × meaning gap) with its origin corner
// ("now, same meaning"); organic posts land as green dots anywhere and leave a low carpet; the bots' red dots come in
// volleys from BotHive's side and all land near the origin: a hill grows there, crosses the CFAR threshold (dashed,
// pink, mean + 3σ as in app.js) and turns the selected-group pink; the sonar ring from the antenna's corner turns red.
// Then the science: the CFAR formula, the SPRT trace crossing ln((1−β)/α), and the dashboard's verdict
// ("Swarm Detected", ui/radar.css). ?accounts=25 · ?post=4 (the post the SPRT decided at) · ?pace=2.6 (time stretch for narration, 1 = the original 19 s) · ?credits=0 (no name/year
// lines under the formulas) · ?snr="2.1 → 13.9 dB" (shown only if given: put the real numbers of your run).
import {createStage, THREE, PAL, clamp, ss, pulse, rng, qn, qs, glowTexture, makeField} from './core.js';

const ACC = qn('accounts', 25), POST = qn('post', 4), CREDITS = qs('credits', '1') !== '0', SNR = qs('snr', '');
// ?pace=2.6: room for a narrator. Every beat, the camera path and the events last PACE times longer; what must stay brisk
// (a post's flight, the sonar ring, the field's ripple) keeps its real speed. All times below are written at pace 1.
const K = Math.max(.25, qn('pace', 2.6));
const W = 40, D = 24, O = new THREE.Vector2(-W / 2, D / 2);          // origin corner: now, meaning gap 0
const PEAK = new THREE.Vector2(-W / 2 + 4.2, D / 2 - 3.4), THR = 2.6;
const VOL = [3.2, 4.6, 5.8, 6.8, 7.6];                                // swarm volleys

// the principle, in six beats: [start, end, headline, one line under it]
const STEPS = [
  [.4, 3.1, '100 years of radar math. One new target.', 'Same two hypotheses. $p(x \\mid H_1)$, signal: a coordinated bot swarm. $p(x \\mid H_0)$, noise: people posting on their own.'],
  [3.1, 6.2, 'Aim at one topic. Lift signal over noise.', 'Beamforming picks one topic. A matched filter removes the clutter and despreads a campaign hidden across dozens of bots.'],
  [6.2, 9.2, 'One link is invisible. Dozens add up.', 'Coherent integration: over $M$ weak links the signal grows as $M$, random noise only as $\\sqrt{M}$. The swarm rises out of the noise.'],
  [9.2, 12.3, 'CFAR: a threshold that adapts to the background.', 'Median and MAD measure the noise of each topic. They ignore outliers, so the bots cannot raise their own detection bar.'],
  [12.3, 15.4, 'Thresholds are derived, not tuned.', 'Neyman-Pearson: fix the false-alarm rate, maximize detection. SPRT derives both thresholds from the chosen error rates $\\alpha$, $\\beta$.'],
  [15.4, 19, 'Math decides. Neural nets sense and explain.', 'Embeddings turn text into the input signal. Correlation, CFAR and SPRT give the verdict. A language model only explains it to people.'],
];
// $...$ in a caption is LaTeX, typeset by KaTeX (CDN, loaded before the scene starts; plain text if it cannot load)
const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/';
let katex = null;
const tex = s => s.replace(/\$([^$]+)\$/g, (_, m) => katex ? katex.renderToString(m, {throwOnError: false})
  : m.replace(/\\mid/g, '|').replace(/_1/g, '₁').replace(/_0/g, '₀'));
const UI = `
<div class="p-axes" id="axes"></div>
<div class="p-cap" id="pcap" style="width:1360px"><b id="pcapH"></b><span id="pcapS" style="white-space:nowrap"></span><i id="pcapN"></i></div>
<div class="formula" id="f0" style="right:60px;top:64px;text-align:right"></div>
<div class="formula" id="f1" style="right:60px;top:64px;text-align:right"></div>
<div class="formula" id="f2" style="right:60px;top:64px;text-align:right"></div>
<div class="sprt" id="sprt" style="left:auto;right:40px;top:190px;width:420px"><h4 id="sprtH">SPRT · evidence <b>Λ</b> post by post</h4>
  <svg viewBox="0 0 330 120" id="sprtSvg" style="height:141px;margin:22px 0 30px">
    <line x1="0" x2="330" y1="22" y2="22" stroke="#FF5C9E" stroke-dasharray="5 5" stroke-width="1.2"/>
    <line x1="0" x2="330" y1="76" y2="76" stroke="rgba(218,240,224,.18)" stroke-width="1"/>
    <line x1="0" x2="330" y1="108" y2="108" stroke="#8EE87B" stroke-dasharray="5 5" stroke-width="1.2"/>
    <foreignObject x="0" y="-14" width="330" height="34"><div class="lbl" id="sprtL1" style="color:rgba(218,232,222,.62);white-space:nowrap;height:100%;display:flex;align-items:center">coordinated · ln((1−β)/α) ≈ 3.8</div></foreignObject>
    <foreignObject x="0" y="110" width="330" height="34"><div class="lbl" id="sprtL2" style="color:rgba(218,232,222,.62);white-space:nowrap;height:100%;display:flex;align-items:center">organic · ln(β/(1−α)) ≈ −2.3</div></foreignObject>
    <polyline id="sprtLine" fill="none" stroke="#FF5C9E" stroke-width="2.4" stroke-linejoin="round" points=""/>
    <circle id="sprtDot" r="5" fill="#FF5C9E" opacity="0"/>
    <text class="lbl" id="sprtTag" x="0" y="0" opacity="0" style="fill:#F2F6F3">decided at post ${POST}</text>
  </svg></div>
<div class="p-verdict" id="verdict" style="opacity:0">
  <div class="verdict"><h1 data-v="coordinated">Swarm Detected</h1>
    <p class="gline"><span><i class="dot" data-v="coordinated"></i>${ACC} accounts are saying the same thing almost simultaneously.</span>
      ${SNR ? `<span class="kind"><span>SNR</span>${SNR}</span>` : ''}</p></div>
</div>`;

export function run() {
  const ctx = createStage({
    id: 'intercept', title: 'Intercept', duration: 19 * K, ui: UI, fov: 32,
    bloom: {strength: .62, radius: .55, threshold: .16},
    path: [
      {t: 0, p: [6, 30, 40], l: [0, 0, 0]},
      {t: 3.0, p: [4, 27, 37], l: [-1, 0, 1], e: 'io'},
      {t: 8.5, p: [-2, 17, 27], l: [-8, 1, 4], e: 'io'},
      {t: 13.5, p: [-6, 10, 20], l: [-13, 2.2, 7], e: 'io'},
      {t: 19, p: [-1, 9.2, 19], l: [-12.5, 2.4, 7.2], e: 'io'},
    ].map(k => ({...k, t: k.t * K})),
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
  for (let j = 0; j < Math.round(70 * K); j++) {
    const to = [(r() - .5) * W * .9, 0, (r() - .5) * D * .9];
    posts.push({bot: 0, t0: .5 + r() * 17, dur: 1 + r() * .5, from: [to[0] + (r() - .5) * 10, 20 + r() * 8, to[2] - 8 - r() * 8], to});
  }
  const swarmLand = posts.filter(p => p.bot).map(p => p.t0 + p.dur / K).sort((a, b) => a - b);
  const nLanded = t => { let n = 0; while (n < swarmLand.length && swarmLand[n] <= t) n++; return n; };
  const peakH = t => { const n = nLanded(t); return Math.min(5.4, .95 * Math.sqrt(n) - (n ? 0 : 0)); };
  // the hill turns pink when the threshold is introduced (beat 4), not earlier: the viewer learns the bar first
  const THR_ON = 9.8;
  const crossT = Math.max(THR_ON, (() => { for (let t = 0; t < 19; t += .02) if (peakH(t) > THR + .15) return t; return 99; })());

  const NP = posts.length, TR = 6;
  const pa = {from: new Float32Array(NP * TR * 3), to: new Float32Array(NP * TR * 3), tm: new Float32Array(NP * TR * 3)};
  posts.forEach((p, i) => { for (let k = 0; k < TR; k++) { const o = (i * TR + k) * 3; pa.from.set(p.from, o); pa.to.set(p.to, o); pa.tm.set([p.t0 * K, p.dur, k + p.bot * 10], o); } });
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
  axes.innerHTML = `<span class="thr" id="axThr">threshold · mean + 3σ</span>`;
  const type = (el, texSrc, plain, sub, t0, t, dur = 1.1 / K) => {      // a LaTeX formula (KaTeX), wiped in from the left
    const html = `${katex ? katex.renderToString(texSrc, {throwOnError: false}) : plain}${sub && CREDITS ? `<small>${sub}</small>` : ''}`;
    if (el._h !== html) { el.innerHTML = html; el._h = html; }
    el.style.opacity = t >= t0 ? 1 : 0;
    el.style.clipPath = `inset(-30% ${(1 - clamp((t - t0) / dur)) * 100}% -30% -5%)`;
  };
  const SPRT = [0, 0, 1.5, 3.0, 4.5];        // the doc's example (docs/signal-processing.md §3.7): no echo on post 1, then +1.5 ×3
  const sx = i => 10 + i * (300 / Math.max(4, POST)), sy = v => 76 - v * 14.2;

  function frame(T, c) {
    const t = T / K;                                   // T: real seconds; t: the scene's own clock (pace 1)
    F.U.uTime.value = T; UPo.uTime.value = T; UPo.uScale.value = c.px / 810;
    const h = peakH(t); F.U.uPeaks.value[0].z = h; UPo.uH.value = h;
    const ping = T >= .2 ? .2 + Math.floor((T - .2) / 2.4) * 2.4 : -99;   // a sonar ping every 2.4 real seconds F.U.uRingT.value = ping;
    F.U.uThr.value = t >= THR_ON ? THR : 1e3;
    F.U.uRingRed.value = t >= crossT && ping >= crossT * K - 2.4 ? 1 : 0;
    thrMat.opacity = ss(9.3, 10, t) * .7;
    const kick = VOL.reduce((s, v) => s + pulse(t, v + 1 / K, 8), 0);
    c.shake = kick * .0015; c.rgb = kick * .0012 + pulse(t, crossT, 5) * .004;
    ctx.bloom.strength = .55 + pulse(t, crossT, 3) * .6;
    c.fade = 1 - ss(0, .5, t);
  }
  function after(T) {
    const t = T / K;
    const P = (x, y, z) => ctx.toUI(new THREE.Vector3(x, y, z));
    const set = (id, p, dx = 0, dy = 0, op = 1) => { const e = $(`#${id}`); e.style.left = `${p.x + dx}px`; e.style.top = `${p.y + dy}px`; e.style.opacity = op; };
    set('axThr', P(W / 2 * .96, THR, -D / 2 * .96), -40, -16, ss(9.4, 10, t));
    type($('#f0'), 'S \\propto M, \\quad N \\propto \\sqrt{M} \\;\\; \\Rightarrow \\;\\; \\mathrm{SNR} \\propto \\sqrt{M}', 'S ∝ M ,  N ∝ √M   ⇒   SNR ∝ √M', '', 6.6, t);
    $('#f0').style.opacity = t >= 6.6 && t < 9.1 ? 1 : 0;
    type($('#f1'), 'z_{ij} = \\dfrac{R_{ij} - \\mathrm{median}}{\\sigma_R} > 3', 'z_ij = (R_ij − median) / σ_R  >  3', 'CFAR · constant false alarm rate · radar, 1960s', 9.6, t);
    $('#f1').style.opacity = t >= 9.6 && t < 12.2 ? 1 : 0;
    type($('#f2'), '\\Lambda = \\sum_k \\Delta\\Lambda_k \\;\\ge\\; \\ln\\dfrac{1-\\beta}{\\alpha}', 'Λ = Σ ΔΛ_k  ≥  ln((1−β)/α)', 'sequential probability ratio test · A. Wald, 1943', 12.6, t);
    $('#f2').style.opacity = t >= 12.6 && t < 15.3 ? 1 : 0;
    // the caption: one beat at a time, a soft cut between beats
    const st = STEPS.find(x => t >= x[0] && t < x[1]) || STEPS[STEPS.length - 1], si = STEPS.indexOf(st);
    const cap = $('#pcap'); cap.style.opacity = Math.min(ss(st[0], st[0] + .3, t), 1 - ss(st[1] - .25, st[1], t) * (si < STEPS.length - 1 ? 1 : 0));
    cap.style.transform = `translate(-50%, ${(1 - ss(st[0], st[0] + .35, t)) * 10}px)`;
    if ($('#pcapH').textContent !== st[2]) { $('#pcapH').textContent = st[2]; $('#pcapS').innerHTML = tex(st[3]); $('#pcapN').textContent = `${si + 1} / ${STEPS.length}`; }
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
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = KATEX + 'katex.min.css'; document.head.append(css);
  import(KATEX + 'katex.mjs').then(m => { katex = m.default; }).catch(() => {}).finally(() => {
    if (katex) {                                                       // the SPRT panel's labels, in LaTeX too
      $('#sprtH').innerHTML = `SPRT · evidence <b>${katex.renderToString('\\Lambda')}</b> post by post`;
      $('#sprtL1').innerHTML = tex('coordinated · $\\ln\\dfrac{1-\\beta}{\\alpha} \\approx 3.8$');
      $('#sprtL2').innerHTML = tex('organic · $\\ln\\dfrac{\\beta}{1-\\alpha} \\approx -2.3$');
    }
    ctx.start();
  });
}
