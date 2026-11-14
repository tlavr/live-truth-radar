// Live Truth Radar dashboard (T12). Scene and motion from the frontend reference
// (docs/frontend-reference on p2/frontend-reference); data from /api/* (T8).
import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';

const POLL_MS = 15000, INJECT_POLL_MS = 4000, INJECT_TIMEOUT_MS = 120000;
const WINDOW_HOURS = 6;            // DETECT_WINDOW_HOURS on the worker
const DESIGN_ALPHA = 0.02;         // until eval/report.json has operating_pfa
const RANK = {coordinated: 0, watching: 1, organic: 2};

const $ = id => document.getElementById(id);
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const hm = iso => iso.slice(11, 16);
const sum = g => (g ?? []).flat().reduce((a, b) => a + b, 0);
const pct = x => `${+(x * 100).toFixed(1)}%`;
const ago = iso => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const handle = a => a.startsWith('@') ? a : '@' + a;

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let detail = `${r.status}`;
    try { detail = (await r.json()).detail ?? detail; } catch {}
    throw new Error(detail);
  }
  return r.json();
}

/* ------------------------------------------------------------------ state */
const S = {
  topics: [], findings: [], lastPoll: null, metrics: null,
  topic: null, list: [], sel: 0, items: new Map(),
};
const alpha = () => S.metrics?.operating_pfa ?? DESIGN_ALPHA;
// measured Pfa at the operating threshold when eval/report.json has it, else the design alpha
const pfaText = () => S.metrics?.operating_pfa != null
  ? `False alarm rate at this threshold: ${pct(S.metrics.operating_pfa)} (target ≤ ${pct(DESIGN_ALPHA)})`
  : `Target false alarm rate: ${pct(DESIGN_ALPHA)}`;
const topicFindings = t => S.findings.filter(f => f.topic === t)
  .sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || b.created_at.localeCompare(a.created_at));

const PAL = {bg: '#0C100E', cool: '#63CF97', muted: '#A3B8AA', warm: '#B7F063', peak: '#FFE066'};

/* ------------------------------------------------------------------ scene */
// grid of detector bins (detect/config.py: 20 lag bins of 30 s, 10 mismatch bins of 0.1)
const L = 20, M = 10;
const W = 10, D = 6, PEAK = 3.1, NX = 190, NZ = 56;
const U0 = -1.3, U1 = L + .5, V0 = -1.3, V1 = M + .4;
const X = u => -W / 2 + (u - U0) / (U1 - U0) * W, Z = v => D / 2 - (v - V0) / (V1 - V0) * D;
const binU = x => (x + W / 2) / W * (U1 - U0) + U0, binV = z => (D / 2 - z) / D * (V1 - V0) + V0;
const canvas = $('scene'), stage = $('stage');
let renderer, composer, bloom, camera, scene, U, axisMat, geoms = [], ok = true;
const field = {P: new Float32Array(NX * NZ), C: new Float32Array(NX * NZ)};

function smooth(grid) {
  const out = new Float32Array(NX * NZ), su = .62, sv = .55;
  if (!grid) return out;
  for (let j = 0; j < NZ; j++) {
    const v = V0 + j / (NZ - 1) * (V1 - V0);
    for (let i = 0; i < NX; i++) {
      const u = U0 + i / (NX - 1) * (U1 - U0);
      let s = 0, w = 0;
      for (let m = Math.floor(v - 3); m <= Math.ceil(v + 3); m++)
        for (let l = Math.floor(u - 3); l <= Math.ceil(u + 3); l++) {
          const du = u - (l + .5), dv = v - (m + .5);
          const k = Math.exp(-du * du / (2 * su * su) - dv * dv / (2 * sv * sv));
          s += k * (grid[m]?.[l] ?? 0); w += k;
        }
      out[j * NX + i] = s / w;
    }
  }
  return out;
}

// Heights of the selected finding: its own pairs are the spike, the rest of the topic the carpet.
// One scale for both, so a weak group stays low next to the carpet instead of being stretched to PEAK.
function setField(f) {
  const P = smooth(f?.ambiguity?.counts), C = smooth(f?.ambiguity?.background);
  let mp = 0, mc = 0;
  for (let i = 0; i < P.length; i++) { mp = Math.max(mp, P[i]); mc = Math.max(mc, C[i]); }
  const k = PEAK / Math.max(mp, mc * 2.5, 1e-6);
  for (let i = 0; i < P.length; i++) { field.P[i] = P[i] * k; field.C[i] = C[i] * k; }
  for (const g of geoms) { g.attributes.aP.needsUpdate = true; g.attributes.aC.needsUpdate = true; }
}

