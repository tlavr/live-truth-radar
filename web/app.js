// Live Swarm Radar dashboard (T12). Scene and motion from the frontend reference
// (docs/frontend-reference on p2/frontend-reference); data from /api/* (T8).
import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {topicLabel, platformLabel} from './labels.js';

const POLL_MS = 15000;
const LIVE_MS = 2500;              // T12d: Check starts a live scan of the topic; frames + findings every 2.5 s
const WINDOW_HOURS = 6;            // DETECT_WINDOW_HOURS on the worker
const DESIGN_ALPHA = 0.02;         // SPRT alpha of the findings table (T12c default point)
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
    throw Object.assign(new Error(detail), {status: r.status});
  }
  return r.json();
}

/* ------------------------------------------------------------------ state */
const S = {
  topics: [], findings: [], lastPoll: null, metrics: null, points: null, served: null, alpha: DESIGN_ALPHA,
  topic: null, list: [], sel: 0, items: new Map(),
  live: null,  // T12d live scan: {topic, session, since, frame, timer, busy, error}
  pickedWeak: false,               // T12d: a group below the alert threshold is shown only if the user picked it
  tmap: null, mapBusy: false,      // time x meaning map of the topic (/api/timemap), one layer per group
  mapAt: null, view: 0,            // mapAt: null = live, else the ISO moment the map is rewound to;
                                   // view: bins between the end of the fetched map and the origin on screen
};
// T12c: the false-alarm slider picks an SPRT alpha; /api/alerts?alpha= serves the findings at that point
const SLIDER_ALPHAS = [0.005, 0.01, 0.02, 0.05, 0.1];  // fallback until eval/operating_points.json exists
const alpha = () => S.alpha;
const point = () => S.points?.points?.find(p => Math.abs(p.alpha - S.alpha) < 1e-9);
// design alpha of the chosen point + the Pfa measured for it by make eval (with its 95% upper bound)
const pfaText = () => {
  const p = point();
  return p
    ? `False alarm target: ${pct(S.alpha)} (measured ${pct(p.pfa)}, ≤ ${pct(p.pfa_upper95)} at 95%)`
    : `False alarm target: ${pct(S.alpha)}`;
};
// alerts first, then in time order: a group is one wave of posts, so the drop-down reads top to bottom in time
const topicFindings = t => S.findings.filter(f => f.topic === t)
  .sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || a.first_seen.localeCompare(b.first_seen) || a.id.localeCompare(b.id));
const span = f => hm(f.first_seen) === hm(f.last_seen) ? hm(f.first_seen) : `${hm(f.first_seen)}–${hm(f.last_seen)}`;

// the group the result view shows: an alert (coordinated), or a weaker group only if the user opened it
const shown = () => { const f = S.list[S.sel]; return f && (f.verdict === 'coordinated' || S.pickedWeak) ? f : null; };
const SIM = 'simulated attack';

const PAL = {bg: '#0C100E', cool: '#63CF97', muted: '#A3B8AA', warm: '#B7F063', peak: '#FFE066', sel: '#FF5C9E'};

/* ------------------------------------------------------------------ scene */
// grid of the time x meaning map (detect/timemap.py): the last L time bins of 30 s (10 min), 20 meaning-gap
// bins of 0.05. Ordinary axes: the origin is "now" and meaning gap 0; time runs to the right into the past.
// Labels every LABEL_EVERY bins (2 min, 0.2); a small tick at every bin.
const M = 20, L = 20, BIN_MIN = .5, LABEL_EVERY = 4, MAP_MAX_AGE_MS = 20000;
const U0 = 0, U1 = L;  // the surface starts and ends exactly at the axes
const W = 10, D = 6, PEAK = 3.1, NX = 190, NZ = 56;
const V0 = 0, V1 = M;
const X = u => -W / 2 + (u - U0) / (U1 - U0) * W, Z = v => D / 2 - (v - V0) / (V1 - V0) * D;
const binU = x => (x + W / 2) / W * (U1 - U0) + U0, binV = z => (D / 2 - z) / D * (V1 - V0) + V0;
const canvas = $('scene'), stage = $('stage');
let renderer, composer, bloom, camera, scene, U, axisMat, axGeo, geoms = [], ok = true;
const field = {P: new Float32Array(NX * NZ), O: new Float32Array(NX * NZ), C: new Float32Array(NX * NZ)};

function smooth(grid, off = 0) {
  // su in time bins; off = column of the grid at the origin (fractional while the map scrolls)
  const out = new Float32Array(NX * NZ), su = .5, sv = .55, ru = Math.ceil(3 * su);
  if (!grid) return out;
  for (let j = 0; j < NZ; j++) {
    const v = V0 + j / (NZ - 1) * (V1 - V0);
    for (let i = 0; i < NX; i++) {
      const u = U0 + i / (NX - 1) * (U1 - U0) + off;
      let s = 0, w = 0;
      for (let m = Math.floor(v - 3); m <= Math.ceil(v + 3); m++)
        for (let l = Math.floor(u - ru); l <= Math.ceil(u + ru); l++) {
          const du = u - (l + .5), dv = v - (m + .5);
          const k = Math.exp(-du * du / (2 * su * su) - dv * dv / (2 * sv * sv));
          s += k * (grid[m]?.[l] ?? 0); w += k;
        }
      out[j * NX + i] = s / w;
    }
  }
  return out;
}

// The fetched map may be wider than the screen (it covers both ends of a scroll). Columns are kept newest
// first; S.view = the column at the origin, so screen column l is "l to l+1 bins before the origin".
const BIN_MS = BIN_MIN * 60000;
const rev = g => g.map(row => row.slice().reverse());
const originMs = () => Date.parse(S.tmap.now) - S.view * BIN_MS;
const nowText = () => S.tmap ? new Date(originMs()).toISOString().slice(11, 16) : 'now';
let full = {};
// all cells of the fetched map: the selected group, the other groups of the topic, everything else
function layersFull(f) {
  if (!S.tmap) return null;
  if (full.map === S.tmap && full.f === f && full.list === S.list) return full.val;
  const total = rev(S.tmap.total), zero = () => total.map(r => r.map(() => 0));
  const grid = id => S.tmap.groups?.[id] ? rev(S.tmap.groups[id]) : null;
  const sel = (f && grid(f.id)) || zero(), others = zero();
  for (const g of S.list) if (g !== f) grid(g.id)?.forEach((r, m) => r.forEach((v, l) => { others[m][l] += v; }));
  const rest = total.map((r, m) => r.map((v, l) => Math.max(0, v - sel[m][l] - others[m][l])));
  full = {map: S.tmap, f, list: S.list, val: {sel, others, rest}};
  return full.val;
}
// the L columns on screen, for the tooltip and the legend
function layers(f) {
  const y = layersFull(f); if (!y) return null;
  const a = Math.round(S.view), cut = g => g.map(r => Array.from({length: L}, (_, l) => r[a + l] ?? 0));
  return {sel: cut(y.sel), others: cut(y.others), rest: cut(y.rest)};
}