function buildScene() {
  renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: 'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(PAL.bg);
  camera = new THREE.PerspectiveCamera(34, 1, .1, 100);

  const pos = new Float32Array(NX * NZ * 3);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const o = (j * NX + i) * 3;
    pos[o] = -W / 2 + i / (NX - 1) * W; pos[o + 1] = 0; pos[o + 2] = D / 2 - j / (NZ - 1) * D;
  }
  const attrs = g => {
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aC', new THREE.BufferAttribute(field.C, 1));
    g.setAttribute('aP', new THREE.BufferAttribute(field.P, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 9);
    geoms.push(g);
    return g;
  };
  const lineIdx = [], triIdx = [];
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX - 1; i++) {
    const a = j * NX + i; lineIdx.push(a, a + 1);
    if (j < NZ - 1) triIdx.push(a, a + NX, a + 1, a + 1, a + NX, a + NX + 1);
  }
  const lines = attrs(new THREE.BufferGeometry()); lines.setIndex(lineIdx);
  const sheet = attrs(new THREE.BufferGeometry()); sheet.setIndex(triIdx);

  U = {
    uTime: {value: 0}, uCarpet: {value: 0}, uPeak: {value: 0},
    uNoise: {value: 1}, uGlow: {value: .3}, uSweep: {value: -9}, uSweepOn: {value: 0},
    uHover: {value: new THREE.Vector4(9, 9, 9, 9)},
    uCool: {value: new THREE.Color(PAL.cool)}, uWarm: {value: new THREE.Color(PAL.warm)},
    uPeakC: {value: new THREE.Color(PAL.peak)}, uBg: {value: new THREE.Color(PAL.bg)},
  };
  const vert = `
    attribute float aC; attribute float aP;
    uniform float uTime, uCarpet, uPeak, uNoise;
    varying float vHeat; varying vec3 vP;
    void main(){
      vec3 p = position;
      float n = sin(p.x*1.3+uTime*.55)*sin(p.z*1.9-uTime*.4) + .5*sin(p.x*3.1-uTime*.75+p.z*2.2);
      float hP = aP*uPeak;
      p.y = aC*uCarpet + hP + n*uNoise*.075;
      vHeat = smoothstep(0.02, 1., hP/${PEAK.toFixed(2)});
      vP = p;
      gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.);
    }`;
  const ramp = `
    vec3 ramp(float h){ vec3 c = mix(uCool, uWarm, smoothstep(0.,.5,h)); return mix(c, uPeakC, smoothstep(.5,1.,h)); }`;
  const lineMat = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: vert, transparent: true, depthWrite: false,
    fragmentShader: `
      uniform vec3 uCool, uWarm, uPeakC; uniform float uGlow, uSweep, uSweepOn; uniform vec4 uHover;
      varying float vHeat; varying vec3 vP; ${ramp}
      void main(){
        float sweep = exp(-pow((vP.x-uSweep)/.32,2.))*uSweepOn;
        float hov = step(uHover.x,vP.x)*step(vP.x,uHover.y)*step(uHover.z,vP.z)*step(vP.z,uHover.w);
        float far = mix(.45,1., smoothstep(-${(D / 2).toFixed(1)}, ${(D / 2).toFixed(1)}, vP.z));
        float a = uGlow*(.5+.9*vHeat)*far + sweep*.32 + hov*.6;
        gl_FragColor = vec4(ramp(vHeat)*(1.+vHeat*1.35+sweep*.25+hov), clamp(a,0.,1.));
      }`,
  });
  const sheetMat = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: vert, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1.5, polygonOffsetUnits: 2,
    fragmentShader: `
      uniform vec3 uBg, uCool, uWarm, uPeakC; varying float vHeat; varying vec3 vP; ${ramp}
      void main(){ gl_FragColor = vec4(uBg*1.2 + ramp(vHeat)*vHeat*.14 + uCool*vP.y*.006, 1.); }`,
  });
  scene.add(new THREE.Mesh(sheet, sheetMat), new THREE.LineSegments(lines, lineMat));

  // floor axes: front edge = time between posts, right edge = wording difference
  const ax = [], x0 = X(0), x1 = X(L), z0 = Z(0) + .2, zb = Z(M), xl = x0 - .2;
  ax.push(x0, 0, z0, x1, 0, z0, xl, 0, Z(0), xl, 0, zb);
  for (let i = 0; i <= 10; i++) { const x = X(i / 10 * L); ax.push(x, 0, z0, x, 0, z0 + (i % 5 ? .1 : .22)); }
  for (let i = 0; i <= 5; i++) { const z = Z(i / 5 * M); ax.push(xl, 0, z, xl - (i % 5 ? .1 : .22), 0, z); }
  const axGeo = new THREE.BufferGeometry(); axGeo.setAttribute('position', new THREE.Float32BufferAttribute(ax, 3));
  axisMat = new THREE.LineBasicMaterial({color: PAL.cool, transparent: true, opacity: 0});
  scene.add(new THREE.LineSegments(axGeo, axisMat));

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), .38, .6, .18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}

/* camera: spherical around a target; named states double as the annotation plan */
const CAMS = {
  home:   {az: -.34, pol: 1.38, r: 10.5, tx: 0,    ty: 1.5, tz: 0,   off: 0},
  scan:   {az: -.46, pol: 1.22, r: 15.2, tx: 0,    ty: 1.7, tz: 0,   off: 1},
  over:   {az: -.48, pol: 1.04, r: 18.2, tx: -.3,  ty: .55, tz: 0,   off: 1},
  peak:   {az: -.92, pol: 1.18, r: 10.6, tx: -3.0, ty: 1.2, tz: 1.5, off: 1},
  carpet: {az: -.14, pol: .98,  r: 16.5, tx: .4,   ty: .2,  tz: -.5, off: 1},
  top:    {az: -.18, pol: .42,  r: 17.5, tx: -.25, ty: 0,   tz: 0,   off: 1},
};
const cam = {...CAMS.home};
const camTo = (name, duration = 1.25, ease = 'power3.inOut') =>
  gsap.to(cam, {...CAMS[name], duration: reduced ? 0 : duration, ease, overwrite: true});
let dragging = false;

function resize() {
  if (!ok) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h);
  camera.aspect = w / h;
}
function frame(t) {
  requestAnimationFrame(frame);
  const w = stage.clientWidth, h = stage.clientHeight, wide = w > 860;
  U.uTime.value = reduced ? 0 : t / 1000;
  const sway = reduced || dragging ? 0 : Math.sin(t / 5200) * .045;
  const az = cam.az + sway, sp = Math.sin(cam.pol);
  const r = cam.r * (wide ? 1 : Math.min(2.15, Math.max(1, 1.38 / Math.max(.5, camera.aspect))));
  camera.position.set(cam.tx + r * sp * Math.sin(az), cam.ty + r * Math.cos(cam.pol), cam.tz + r * sp * Math.cos(az));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
  if (wide) camera.setViewOffset(w, h, 0, -h * .055 * cam.off, w, h);
  else camera.setViewOffset(w, h, 0, -h * .02 * cam.off, w, h);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  composer.render();
  placeAxes(w, h);
}