// Heights in dB above the mean level of all pairs on screen (the radar's noise floor): a point whose pairs
// (all layers, smoothed) total T stands 10*log10(T / mean) dB high, 0 at or below the mean. The layers split
// that height in proportion: the selected group (accent colour) on top of the other groups (they keep their
// colour), on top of the carpet of all other pairs. A click only moves the accent.
const sample = f => { const y = layersFull(f); return [smooth(y?.sel, S.view), smooth(y?.others, S.view), smooth(y?.rest, S.view)]; };
// Threshold: the CFAR rule of the detector (detect/config.py cfar_k = 3) applied to this surface, mean + 3
// sigma of all points on screen, in dB above the mean. It is a guide on the map's own scale: the detector
// itself thresholds pair correlations, not this density.
const CFAR_K = 3;
function dbField([P, O, C]) {
  const n = P.length, H = new Float32Array(n);
  let mean = 0, sq = 0, top = 0;
  for (let i = 0; i < n; i++) { const t = P[i] + O[i] + C[i]; mean += t; sq += t * t; }
  mean /= n;
  const sd = Math.sqrt(Math.max(0, sq / n - mean * mean)), thr = mean > 1e-9 ? 10 * Math.log10(1 + CFAR_K * sd / mean) : 0;
  if (mean > 1e-9) for (let i = 0; i < n; i++) {
    const t = P[i] + O[i] + C[i];
    H[i] = t > mean ? 10 * Math.log10(t / mean) : 0; top = Math.max(top, H[i]);
  }
  return {H, top: Math.max(top, thr), thr};
}
// the height axis has 5 steps; a step is a round number of dB that fits the highest point
const DB_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];
const dbStep = top => DB_STEPS.find(st => 5 * st >= top) ?? Math.ceil(top / 50) * 10;
const scaleOf = s => PEAK / (5 * dbStep(dbField(s).top));  // scene units per dB
// k: scene units per dB; by default the one that fits the view, a scroll passes its own so heights glide
function setField(f, k) {
  const s = sample(f), [P, O, C] = s, {H, top, thr} = dbField(s);
  k ??= PEAK / (5 * dbStep(top));
  let best = 0, at = -1;
  for (let i = 0; i < P.length; i++) {
    if (P[i] > best) { best = P[i]; at = i % NX; }
    const t = P[i] + O[i] + C[i], q = t > 0 ? H[i] * k / t : 0;
    field.P[i] = P[i] * q; field.O[i] = O[i] * q; field.C[i] = C[i] * q;
  }
  for (const g of geoms) for (const a of ['aP', 'aO', 'aC']) g.attributes[a].needsUpdate = true;
  CAMS.peak.tx = at < 0 ? -3 : Math.max(-3.4, Math.min(3.4, -W / 2 + at / (NX - 1) * W)) * .8;  // look at the selected wave
  setHeightLabels(k);
  S.thrDb = thr; S.thrY = thr > 0 ? thr * k : null;
  if (U) U.uThrY.value = S.thrY ?? 1e3;  // the surface turns red above it, with a dashed contour where it crosses
  if (axGeo && S.thrY !== axThrY) drawAxes();
  if (thrLabel) thrLabel.el.textContent = thr > 0 ? `detection threshold (mean + ${CFAR_K}σ) · ${thr.toFixed(1)} dB` : '';
}
let thrLabel = null, axThrY = null;

// Axes just outside the surface, on the edges that face the viewer: the time axis on the front or back
// edge, the meaning-gap axis on the left or right one, whichever edge's outward normal n has dot(n, view) > 0
// (view = from the scene to the camera). The height axis stands on the far corner of the meaning-gap edge.
// Ticks point outwards: a small one at every bin (30 s, 0.05), a raised post at every label (2 min, 0.2).
const TICK_H = .26, AX_OFF = .35, HEIGHT_TICKS = [0, .2, .4, .6, .8, 1];
const axSide = {x: -1, z: 1};  // x: -1 = meaning-gap axis on the left edge (gap 0 side), z: 1 = time axis on the front edge
const timeZ = sz => sz > 0 ? Z(0) + AX_OFF : Z(M) - AX_OFF;
const gapX = sx => sx < 0 ? X(0) - AX_OFF : X(L) + AX_OFF;
function drawAxes() {
  const sx = axSide.x, sz = axSide.z, ax = [], zt = timeZ(sz), xg = gapX(sx), zf = timeZ(-sz);
  ax.push(X(0), 0, zt, X(L), 0, zt, xg, 0, Z(0), xg, 0, Z(M));
  for (let l = 0; l <= L; l++) {
    const x = X(l), big = l % LABEL_EVERY === 0;
    ax.push(x, 0, zt, x, 0, zt + sz * (big ? .14 : .07));
    if (big) ax.push(x, 0, zt, x, TICK_H, zt);
  }
  for (let m = 0; m <= M; m++) {
    const z = Z(m), big = m % LABEL_EVERY === 0;
    ax.push(xg, 0, z, xg + sx * (big ? .14 : .07), 0, z);
    if (big) ax.push(xg, 0, z, xg, TICK_H, z);
  }
  ax.push(xg, 0, zf, xg, PEAK, zf);  // height axis
  for (const g of HEIGHT_TICKS) ax.push(xg, g * PEAK, zf, xg + sx * .14, g * PEAK, zf);
  axThrY = S.thrY ?? null;
  if (axThrY != null) ax.push(xg - sx * .22, axThrY, zf, xg + sx * .22, axThrY, zf);  // detection threshold
  axGeo.setAttribute('position', new THREE.Float32BufferAttribute(ax, 3));
  axGeo.boundingSphere = null;  // recomputed for frustum culling: the axes moved
}
// flip an axis only past a small margin, so it does not flicker when the view is edge-on
function faceAxes() {
  const vx = camera.position.x - cam.tx, vz = camera.position.z - cam.tz, n = Math.hypot(vx, vz) || 1;
  const sx = vx / n > .05 ? 1 : vx / n < -.05 ? -1 : axSide.x, sz = vz / n > .05 ? 1 : vz / n < -.05 ? -1 : axSide.z;
  if (sx === axSide.x && sz === axSide.z) return;
  axSide.x = sx; axSide.z = sz; drawAxes();
}

function buildScene() {
  renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: 'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(PAL.bg);
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100);  // parallel projection: proportions hold everywhere

  const pos = new Float32Array(NX * NZ * 3);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const o = (j * NX + i) * 3;
    pos[o] = -W / 2 + i / (NX - 1) * W; pos[o + 1] = 0; pos[o + 2] = D / 2 - j / (NZ - 1) * D;
  }
  const attrs = g => {
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aC', new THREE.BufferAttribute(field.C, 1));
    g.setAttribute('aP', new THREE.BufferAttribute(field.P, 1));
    g.setAttribute('aO', new THREE.BufferAttribute(field.O, 1));
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
    uPeakC: {value: new THREE.Color(PAL.peak)}, uBg: {value: new THREE.Color(PAL.bg)}, uSelC: {value: new THREE.Color(PAL.sel)},
    uThrY: {value: 1e3},  // height of the detection threshold (setField); 1e3 = none
  };
  const vert = `
    attribute float aC; attribute float aP; attribute float aO;
    uniform float uTime, uCarpet, uPeak, uNoise;
    varying float vHeat; varying float vSel; varying vec3 vP;
    void main(){
      vec3 p = position;
      float n = sin(p.x*1.3+uTime*.55)*sin(p.z*1.9-uTime*.4) + .5*sin(p.x*3.1-uTime*.75+p.z*2.2);
      float hP = (aP + aO)*uPeak;  // all groups: one height and one colour ramp
      p.y = aC*uCarpet + hP + n*uNoise*.075;
      vHeat = smoothstep(0.02, 1., hP/${PEAK.toFixed(2)});
      vSel = aP/max(aP + aO, 1e-4) * smoothstep(0., .05, aP*uPeak/${PEAK.toFixed(2)});  // share of the selected group
      vP = p;
      gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.);
    }`;
  const ramp = `
    vec3 ramp(float h){ vec3 c = mix(uCool, uWarm, smoothstep(0.,.5,h)); return mix(c, uPeakC, smoothstep(.5,1.,h)); }
    vec3 tint(float h, float sel){ return mix(ramp(h), uSelC, sel); }
    // the selected group is red only above the threshold, with a soft edge of a few pixels
    float above(float y){ float w = max(fwidth(y), 1e-3); return smoothstep(uThrY - w, uThrY + w, y); }`;
  const lineMat = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: vert, transparent: true, depthWrite: false,
    fragmentShader: `
      uniform vec3 uCool, uWarm, uPeakC, uSelC; uniform float uGlow, uSweep, uSweepOn, uThrY; uniform vec4 uHover;
      varying float vHeat; varying float vSel; varying vec3 vP; ${ramp}
      void main(){
        float sel = vSel * above(vP.y);
        float sweep = exp(-pow((vP.x-uSweep)/.32,2.))*uSweepOn;
        float hov = step(uHover.x,vP.x)*step(vP.x,uHover.y)*step(uHover.z,vP.z)*step(vP.z,uHover.w);
        float far = 1.;  // no depth fade: in an orthographic view it reads as perspective and makes the far side look wider
        float a = uGlow*(.5+.9*max(vHeat, sel*.8))*far + sweep*.32 + hov*.6;
        gl_FragColor = vec4(tint(vHeat, sel)*(1.+max(vHeat, sel*.7)*1.35+sweep*.25+hov), clamp(a,0.,1.));
      }`,
  });
  const sheetMat = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: vert, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1.5, polygonOffsetUnits: 2,
    fragmentShader: `
      uniform vec3 uBg, uCool, uWarm, uPeakC, uSelC; uniform float uThrY;
      varying float vHeat; varying float vSel; varying vec3 vP; ${ramp}
      void main(){
        float sel = vSel * above(vP.y);
        vec3 c = uBg*1.2 + tint(vHeat, sel)*max(vHeat, sel*.7)*.14 + uSelC*sel*.22 + uCool*vP.y*.006;
        // dashed contour where the surface crosses the threshold: ~1.5 px wide, dashes of ~9 px on screen
        float d = abs(vP.y - uThrY) / max(fwidth(vP.y), 1e-4);
        float line = 1. - smoothstep(.75, 1.75, d);
        float dash = step(.45, fract((gl_FragCoord.x + gl_FragCoord.y) / 18.));
        vec3 lc = mix(vec3(1.), uSelC, .35 + .65*vSel);  // pink on the selected group, near white elsewhere
        c = mix(c, lc * (1. + vSel), line * dash * (.55 + .45*vSel));
        gl_FragColor = vec4(c, 1.);
      }`,
  });
  scene.add(new THREE.Mesh(sheet, sheetMat), new THREE.LineSegments(lines, lineMat));

  axGeo = new THREE.BufferGeometry(); drawAxes();
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
  over:   {az: -Math.PI / 4, pol: Math.acos(1 / Math.sqrt(3)), r: 20.5, tx: -.3, ty: -.5, tz: 0, off: 1},  // isometric
  peak:   {az: -.92, pol: 1.18, r: 10.6, tx: -3.0, ty: 1.2, tz: 1.5, off: 1},
  carpet: {az: -.14, pol: .98,  r: 16.5, tx: .4,   ty: .2,  tz: -.5, off: 1},
  top:    {az: -.18, pol: .42,  r: 17.5, tx: -.25, ty: 0,   tz: 0,   off: 1},
};
const cam = {...CAMS.home};
// isometric view as in CAD: 35.26° above the floor, 45° between the axes; a drag ends on the nearest such corner
const ISO_POL = Math.acos(1 / Math.sqrt(3)), ISO_AZ = -Math.PI / 4;
const isoSnap = az => ISO_AZ + Math.round((az - ISO_AZ) / (Math.PI / 2)) * Math.PI / 2;
const ORTHO_K = Math.tan(17 * Math.PI / 180);
let camAspect = 1;
const camTo = (name, duration = 1.25, ease = 'power3.inOut') =>
  gsap.to(cam, {...CAMS[name], duration: reduced ? 0 : duration, ease, overwrite: true});
let dragging = false;