/* axis labels live in the DOM, projected from the floor */
const AXES = [
  {t: '0s', p: [X(0), 0, Z(0) + .7], a: 'c'},
  {t: 'Time between posts', p: [X(L / 2), 0, Z(0) + 1.05], a: 'c', title: 1},
  {t: '10m', p: [X(L), 0, Z(0) + .7], a: 'c'},
  {t: 'same words', p: [X(0) - .75, 0, Z(0)], a: 'r'},
  {t: 'Wording gap', p: [X(0) - 1, 0, Z(M / 2)], a: 'r', title: 1},
  {t: 'unrelated', p: [X(0) - .75, 0, Z(M)], a: 'r'},
].map(d => { const el = document.createElement('span'); el.textContent = d.t; if (d.title) el.className = 't'; $('axes').append(el); return {...d, el, v: new THREE.Vector3()}; });
function placeAxes(w, h) {
  for (const d of AXES) {
    d.v.set(...d.p).project(camera);
    const x = (d.v.x * .5 + .5) * w, y = (-d.v.y * .5 + .5) * h;
    d.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(${d.a === 'c' ? '-50%' : d.a === 'r' ? '-100%' : '0'},-50%)`;
  }
}

/* hover: march the pointer ray against the CPU copy of the height field */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), tip = $('tip');
const heightAt = (x, z) => {
  const i = Math.round((x + W / 2) / W * (NX - 1)), j = Math.round((D / 2 - z) / D * (NZ - 1));
  if (i < 0 || j < 0 || i >= NX || j >= NZ) return -1;
  return field.C[j * NX + i] * U.uCarpet.value + field.P[j * NX + i] * U.uPeak.value;
};
const fmtLag = s => s < 60 ? `${s}s` : `${s / 60}m`.replace('.5', '½');
function hover(e) {
  const amb = S.list[S.sel]?.ambiguity;
  if (root.dataset.stage !== 'result' || dragging || !amb) return hideTip();
  const b = canvas.getBoundingClientRect();
  ndc.set((e.clientX - b.left) / b.width * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction; let hit = null;
  for (let s = 2; s < 40; s += .06) {
    const x = o.x + d.x * s, y = o.y + d.y * s, z = o.z + d.z * s, h = heightAt(x, z);
    if (h >= 0 && y <= h + .02) { hit = [x, z]; break; }
    if (y < -.2) break;
  }
  if (!hit) return hideTip();
  const l = Math.floor(binU(hit[0])), m = Math.floor(binV(hit[1]));
  if (l < 0 || m < 0 || l >= amb.lag_edges_sec.length - 1 || m >= amb.mismatch_edges.length - 1) return hideTip();
  const mine = amb.counts[m]?.[l] ?? 0, others = amb.background?.[m]?.[l] ?? 0;
  U.uHover.value.set(X(l), X(l + 1), Z(m + 1), Z(m));
  tip.innerHTML = `<b>${fmtLag(amb.lag_edges_sec[l])}–${fmtLag(amb.lag_edges_sec[l + 1])} lag, ${Math.round(amb.mismatch_edges[m] * 100)}–${Math.round(amb.mismatch_edges[m + 1] * 100)}% gap</b>
    <span>${mine} group, ${others} background</span>`;
  const x = e.clientX - b.left, y = e.clientY - b.top;
  tip.style.transform = `translate(${Math.min(Math.max(8, x + 14), b.width - 256)}px,${Math.max(8, y - 66)}px)`;
  tip.style.opacity = 1;
}
function hideTip() { tip.style.opacity = 0; if (U) U.uHover.value.set(9, 9, 9, 9); }

canvas.addEventListener('pointermove', e => {
  if (dragging) {
    cam.az -= e.movementX * .005;
    cam.pol = Math.min(1.45, Math.max(.3, cam.pol - e.movementY * .004));
  } else if (e.pointerType === 'mouse') hover(e);
});
canvas.addEventListener('pointerdown', e => {
  if (root.dataset.stage !== 'result' || !ok) return;
  if (e.pointerType !== 'mouse') hover(e);
  gsap.killTweensOf(cam); dragging = true; canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId);
  setLegend(null);
});
const endDrag = () => { dragging = false; canvas.classList.remove('dragging'); };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', hideTip);

/* ------------------------------------------------------------------ pipeline animation */
function topicStats() {
  const items = new Set(), accounts = new Set();
  for (const f of S.list) { f.item_ids.forEach(i => items.add(i)); f.accounts.forEach(a => accounts.add(a)); }
  const f = S.list[0];
  return {posts: items.size, accounts: accounts.size, pairs: sum(f?.ambiguity?.counts) + sum(f?.ambiguity?.background), f};
}
const PHASES = [
  {title: 'Collecting posts', fact: (n, s) => `${Math.round(n * s.posts)} posts in groups from ${Math.round(n * s.accounts)} accounts (${WINDOW_HOURS}h)`, dur: 1.4},
  {title: 'Comparing meaning', fact: (n, s) => `${s.posts} posts embedded`, dur: 1.1},
  {title: 'Aligning timing', fact: (n, s) => `${Math.round(n * s.pairs)} post pairs`, dur: 1.4},
  {title: 'Estimating noise', fact: () => `False alarm target ≤ ${pct(Math.max(alpha(), DESIGN_ALPHA))}`, dur: 1.1},
  {title: 'Deciding', fact: (n, s) => s.f?.decided_at_item != null ? `Decided at post ${s.f.decided_at_item + 1}` : s.f ? 'Still collecting evidence' : 'No groups flagged', dur: 1.4},
];
const dots = [...document.querySelectorAll('#pipeTrack li')];
let tl = null, selTl = null;

function setPhase(i, s) {
  $('pipeTitle').textContent = PHASES[i].title;
  $('pipeFact').textContent = PHASES[i].fact(i === 0 || i === 2 ? 0 : 1, s);
  dots.forEach((d, k) => { d.classList.toggle('done', k < i); d.classList.toggle('on', k === i); });
}

function openTopic(topic, {instant = false, findingId = null} = {}) {
  S.topic = topic; S.list = topicFindings(topic);
  S.sel = Math.max(0, S.list.findIndex(f => f.id === findingId));
  $('injectMsg').textContent = '';
  history.replaceState(null, '', `?q=${encodeURIComponent(topic)}`);
  tl?.kill(); selTl?.kill();
  root.dataset.stage = 'scan'; scrollTo(0, 0); hideTip();
  $('q').value = topic; $('q').blur(); syncClear();
  if (!ok) return showResult(true);
  gsap.killTweensOf([U.uCarpet, U.uPeak, U.uNoise, U.uGlow, U.uSweep, U.uSweepOn, axisMat, cam]);
  U.uCarpet.value = 0; U.uPeak.value = 0; axisMat.opacity = 0;
  setField(S.list[S.sel]);
  const s = topicStats();
  gsap.set('#pipe', {autoAlpha: 0}); gsap.set('#pipeBar', {scaleX: 0}); gsap.set('#axes', {opacity: 0});
  const now = $('pipeNow');
  tl = gsap.timeline({defaults: {ease: 'power3.out'}, onComplete: () => showResult(instant)});
  tl.to('#pipe', {autoAlpha: 1, duration: .45}, .25);
  tl.add(camTo('scan', 2.0), 0).to(U.uGlow, {value: .55, duration: 1}, 0);
  let at = .4;
  PHASES.forEach((p, i) => {
    const lab = 'p' + i; tl.addLabel(lab, at);
    if (i) tl.to(now, {autoAlpha: 0, y: -8, duration: .16, ease: 'power2.in'}, lab + '-=.16');
    tl.call(setPhase, [i, s], lab)
      .fromTo(now, {autoAlpha: 0, y: 10}, {autoAlpha: 1, y: 0, duration: .4}, lab)
      .to('#pipeBar', {scaleX: i / (PHASES.length - 1), duration: .45, ease: 'power2.inOut'}, lab + '-=.25');
    if (i === 0 || i === 2) {
      const n = {v: 0};
      tl.to(n, {v: 1, duration: p.dur * .75, ease: 'power2.out', onUpdate: () => { $('pipeFact').textContent = p.fact(n.v, s); }}, lab);
    }
    at += p.dur;
  });
  tl.set(U.uSweepOn, {value: 1}, 'p0')
    .fromTo(U.uSweep, {value: -W / 2 - 1.5}, {value: W / 2 + 1.5, duration: 1.3, ease: 'power1.inOut'}, 'p0')
    .fromTo(U.uSweep, {value: W / 2 + 1.5}, {value: -W / 2 - 1.5, duration: 1.0, ease: 'power1.inOut'}, 'p1')
    .set(U.uSweepOn, {value: 0}, 'p2')
    .to(U.uCarpet, {value: 1, duration: 1.3, ease: 'power2.out'}, 'p2')
    .to(U.uNoise, {value: .12, duration: 1.0, ease: 'power2.inOut'}, 'p3')
    .to(U.uGlow, {value: .82, duration: 1.0}, 'p3')
    .add(camTo('over', 1.8, 'power2.inOut'), 'p4-=.3')
    .to(U.uPeak, {value: 1, duration: 1.2, ease: 'expo.out'}, 'p4+=.3')
    .fromTo(bloom, {strength: 1.0}, {strength: .38, duration: 1.3, ease: 'power2.out'}, 'p4+=.3')
    .call(() => dots.forEach(d => { d.classList.add('done'); d.classList.remove('on'); }), [], '>-0.3');
  if (instant || reduced) tl.progress(1);
}
function showResult(instant) {
  render();
  root.dataset.stage = 'result';
  resize();
  const d = reduced || instant ? 0 : 1;
  gsap.to('#pipe', {autoAlpha: 0, duration: .25 * d});
  gsap.fromTo('#vTitle', {autoAlpha: 0, y: 14}, {autoAlpha: 1, y: 0, duration: .45 * d, ease: 'power3.out'});
  gsap.fromTo('#vText,#vRisk', {autoAlpha: 0, y: 8}, {autoAlpha: 1, y: 0, duration: .4 * d, delay: .06 * d, ease: 'power3.out'});
  gsap.fromTo('#groups', {autoAlpha: 0, y: 6}, {autoAlpha: 1, y: 0, duration: .38 * d, delay: .11 * d, ease: 'power3.out'});
  gsap.fromTo('#legend', {autoAlpha: 0, y: 8}, {autoAlpha: 1, y: 0, duration: .45 * d, delay: .18 * d, ease: 'power3.out'});
  if (!ok) return;
  gsap.to('#axes', {opacity: 1, duration: .55 * d, delay: .2 * d});
  gsap.to(axisMat, {opacity: .42, duration: .55 * d, delay: .2 * d});
}
function goHome() {
  tl?.kill(); selTl?.kill();
  gsap.killTweensOf('#pipe,#pipeNow,#vTitle,#vText,#vRisk,#groups,#legend,#axes');
  S.topic = null; history.replaceState(null, '', location.pathname);
  root.dataset.stage = 'home'; scrollTo(0, 0);
  $('q').value = ''; syncClear(); $('q').focus();
  renderHome();
  if (!ok) return;
  const d = reduced ? 0 : 1;
  gsap.to('#pipe', {autoAlpha: 0, duration: .22 * d});
  gsap.to([U.uCarpet, U.uPeak], {value: 0, duration: .85 * d, ease: 'power3.inOut', overwrite: true});
  gsap.to(U.uNoise, {value: 1, duration: .85 * d, overwrite: true});
  gsap.to(U.uGlow, {value: .3, duration: .85 * d, overwrite: true});
  gsap.to(axisMat, {opacity: 0, duration: .25 * d, overwrite: true});
  gsap.set(U.uSweepOn, {value: 0}); bloom.strength = .38;
  camTo('home', 1.1); setLegend(null); hideTip(); resize();
}

/* ------------------------------------------------------------------ result copy */
const VERDICT = {
  coordinated: {title: 'Coordinated', light: '🔴'},
  watching: {title: 'Watching', light: '🟡'},
  organic: {title: 'Organic', light: '🟢'},
};

function render() {
  const f = S.list[S.sel];
  const vt = $('vTitle');
  $('groups').innerHTML = S.list.map((g, k) =>
    `<button type="button" aria-pressed="${k === S.sel}" data-g="${k}">${VERDICT[g.verdict].light} ${g.accounts.length} accounts · ${g.verdict}${g.synthetic ? ' · test' : ''}</button>`).join('');
  $('legend').style.display = f ? '' : 'none';
  if (!f) {
    vt.dataset.v = 'organic'; vt.textContent = 'Quiet';
    $('vText').textContent = `No groups of look-alike accounts in the last ${WINDOW_HOURS} h of ${S.topic}.`;
    $('vRisk').innerHTML = `🟢 Nothing above the detector threshold. <small>${pfaText()}</small>`;
    for (const id of ['evSay', 'evWho', 'evPosts', 'evCorr', 'evDecision', 'evSignal']) $(id).innerHTML = '';
    $('evSay').innerHTML = `<h3>Nothing to show</h3><p>Try “Inject test campaign” to see what a swarm looks like.</p>`;
    return;
  }
  const hit = f.verdict === 'coordinated', n = f.accounts.length;
  vt.dataset.v = f.verdict; vt.textContent = VERDICT[f.verdict].title;
  $('vText').textContent = hit && f.explanation?.summary ? f.explanation.summary
    : hit ? `${n} accounts posted near-identical messages close together in time.`
    : f.verdict === 'watching' ? `${n} accounts look alike, but the evidence is not strong enough yet.`
    : `${n} accounts: similar topic, but no coordination signal.`;
  const snr = f.snr_db_single != null ? `SNR ${f.snr_db_single.toFixed(1)} → ${f.snr_db.toFixed(1)} dB` : `SNR ${f.snr_db.toFixed(1)} dB`;
  $('vRisk').innerHTML = (hit
    ? `🔴 ${n} accounts are saying the same thing almost simultaneously.`
    : f.verdict === 'watching'
      ? '🟡 Keep watching — not sure yet.'
      : '🟢 Looks organic.') +
    ` <small>${pfaText()} · ${snr}</small>`;
  const pairs = sum(f.ambiguity?.counts);
  $('lgSpike').textContent = hit ? `${pairs} pairs of this group, close in time and wording` : `${pairs} pairs of this group`;
  $('lgCarpet').textContent = `${sum(f.ambiguity?.background)} other pairs in the topic across 10m`;

  const x = f.explanation;
  $('evSay').innerHTML = (x
    ? `<h3>Technique</h3><blockquote>“${esc(x.quote)}”</blockquote><p>${esc(x.technique)}, ${Math.round(x.confidence * 100)}% confidence</p>`
    : `<h3>Technique</h3><p>${hit ? 'Explanation is being generated.' : 'Only coordinated groups get an explanation.'}</p>`) +
    (f.note ? `<p class="note">${esc(f.note)}</p>` : '');
  $('evWho').innerHTML = `<h3>Accounts</h3><ul class="who">${f.accounts.map(a => `<li>${esc(handle(a))}</li>`).join('')}</ul>
    <p>${f.item_ids.length} posts, ${hm(f.first_seen)}–${hm(f.last_seen)} UTC${f.synthetic ? ' · injected test campaign' : ''}</p>`;
  renderPosts(f);
  $('evCorr').innerHTML = corrGrid(f);
  $('evDecision').innerHTML = `<h3>Sequential test (SPRT)</h3>${trace(f)}<p>${f.decided_at_item != null
    ? `Crossed the ${f.verdict === 'coordinated' ? 'upper' : 'lower'} threshold at post ${f.decided_at_item + 1}.`
    : f.note && f.sprt_trace.length && f.sprt_trace.at(-1) >= f.sprt_upper
      ? `Crossed the upper threshold after ${f.sprt_trace.length} posts, but downgraded to watching (news echo).`
      : `Between thresholds after ${f.sprt_trace.length} posts.`}</p>`;
  const mx = Math.max(f.snr_db, f.snr_db_single ?? 0, 1);
  $('evSignal').innerHTML = `<h3>Signal-to-noise</h3><div class="bars">
      ${f.snr_db_single != null ? `<div><span>One pair</span><i style="width:${Math.max(0, f.snr_db_single) / mx * 100}%"></i><span>${f.snr_db_single.toFixed(1)} dB</span></div>` : ''}
      <div><span>Group (${n})</span><i style="width:${Math.max(0, f.snr_db) / mx * 100}%"></i><span>${f.snr_db.toFixed(1)} dB</span></div></div>
      <p>Combining all account pairs coherently lifts the swarm above the noise.</p>`;
}

async function renderPosts(f) {
  const want = f.item_ids.filter(i => !S.items.has(i)).slice(0, 200);
  if (want.length) {
    $('evPosts').innerHTML = '<h3>Posts</h3><p>Loading…</p>';
    try { for (const it of await api(`/api/items?ids=${want.map(encodeURIComponent).join(',')}`)) S.items.set(it.id, it); }
    catch (e) { if (S.list[S.sel] === f) $('evPosts').innerHTML = `<h3>Posts</h3><p>Could not load posts (${esc(e.message)}).</p>`; return; }
  }
  if (S.list[S.sel] !== f) return;                       // the user moved on meanwhile
  const its = f.item_ids.map(i => S.items.get(i)).filter(Boolean).sort((a, b) => a.published_at.localeCompare(b.published_at));
  const shown = its.slice(0, 8);
  $('evPosts').innerHTML = `<h3>Posts</h3><ul class="posts">${shown.map(it => `<li><span class="meta">${esc(handle(it.author))} · ${hm(it.published_at)} UTC${it.platform ? ' · ' + esc(it.platform) : ''}${it.synthetic ? '<span class="syn">test</span>' : ''}</span>${esc(it.text)}${/^https?:\/\//i.test(it.url ?? '') ? ` <a href="${esc(it.url)}" target="_blank" rel="noopener">source</a>` : ''}</li>`).join('')}</ul>
    <p>${shown.length < its.length ? `First ${shown.length} of ${its.length} posts.` : `${its.length} posts.`}</p>`;
}

function corrGrid(f) {
  const n = f.accounts.length;
  if (!n) return '';
  const cells = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = Math.max(0, Math.min(1, f.correlation[i][j])), lag = f.lag_sec?.[i]?.[j];
    const t = `${handle(f.accounts[i])} ↔ ${handle(f.accounts[j])}: ${v.toFixed(2)}${lag != null && i !== j ? `, lag ${Math.round(lag)} s` : ''}`;
    cells.push(`<div style="--v:${(.06 + .94 * v).toFixed(2)}" title="${esc(t)}" aria-label="${esc(t)}"></div>`);
  }
  return `<h3>Account correlation</h3><div class="corr" style="grid-template-columns:repeat(${n},minmax(0,1fr));max-width:${Math.min(420, n * 44)}px">${cells.join('')}</div>
    <p class="corr-pick" aria-live="polite"></p>
    <p>Brighter = posts of the two accounts match closer in time and meaning. Hover or tap a cell for the value and lag.</p>`;
}

function trace(f) {
  const w = 480, h = 156, pl = 6, pr = 96, t = f.sprt_trace;
  const lo = Math.min(f.sprt_lower, ...t) - .6, hi = Math.max(f.sprt_upper, ...t) + .9;
  const x = k => pl + k / Math.max(1, t.length - 1) * (w - pl - pr), y = v => h - (v - lo) / (hi - lo) * h;
  const pts = t.map((v, k) => `${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(' '), hit = f.verdict === 'coordinated';
  const rule = (v, label) => `<line x1="0" x2="${w - pr + 8}" y1="${y(v)}" y2="${y(v)}" stroke="${PAL.cool}" stroke-opacity=".32" stroke-dasharray="3 5"/>
    <text x="${w - pr + 14}" y="${y(v) + 4}" fill="${PAL.muted}" font-size="12">${label} ${v.toFixed(2)}</text>`;
  const dots = t.map((v, k) => `<circle cx="${x(k).toFixed(1)}" cy="${y(v).toFixed(1)}" r="9" fill="transparent"><title>post ${k + 1}: LLR ${v.toFixed(2)}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Evidence (log-likelihood ratio) after each post">
    ${rule(f.sprt_upper, 'coordinated')}${rule(f.sprt_lower, 'organic')}
    ${t.length ? `<polyline points="${pts}" fill="none" stroke="${hit ? PAL.warm : PAL.cool}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(t.length - 1)}" cy="${y(t.at(-1))}" r="4.5" fill="${hit ? PAL.peak : PAL.cool}"/>` : ''}${dots}</svg>`;
}

function select(i, instant) {
  if (i === S.sel) return;
  S.sel = i; hideTip(); selTl?.kill();
  const d = reduced || instant ? 0 : 1;
  selTl = gsap.timeline().to('#vTitle,#vText,#vRisk', {autoAlpha: 0, duration: .14 * d}).call(render).to('#vTitle,#vText,#vRisk', {autoAlpha: 1, duration: .26 * d});
  if (!ok) return;
  gsap.timeline()
    .to([U.uPeak, U.uCarpet], {value: 0, duration: .25 * d, overwrite: true})
    .call(() => setField(S.list[S.sel]))
    .to([U.uPeak, U.uCarpet], {value: 1, duration: .7 * d, ease: 'power2.out'});
  setLegend(null); camTo('over', 1.3 * d);
}
function setLegend(btn) {
  document.querySelectorAll('#legend .lg-btn').forEach(b => b.setAttribute('aria-pressed', b === btn));
}
function syncClear() { $('clear').classList.toggle('visible', $('q').value.length > 0); }

/* ------------------------------------------------------------------ home: topics + feed */
function renderHome() {
  const count = t => S.findings.filter(f => f.topic === t && f.verdict === 'coordinated').length;
  $('samples').innerHTML = S.topics.map(t =>
    `<button class="sample-chip" type="button" data-sample="${esc(t)}">${esc(t)}${count(t) ? `<b>${count(t)}</b>` : ''}</button>`).join('');
  $('topicList').innerHTML = S.topics.map(t => `<option value="${esc(t)}">`).join('');
  const feed = S.findings.filter(f => f.verdict !== 'organic' && S.topics.includes(f.topic))
    .sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || b.created_at.localeCompare(a.created_at)).slice(0, 6);
  $('feed').innerHTML = feed.length ? feed.map(f =>
    `<li><button type="button" data-topic="${esc(f.topic)}" data-fid="${esc(f.id)}"><span>${VERDICT[f.verdict].light} ${VERDICT[f.verdict].title}</span>
      <span>${esc(f.topic)} · ${f.accounts.length} accounts${f.synthetic ? ' · test' : ''}</span><span class="t">${ago(f.created_at)}</span></button></li>`).join('')
    : '<li class="empty">No alerts in the current window.</li>';
}

function renderStatus() {
  const el = $('updated');
  el.innerHTML = S.lastPoll
    ? `<span class="live${Date.now() - Date.parse(S.lastPoll) > 15 * 60000 ? ' stale' : ''}"></span>updated ${ago(S.lastPoll)}`
    : '<span class="live stale"></span>no live ingest yet';
}

/* ------------------------------------------------------------------ data */
async function refresh() {
  try {
    const r = await api('/api/alerts');
    S.findings = r.findings; S.lastPoll = r.last_poll_at;
  } catch (e) { console.warn('alerts', e); return; }
  renderStatus();
  if (root.dataset.stage === 'home') renderHome();
  else if (S.topic && root.dataset.stage === 'result') {
    const cur = S.list[S.sel]?.id, next = topicFindings(S.topic);
    const sig = l => l.map(f => `${f.id}:${f.verdict}:${f.item_ids.length}:${f.explanation ? 1 : 0}`).join();
    if (sig(next) !== sig(S.list)) {
      S.list = next; S.sel = Math.max(0, next.findIndex(f => f.id === cur));
      if (ok) setField(S.list[S.sel]);
      render();
    }
  }
}

async function inject() {
  const topic = S.topic, btn = $('inject'), msg = $('injectMsg'), t0 = Date.now();
  btn.disabled = true; msg.textContent = 'Injecting…';
  try {
    await refresh();                                      // findings already there are not the new swarm
    const seen = new Set(S.findings.filter(f => f.topic === topic && f.synthetic).map(f => f.id));
    const r = await api('/api/inject', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({topic})});
    msg.textContent = `Injected ${r.n_items} synthetic posts. Waiting for the detector…`;
    while (Date.now() - t0 < INJECT_TIMEOUT_MS && S.topic === topic) {
      await new Promise(res => setTimeout(res, INJECT_POLL_MS));
      await refresh();
      const f = S.list.find(f => f.synthetic && f.verdict === 'coordinated' && !seen.has(f.id));
      if (f) {
        msg.textContent = `Swarm detected in ${Math.round((Date.now() - t0) / 1000)} s.`;
        const i = S.list.indexOf(f);
        if (i !== S.sel) { S.sel = -1; select(i); } else render();
        return;
      }
    }
    if (S.topic === topic) msg.textContent = 'No detection yet — the worker may be busy; the feed keeps updating.';
  } catch (e) {
    msg.textContent = e.message.startsWith('no variations') ? 'No test campaign prepared for this topic yet.' : `Inject failed: ${e.message}`;
  } finally { btn.disabled = false; }
}

/* ------------------------------------------------------------------ wiring */
$('q').addEventListener('input', syncClear);
$('search').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  const t = S.topics.find(t => t === q) ?? S.topics.find(t => t.includes(q.toLowerCase().replace(/\s+/g, '-')));
  if (t) openTopic(t); else { $('q').value = ''; $('q').placeholder = `Not monitored: ${q}`; syncClear(); }
});
$('samples').addEventListener('click', e => { const b = e.target.closest('[data-sample]'); if (b) openTopic(b.dataset.sample); });
$('feed').addEventListener('click', e => { const b = e.target.closest('[data-topic]'); if (b) openTopic(b.dataset.topic, {findingId: b.dataset.fid}); });
$('clear').addEventListener('click', () => {
  if (root.dataset.stage === 'home') { $('q').value = ''; syncClear(); $('q').focus(); }
  else goHome();
});
$('brandBtn').addEventListener('click', () => { if (root.dataset.stage !== 'home') goHome(); });
$('resetCam').addEventListener('click', () => { setLegend(null); camTo('over', 1.0); });
addEventListener('keydown', e => { if (e.key === 'Escape' && root.dataset.stage !== 'home') goHome(); });
$('groups').addEventListener('click', e => { const b = e.target.closest('button'); if (b) select(+b.dataset.g); });
$('legend').addEventListener('click', e => {
  const b = e.target.closest('.lg-btn'); if (!b || !ok) return;
  const on = b.getAttribute('aria-pressed') === 'true';
  setLegend(on ? null : b); camTo(on ? 'over' : b.dataset.cam);
});
$('inject').addEventListener('click', inject);
for (const ev of ['click', 'pointerover']) $('evCorr').addEventListener(ev, e => {
  const c = e.target.closest('.corr div'), out = $('evCorr').querySelector('.corr-pick');
  if (c && out) out.textContent = c.getAttribute('aria-label');
});
for (const [tab, panel] of [['tabMain', 'panelMain'], ['tabDetails', 'panelDetails']])
  $(tab).addEventListener('click', () => {
    for (const [t2, p2] of [['tabMain', 'panelMain'], ['tabDetails', 'panelDetails']]) {
      $(t2).setAttribute('aria-selected', t2 === tab); $(p2).hidden = p2 !== panel;
    }
  });

try { buildScene(); } catch (err) { ok = false; console.error(err); canvas.style.display = 'none'; }
if (ok) { new ResizeObserver(resize).observe(stage); resize(); requestAnimationFrame(frame); }

(async () => {
  const [topics, metrics] = await Promise.allSettled([api('/api/topics'), api('/api/metrics')]);
  S.topics = topics.value ?? [];
  S.metrics = metrics.value ?? null;
  await refresh();
  renderHome();
  const q = new URLSearchParams(location.search).get('q');
  if (q && S.topics.includes(q)) openTopic(q, {instant: true});
  setInterval(refresh, POLL_MS);
  setInterval(renderStatus, 30000);
})();