function resize() {
  if (!ok) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h);
  camAspect = w / h;
}
function frame(t) {
  requestAnimationFrame(frame);
  const w = stage.clientWidth, h = stage.clientHeight, wide = w > 860;
  U.uTime.value = reduced ? 0 : t / 1000;
  const az = cam.az, sp = Math.sin(cam.pol);  // no idle sway: the view stays exactly isometric
  const r = cam.r * (wide ? 1 : Math.min(2.15, Math.max(1, 1.38 / Math.max(.5, camAspect))));
  // the view height at the target equals that of the old 34 degree lens at distance r, so framings carry over
  const hh = r * ORTHO_K;
  camera.left = -hh * camAspect; camera.right = hh * camAspect; camera.top = hh; camera.bottom = -hh;
  camera.position.set(cam.tx + r * sp * Math.sin(az), cam.ty + r * Math.cos(cam.pol), cam.tz + r * sp * Math.cos(az));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
  if (wide) camera.setViewOffset(w, h, 0, -h * .055 * cam.off, w, h);
  else camera.setViewOffset(w, h, 0, -h * .02 * cam.off, w, h);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  faceAxes();
  composer.render();
  placeAxes(w, h);
}

/* axis labels live in the DOM, projected from the floor; positions follow the edges the axes sit on */
const side = sx => sx < 0 ? 'r' : 'l';
const AXES = [
  {t: 'Time before now, minutes', p: (sx, sz) => [X(L / 2), 0, timeZ(sz) + sz * 1.15], a: () => 'c', title: 1},
  {t: 'Meaning gap', p: (sx, sz) => [gapX(sx) + sx * 1.35, 0, Z(M / 2)], a: side, title: 1},
  // tick labels: the origin shows the UTC time on screen (filled by loadMap), then −2 min, −4 min, ... −10 min
  ...Array.from({length: L / LABEL_EVERY + 1}, (_, k) => ({t: k ? `−${k * LABEL_EVERY * BIN_MIN} min` : 'now UTC',
    p: (sx, sz) => [X(k * LABEL_EVERY), 0, timeZ(sz) + sz * .4], a: () => 'c', k: 1})),
  // meaning gap 0..1: 0 = same meaning, 1 = unrelated
  ...[0, .2, .4, .6, .8, 1].map(g => ({t: g === 0 ? 'same meaning' : g === 1 ? 'unrelated' : String(g),
    p: (sx, sz) => [gapX(sx) + sx * .35, 0, Z(g * M)], a: side, k: 1})),
  // height: dB above the mean level of all pairs on screen (texts set by setField)
  ...HEIGHT_TICKS.map(g => ({t: '', hk: g, p: (sx, sz) => [gapX(sx) + sx * .3, g * PEAK, timeZ(-sz)], a: side, k: 1})),
  {t: 'dB above the mean level', p: (sx, sz) => [gapX(sx), PEAK + .45, timeZ(-sz)], a: () => 'c', title: 1},
  {t: '', thr: 1, p: (sx, sz) => [gapX(sx) - sx * .3, S.thrY ?? 0, timeZ(-sz)], a: sx => side(-sx)},
].map(d => { const el = document.createElement('span'); el.textContent = d.t; if (d.title) el.className = 't'; if (d.k) el.className = 'k'; if (d.thr) el.className = 'thr'; $('axes').append(el); return {...d, el, v: new THREE.Vector3()}; });
function setHeightLabels(k) {
  thrLabel ??= AXES.find(d => d.thr);
  for (const d of AXES) if (d.hk != null) {
    const db = d.hk * PEAK / k;
    d.el.textContent = `${Math.abs(db - Math.round(db)) < .05 ? Math.round(db) : db.toFixed(1)} dB`;
  }
}
function placeAxes(w, h) {
  for (const d of AXES) {
    d.v.set(...d.p(axSide.x, axSide.z)).project(camera);
    const x = (d.v.x * .5 + .5) * w, y = (-d.v.y * .5 + .5) * h, a = d.a(axSide.x);
    d.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(${a === 'c' ? '-50%' : a === 'r' ? '-100%' : '0'},-50%)`;
  }
}

/* hover: march the pointer ray against the CPU copy of the height field */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), tip = $('tip');
const heightAt = (x, z) => {
  const i = Math.round((x + W / 2) / W * (NX - 1)), j = Math.round((D / 2 - z) / D * (NZ - 1));
  if (i < 0 || j < 0 || i >= NX || j >= NZ) return -1;
  return field.C[j * NX + i] * U.uCarpet.value + (field.P[j * NX + i] + field.O[j * NX + i]) * U.uPeak.value;
};
function hover(e) {
  const y = layers(shown());
  if (root.dataset.stage !== 'result' || dragging || !y) return hideTip();
  const b = canvas.getBoundingClientRect();
  ndc.set((e.clientX - b.left) / b.width * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction; let hit = null;
  for (let s = 0; s < 70; s += .06) {  // orthographic: the ray starts at the near plane, up to ~45 from the scene
    const x = o.x + d.x * s, y = o.y + d.y * s, z = o.z + d.z * s, h = heightAt(x, z);
    if (h >= 0 && y <= h + .02) { hit = [x, z]; break; }
    if (y < -.2) break;
  }
  if (!hit) return hideTip();
  const l = Math.floor(binU(hit[0])), m = Math.floor(binV(hit[1]));
  if (l < 0 || m < 0 || l >= L || m >= M) return hideTip();
  U.uHover.value.set(X(l), X(l + 1), Z(m + 1), Z(m));
  tip.innerHTML = `<b>${l * BIN_MIN}–${(l + 1) * BIN_MIN} min before ${nowText()} UTC, meaning gap ${(m / M).toFixed(2)}–${((m + 1) / M).toFixed(2)}</b>
    <span>${y.sel[m][l]} this group, ${y.others[m][l]} other groups, ${y.rest[m][l]} background · ${cellDb(y, m, l)}</span>`;
  const px = e.clientX - b.left, py = e.clientY - b.top;
  tip.style.transform = `translate(${Math.min(Math.max(8, px + 14), b.width - 256)}px,${Math.max(8, py - 66)}px)`;
  tip.style.opacity = 1;
}
// one cell against the mean cell on screen, in dB
function cellDb(y, m, l) {
  const all = (sum(y.sel) + sum(y.others) + sum(y.rest)) / (L * M), t = y.sel[m][l] + y.others[m][l] + y.rest[m][l];
  return !all || !t ? 'no pairs' : `${(10 * Math.log10(t / all)).toFixed(1)} dB vs the mean cell`;
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
const endDrag = () => {
  if (!dragging) return;
  dragging = false; canvas.classList.remove('dragging');
  gsap.to(cam, {az: isoSnap(cam.az), pol: ISO_POL, duration: reduced ? 0 : .5, ease: 'power2.out', overwrite: true});
};
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
  {title: 'Estimating noise', fact: () => `False alarm target ≤ ${pct(alpha())}`, dur: 1.1},
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
  liveStart(topic);
  S.topic = topic; S.list = topicFindings(topic);
  S.sel = Math.max(0, S.list.findIndex(f => f.id === findingId));
  S.pickedWeak = S.list[S.sel]?.verdict !== 'coordinated' && !!findingId;
  scrollTw?.kill(); scrollTw = null; mapSeq++;
  S.tmap = null; S.mapAt = null; S.view = 0;
  setMapAt(rewindFor(shown()));  // the opened group on screen from the start (rewound if it is older than the map)
  history.replaceState(null, '', `?q=${encodeURIComponent(topic)}`);
  tl?.kill(); selTl?.kill();
  root.dataset.stage = 'scan'; scrollTo(0, 0); hideTip();
  $('q').value = topicLabel(topic); $('q').blur(); syncClear();
  if (!ok) return showResult(true);
  gsap.killTweensOf([U.uCarpet, U.uPeak, U.uNoise, U.uGlow, U.uSweep, U.uSweepOn, axisMat, cam]);
  U.uCarpet.value = 0; U.uPeak.value = 0; axisMat.opacity = 0;
  setField(shown());
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
  gsap.to(axisMat, {opacity: .9, duration: .55 * d, delay: .2 * d});
}
function goHome() {
  liveStop();
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

const groupLabel = g => `${VERDICT[g.verdict].light} ${span(g)} UTC · ${g.accounts.length} accounts · ${g.verdict}${g.synthetic ? ` · ${SIM}` : ''}`;

// One drop-down for all groups of the topic: alerts first, weaker groups in their own section.
function groupPicker(f, alerts, weak) {
  if (!S.list.length) return '';
  const opt = k => `<option value="${k}"${f && k === S.sel ? ' selected' : ''}>${esc(groupLabel(S.list[k]))}</option>`;
  const sect = (label, ks) => ks.length ? `<optgroup label="${label} (${ks.length})">${ks.map(opt).join('')}</optgroup>` : '';
  return `<label class="group-pick"><span>Group${f ? ` ${S.sel + 1} of ${S.list.length}` : ''}</span>
    <select id="groupSel" aria-label="Group shown on the map">
      <option value="now">${S.mapAt ? '⏵ Now · back to the live map' : '⏵ Now · live map'}</option>
      ${f ? '' : `<option value="" selected disabled>${weak.length} weaker group${weak.length === 1 ? '' : 's'} · not alerts</option>`}
      ${sect('Alerts', alerts)}${sect('Weaker groups · not alerts', weak)}
    </select></label>`;
}

function render() {
  const f = shown();
  const vt = $('vTitle');
  const idx = S.list.map((g, k) => k);
  const alerts = idx.filter(k => S.list[k].verdict === 'coordinated'), weak = idx.filter(k => S.list[k].verdict !== 'coordinated');
  $('groups').innerHTML = groupPicker(f, alerts, weak);
  $('legend').style.display = f ? '' : 'none';
  if (!f) {
    vt.dataset.v = 'organic'; vt.textContent = 'Quiet';
    $('vText').textContent = weak.length
      ? `No coordinated group in the last ${WINDOW_HOURS} h of ${topicLabel(S.topic)}; ${weak.length} weaker look-alike group${weak.length === 1 ? ' stays' : 's stay'} below the alert threshold.`
      : `No groups of look-alike accounts in the last ${WINDOW_HOURS} h of ${topicLabel(S.topic)}.`;
    $('vRisk').innerHTML = `🟢 Nothing above the detector threshold. <small>${pfaText()}</small>`;
    for (const id of ['evSay', 'evWho', 'evPosts', 'evCorr', 'evDecision', 'evSignal']) $(id).innerHTML = '';
    $('evSay').innerHTML = `<h3>Nothing to show</h3><p>No look-alike groups right now; the live scan keeps watching this topic.</p>`;
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
    ` <small>${pfaText()} · ${snr}</small>` +
    ` <a class="how" href="/explain?id=${encodeURIComponent(f.id)}&topic=${encodeURIComponent(f.topic)}&alpha=${S.alpha}">How we got here →</a>`;
  const y = layers(f);
  $('lgSpike').textContent = !y ? 'Loading the map…' : sum(y.sel) ? `${sum(y.sel)} pairs of posts at ${span(f)} UTC, at most 2 min apart`
    : `Posted at ${span(f)} UTC: older than the ${L * BIN_MIN} min on the map`;
  $('lgOthers').textContent = y ? `${sum(y.others)} pairs of the other ${S.list.length - 1} group${S.list.length === 2 ? '' : 's'}` : '';
  $('lgCarpet').textContent = !y ? '' : S.mapAt ? `${sum(y.rest)} other pairs in the ${L * BIN_MIN} min before ${nowText()} UTC · not live`
    : `${sum(y.rest)} other pairs in the last ${L * BIN_MIN} min`;

  const x = f.explanation;
  $('evSay').innerHTML = (x
    ? `<h3>Technique</h3><blockquote>“${esc(x.quote)}”</blockquote><p>${esc(x.technique)}, ${Math.round(x.confidence * 100)}% confidence</p>`
    : `<h3>Technique</h3><p>${hit ? 'Explanation is being generated.' : 'Only coordinated groups get an explanation.'}</p>`) +
    (f.note ? `<p class="note">${esc(f.note)}</p>` : '');
  $('evWho').innerHTML = `<h3>Accounts</h3><ul class="who">${f.accounts.map(a => `<li>${esc(handle(a))}</li>`).join('')}</ul>
    <p>${f.item_ids.length} posts, ${hm(f.first_seen)}–${hm(f.last_seen)} UTC${f.synthetic ? ` · ${SIM} (red team console)` : ''}</p>`;
  renderPosts(f);
  $('evCorr').innerHTML = corrGrid(f);
  $('evDecision').innerHTML = `<h3>Sequential test (SPRT)</h3>${trace(f)}<p>${f.decided_at_item != null
    ? `Crossed the ${f.verdict === 'coordinated' ? 'upper' : 'lower'} threshold at post ${f.decided_at_item + 1}.`
    : hit ? 'The group these accounts belong to crossed the upper threshold in another wave.'
    : f.note && f.sprt_trace.length && f.sprt_trace.at(-1) >= f.sprt_upper
      ? `Crossed the upper threshold after ${f.sprt_trace.length} posts, but downgraded to watching (news echo).`
      : `Between thresholds after ${f.sprt_trace.length} posts.`}</p>`;
  const mx = Math.max(f.snr_db, f.snr_db_single ?? 0, 1);
  $('evSignal').innerHTML = `<h3>Signal-to-noise</h3><div class="bars">
      ${f.snr_db_single != null ? `<div><span>Average pair</span><i style="width:${Math.max(0, f.snr_db_single) / mx * 100}%"></i><span>${f.snr_db_single.toFixed(1)} dB</span></div>` : ''}
      <div><span>Group (${n})</span><i style="width:${Math.max(0, f.snr_db) / mx * 100}%"></i><span>${f.snr_db.toFixed(1)} dB</span></div></div>
      <p>Combining all account pairs coherently lifts the swarm above the noise.</p>`;
}

async function renderPosts(f) {
  const want = f.item_ids.filter(i => !S.items.has(i)).slice(0, 200);
  if (want.length) {
    $('evPosts').innerHTML = '<h3>Posts</h3><p>Loading…</p>';
    try { for (const it of await api(`/api/items?ids=${want.map(encodeURIComponent).join(',')}`)) S.items.set(it.id, it); }
    catch (e) { if (shown() === f) $('evPosts').innerHTML = `<h3>Posts</h3><p>Could not load posts (${esc(e.message)}).</p>`; return; }
  }
  if (shown() !== f) return;                              // the user moved on meanwhile
  const its = f.item_ids.map(i => S.items.get(i)).filter(Boolean).sort((a, b) => a.published_at.localeCompare(b.published_at));
  const first = its.slice(0, 8);
  $('evPosts').innerHTML = `<h3>Posts</h3><ul class="posts">${first.map(it => `<li><span class="meta">${esc(handle(it.author))} · ${hm(it.published_at)} UTC${it.platform ? ' · ' + esc(platformLabel(it.platform)) : ''}${it.synthetic ? `<span class="syn">${SIM}</span>` : ''}</span>${esc(it.text)}${/^https?:\/\//i.test(it.url ?? '') ? ` <a href="${esc(it.url)}" target="_blank" rel="noopener">source</a>` : ''}</li>`).join('')}</ul>
    <p>${first.length < its.length ? `First ${first.length} of ${its.length} posts.` : `${its.length} posts.`}</p>`;
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

// A group whose last post is already off the live map (older than L*BIN_MIN minutes) rewinds the map to the
// group's time: its last post lands a minute right of the origin. A group still posting keeps the map live.
const REWIND_PAD_MS = 60000;
function rewindFor(f) {
  if (!f || Date.parse(f.last_seen) >= Date.now() - L * BIN_MIN * 60000) return null;
  return new Date(Math.min(Date.parse(f.last_seen) + REWIND_PAD_MS, Date.now())).toISOString();
}
// Moves the map so its origin is `at` (null = live now). One map from the server covers both the current
// origin and the target, and the view scrolls over it, so the time axis slides instead of jumping.
let scrollTw = null, mapSeq = 0;
async function setMapAt(at) {
  if (at === S.mapAt && S.tmap) return;
  const prev = S.mapAt;
  S.mapAt = at; hideTip();
  const topic = S.topic, asked = S.alpha, seq = ++mapSeq;
  const target = at ? Date.parse(at) : Date.now(), from = S.tmap ? originMs() : target;
  const end = Math.max(from, target), live = !at;
  const minutes = Math.min(1440, Math.ceil(L * BIN_MIN + Math.abs(target - from) / 60000) + 1);
  let r;
  try {
    r = await api(`/api/timemap?topic=${encodeURIComponent(topic)}&minutes=${minutes}` +
      `${asked === DESIGN_ALPHA ? '' : `&alpha=${asked}`}${live ? '' : `&at=${encodeURIComponent(new Date(end).toISOString())}`}`);
  } catch (e) { console.warn('timemap', e); if (seq === mapSeq) S.mapAt = prev; return; }  // keep state = what is drawn
  if (seq !== mapSeq || S.topic !== topic || S.alpha !== asked) return;
  scrollTw?.kill();
  const hadMap = !!S.tmap, endMs = Date.parse(r.now);
  const vTo = live ? 0 : Math.max(0, Math.round((endMs - target) / BIN_MS)), vFrom = Math.max(0, (endMs - from) / BIN_MS);
  S.tmap = r;
  if (!ok || reduced || !hadMap || Math.abs(vTo - vFrom) < .5) { S.view = vTo; showMap(); return; }
  S.view = vFrom; const kA = scaleOf(sample(shown()));
  S.view = vTo; const kB = scaleOf(sample(shown()));
  S.view = vFrom;
  const t = {p: 0}, dist = Math.abs(vTo - vFrom) / L;  // in screen widths
  scrollTw = gsap.to(t, {
    p: 1, duration: Math.min(2.6, .9 + .55 * Math.log2(1 + dist)), ease: 'power2.inOut',
    onUpdate: () => { S.view = vFrom + (vTo - vFrom) * t.p; setField(shown(), kA + (kB - kA) * t.p); setOrigin(); },
    onComplete: () => { scrollTw = null; S.view = vTo; showMap(); },
  });
}
function goLive() {
  setMapAt(null);
  if (root.dataset.stage === 'result') render();
}

function select(i, instant) {
  if (i === S.sel && shown()) { setMapAt(rewindFor(shown())); return; }  // already shown: only bring its wave on screen
  // (in the Quiet view index 0 is "selected" but not shown: fall through and open it)
  S.sel = i; S.pickedWeak = S.list[i]?.verdict !== 'coordinated'; hideTip(); selTl?.kill();
  setMapAt(rewindFor(shown()));
  const d = reduced || instant ? 0 : 1;
  selTl = gsap.timeline().to('#vTitle,#vText,#vRisk', {autoAlpha: 0, duration: .14 * d}).call(render).to('#vTitle,#vText,#vRisk', {autoAlpha: 1, duration: .26 * d});
  if (!ok) return;
  setField(shown());  // the surface stays as it is: only the accent colour moves to the picked group
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
    `<button class="sample-chip" type="button" data-sample="${esc(t)}">${esc(topicLabel(t))}${count(t) ? `<b>${count(t)}</b>` : ''}</button>`).join('');
  $('topicList').innerHTML = S.topics.map(t => `<option value="${esc(topicLabel(t))}">`).join('');
  const feed = S.findings.filter(f => f.verdict !== 'organic' && S.topics.includes(f.topic))
    .sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || b.created_at.localeCompare(a.created_at)).slice(0, 6);
  $('feed').innerHTML = feed.length ? feed.map(f =>
    `<li><button type="button" data-topic="${esc(f.topic)}" data-fid="${esc(f.id)}"><span>${VERDICT[f.verdict].light} ${VERDICT[f.verdict].title}</span>
      <span>${esc(topicLabel(f.topic))} · ${f.accounts.length} accounts${f.synthetic ? ` · ${SIM}` : ''}</span><span class="t">${ago(f.created_at)}</span></button></li>`).join('')
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
    const asked = S.alpha;
    const r = await api(asked === DESIGN_ALPHA ? '/api/alerts' : `/api/alerts?alpha=${asked}`);
    if (asked !== S.alpha) return false;  // the selector changed while this request was in flight
    S.findings = r.findings; S.lastPoll = r.last_poll_at;
  } catch (e) { console.warn('alerts', e); return false; }
  renderStatus();
  if (root.dataset.stage === 'home') renderHome();
  else if (S.topic && root.dataset.stage === 'result') {
    const cur = shown()?.id, next = topicFindings(S.topic);
    const sig = l => l.map(f => `${f.id}:${f.verdict}:${f.item_ids.length}:${f.explanation ? 1 : 0}`).join();
    if (sig(next) !== sig(S.list)) {
      const at = next.findIndex(f => f.id === cur);
      S.list = next; S.sel = Math.max(0, at);
      if (at < 0) S.pickedWeak = false;  // the opened group is gone: back to the alert (or Quiet)
      if (ok) setField(shown());
      render();
      const want = rewindFor(shown());
      if (shown()?.id !== cur && want !== S.mapAt) setMapAt(want);  // a new group on screen: bring its wave into view
      else loadMap();
    } else if (!S.tmap || S.list.some(f => !S.tmap.groups[f.id]) || (!S.mapAt && Date.now() - Date.parse(S.tmap.now) > MAP_MAX_AGE_MS)) loadMap();  // also retries a map that never arrived  // keep "now" current; a rewound map stays put
  }
  return true;
}

// time x meaning map of the open topic, live or rewound; the scene shows a flat floor until it arrives
const setOrigin = () => { AXES[2].el.textContent = `${nowText()} UTC`; };  // the origin label = the moment on screen
function showMap() {
  setOrigin();
  if (ok) setField(shown());
  if (root.dataset.stage === 'result') render();
}
// periodic reload of the current map: live = the last L bins, rewound = the same map again (new groups)
async function loadMap() {
  const topic = S.topic, asked = S.alpha, seq = mapSeq, rewound = S.mapAt && S.tmap;
  if (!topic || S.mapBusy || scrollTw) return;
  S.mapBusy = true;
  try {
    const r = await api(`/api/timemap?topic=${encodeURIComponent(topic)}` +
      `&minutes=${rewound ? S.tmap.n_bins * BIN_MIN : L * BIN_MIN}${asked === DESIGN_ALPHA ? '' : `&alpha=${asked}`}` +
      `${rewound ? `&at=${encodeURIComponent(S.tmap.now)}` : ''}`);
    if (seq !== mapSeq || scrollTw || S.topic !== topic || S.alpha !== asked || !!S.mapAt !== !!rewound) return;
    if (!rewound) S.view = 0;
    S.tmap = r; showMap();
  } catch (e) { console.warn('timemap', e); }
  finally { S.mapBusy = false; }
}

/* ------------------------------------------------------------------ live scan (T12d) */
// Check = a scan session on the topic: the worker re-runs the detector every ~10 s while this page polls
// /api/radar (also the session heartbeat) and /api/alerts; every panel of the result view re-renders from them.
const post = body => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
const closeSession = id => fetch(`/api/scan/${id}/stop`, {method: 'POST', keepalive: true}).catch(() => {});

async function liveStart(topic) {
  liveStop();
  const L = {topic, session: null, since: null, frame: null, timer: null, busy: false, error: null};
  S.live = L; renderLive();
  try {
    L.session = (await api('/api/scan', post({topics: [topic]}))).session_id;
  } catch (e) {
    if (S.live === L) { L.error = `Live scan unavailable (${e.message}); results refresh every ${POLL_MS / 1000} s.`; S.live = null; renderLive(L.error); }
    return;
  }
  if (S.live !== L) { closeSession(L.session); return; }  // stopped or another topic meanwhile
  L.timer = setInterval(() => liveTick(L), LIVE_MS);
  liveTick(L);
}

function liveStop(msg) {
  const L = S.live;
  if (!L) return;
  clearInterval(L.timer); S.live = null;
  if (L.session) closeSession(L.session);
  renderLive(msg, L);
}

async function liveTick(L) {
  if (L.busy || S.live !== L) return;
  L.busy = true;
  try {
    let frames;
    try {
      frames = await api(`/api/radar?session=${L.session}&topic=${encodeURIComponent(L.topic)}${L.since ? `&since=${encodeURIComponent(L.since)}` : ''}`);
    } catch (e) {
      if (e.status !== 410) throw e;                     // tab slept > 60 s: the session closed, open a new one
      const id = (await api('/api/scan', post({topics: [L.topic]}))).session_id;
      if (S.live === L) L.session = id; else closeSession(id);  // stopped while reopening
      return;
    }
    if (S.live !== L) return;
    if (frames.length) { L.frame = frames.at(-1); L.since = L.frame.at; }
    if (!(await refresh())) throw new Error('alerts unavailable');
    L.error = null;
  } catch (e) {
    L.error = `connection problem (${e.message}), retrying…`;
  } finally {
    L.busy = false;
    if (S.live === L) renderLive();
  }
}

function renderLive(msg, last) {
  const L = S.live, btn = $('liveBtn'), out = $('liveMsg');
  btn.dataset.on = String(!!L);
  btn.textContent = L ? 'Stop' : 'Resume live scan';
  btn.disabled = !L && !S.topic;
  if (!L) { out.innerHTML = `<span class="live-dot"></span>${esc(msg ?? (last ? 'Live scan stopped.' : ''))}`; return; }
  const f = L.frame;
  const bits = f
    ? [`frame ${f.at.slice(11, 19)} UTC`, `${f.n_items} posts from ${f.n_accounts} accounts in ${WINDOW_HOURS} h`,
       ...(f.n_watching ? [`${f.n_watching} news echo${f.n_watching === 1 ? '' : 'es'} on watch`] : []),
       ...(f.top_verdict === 'coordinated' ? [`swarm of ${f.top_n_accounts} accounts`] : [])]
    : ['starting the scan…'];
  // the live frame is the design alpha; other slider points are recomputed on the worker's slow pass only
  if (S.alpha !== DESIGN_ALPHA) bits.push(`live at ${pct(DESIGN_ALPHA)}; the ${pct(S.alpha)} view refreshes every ~5 min`);
  out.innerHTML = `<span class="live-dot on"></span>Live · ${esc(bits.join(' · '))}${L.error ? ` · ${esc(L.error)}` : ''}`;
}

/* ------------------------------------------------------------------ wiring */
$('q').addEventListener('input', syncClear);
$('search').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  const lq = q.toLowerCase();
  const t = S.topics.find(t => t === q || topicLabel(t).toLowerCase() === lq) ?? S.topics.find(t => t.includes(lq.replace(/\s+/g, '-')));
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
$('groups').addEventListener('change', e => {
  if (e.target.id !== 'groupSel' || e.target.value === '') return;
  if (e.target.value === 'now') goLive(); else select(+e.target.value);
});
$('legend').addEventListener('click', e => {
  const b = e.target.closest('.lg-btn'); if (!b || !ok) return;
  const on = b.getAttribute('aria-pressed') === 'true';
  setLegend(on ? null : b); camTo(on ? 'over' : b.dataset.cam);
});
$('liveBtn').addEventListener('click', () => { if (S.live) liveStop(); else if (S.topic) liveStart(S.topic); });
addEventListener('pagehide', () => { if (S.live?.session) navigator.sendBeacon?.(`/api/scan/${S.live.session}/stop`); });
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

// T12c false-alarm slider: one stop per SPRT alpha, hint from the measured point (/api/operating_points)
const per = a => `~${Math.round(1 / a)}`;
function alphaHint(a) {
  const p = S.points?.points?.find(q => Math.abs(q.alpha - a) < 1e-9);
  const lim = `Design target: <b>1 false alarm per ${per(a)}</b> quiet windows (6 h of one topic)`;
  if (!p) return [`${lim}. Not measured yet.${a !== DESIGN_ALPHA ? ` Live scan updates at ${pct(DESIGN_ALPHA)}; this point refreshes every ~5 min.` : ''}`, ''];
  const dec = p.posts_to_decision != null ? ` · decides after <b>~${p.posts_to_decision.toFixed(1)} posts</b>` : '';
  const lag = a !== DESIGN_ALPHA ? ` · live scan updates at ${pct(DESIGN_ALPHA)}; this point refreshes every ~5 min` : '';
  const hint = `${lim} · catches <b>${pct(p.pd_small)}</b> of 3-account swarms${dec}${lag}`;
  const alarms = Math.round(p.pfa * p.n_background);
  let meas = `Measured: ${alarms} false alarm${alarms === 1 ? '' : 's'} in ${p.n_background} test windows (≤ ${pct(p.pfa_upper95)} at 95%)`;
  if (p.n_independent) {
    const ia = Math.round((p.pfa_independent ?? 0) * p.n_independent);
    meas += ` · ${ia} in ${p.n_independent} independent live windows` +
      (p.pfa_independent_upper95 != null ? ` (≤ ${pct(p.pfa_independent_upper95)})` : '');
  }
  return [hint, meas];
}

function setupAlpha() {
  const range = $('alphaRange');
  // only the alphas the worker computes (/api/alphas, from its ALPHA_POINTS): any other stop would show an
  // empty feed; SLIDER_ALPHAS if unknown. A stop without a measured point says so in its hint
  const alphas = [...(S.served ?? SLIDER_ALPHAS)].sort((x, y) => x - y);
  let saved = null;
  try { saved = parseFloat(localStorage.getItem('ltr.alpha')); } catch {}
  S.alpha = alphas.includes(saved) ? saved : (alphas.includes(DESIGN_ALPHA) ? DESIGN_ALPHA : alphas[0]);
  range.max = String(alphas.length - 1);
  $('fa').hidden = alphas.length < 2;  // one served stop: nothing to choose
  range.value = String(alphas.indexOf(S.alpha));
  const at = i => i / Math.max(1, alphas.length - 1) * 100;
  $('alphaStops').innerHTML = alphas.map((a, i) =>
    `<button type="button" tabindex="-1" data-i="${i}" style="left:${at(i)}%">${pct(a)}</button>`).join('');
  const show = i => {
    const a = alphas[i];
    range.style.setProperty('--p', `${at(i)}%`);
    range.setAttribute('aria-valuetext', `${pct(a)} false alarm limit`);
    $('alphaVal').textContent = pct(a);
    $('alphaChipVal').textContent = pct(a);
    for (const b of $('alphaStops').children) b.classList.toggle('on', +b.dataset.i === i);
    const [hint, meas] = alphaHint(a);
    $('alphaHint').innerHTML = hint; $('alphaMeas').textContent = meas;
  };
  const commit = async () => {
    const a = alphas[+range.value];
    if (a === S.alpha) return;
    S.alpha = a;
    try { localStorage.setItem('ltr.alpha', String(a)); } catch {}
    const fresh = await refresh();
    // any stage: a change during the scan animation must not leave the old point's list for showResult
    if (fresh && S.topic) {
      S.list = topicFindings(S.topic); S.sel = 0; S.pickedWeak = false;
      if (root.dataset.stage === 'result') { if (ok) setField(shown()); render(); }
    }
  };
  range.addEventListener('input', () => show(+range.value));  // live hint while dragging
  range.addEventListener('change', commit);                    // fetch alerts on release / key press
  $('alphaStops').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    range.value = b.dataset.i; show(+b.dataset.i); commit(); range.focus();
  });
  $('alphaChip').addEventListener('click', () => { goHome(); setTimeout(() => range.focus({preventScroll: true}), 50); });
  show(+range.value);
}

try { buildScene(); } catch (err) { ok = false; console.error(err); canvas.style.display = 'none'; }
if (ok) { new ResizeObserver(resize).observe(stage); resize(); requestAnimationFrame(frame); }

(async () => {
  const [topics, metrics, points, served] = await Promise.allSettled(
    [api('/api/topics'), api('/api/metrics'), api('/api/operating_points'), api('/api/alphas')]);
  S.topics = topics.value ?? [];
  S.metrics = metrics.value ?? null;
  S.points = points.value ?? null;
  S.served = Array.isArray(served.value) && served.value.length ? served.value : null;
  setupAlpha();
  await refresh();
  renderHome();
  const q = new URLSearchParams(location.search).get('q');
  if (q && S.topics.includes(q)) openTopic(q, {instant: true});
  setInterval(refresh, POLL_MS);
  setInterval(renderStatus, 30000);
})();
