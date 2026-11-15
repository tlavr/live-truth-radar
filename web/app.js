// Live Swarm Radar dashboard (T12). Scene and motion from the frontend reference
// (docs/frontend-reference on p2/frontend-reference); data from /api/* (T8).
// From the T12e experiment (branch ui): the group header (tabs, Why, What they say, How we got here), the
// "When" timeline, the cell card and the sensitivity menu.
import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {topicLabel, platformLabel} from './labels.js';
import {heldByNews, reasons} from './chain.js';
import {points} from './says.js';
import {merged} from './when.js';
import {HELD, LABEL, LETTER, ordered, verdictLabel} from './groups.js';
import {createStrip} from './strip.js';
import {stepsHTML, wireSteps} from './steps.js';

const POLL_MS = 15000;
const LIVE_MS = 10000;             // T12d: Check starts a live scan of the topic; frames + findings every 10 s (the worker scans every 10 s)
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
  pop: null,                       // the open header panel ('why')
  pick: null,                      // the picked cell of the map {l, m} (its card is #pick), or null
  live: null,  // T12d live scan: {topic, session, since, frame, timer, busy, error}
  pickedWeak: false,               // T12d: a group below the alert threshold is shown only if the user picked it
  tmap: null, mapBusy: false,      // time x meaning map of the topic (/api/timemap), one layer per group
  mapAt: null, drawnAt: null, mapPending: false, view: 0,            // mapAt: null = live, else the ISO moment the map is rewound to;
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
// alerts first, then in time order (groups.js, the same order and letters as on /explain)
const topicFindings = t => ordered(S.findings.filter(f => f.topic === t));
const span = f => hm(f.first_seen) === hm(f.last_seen) ? hm(f.first_seen) : `${hm(f.first_seen)}–${hm(f.last_seen)}`;

// the group the result view shows: an alert (coordinated), or a weaker group only if the user opened it
const shown = () => { const f = S.list[S.sel]; return f && (f.verdict === 'coordinated' || S.pickedWeak) ? f : null; };
const SIM = 'simulated attack';

const PAL = {bg: '#0C100E', cool: '#63CF97', muted: '#A3B8AA', warm: '#B7F063', peak: '#FFE066', sel: '#FF5C9E'};

/* ------------------------------------------------------------------ scene */
// grid of the time x meaning map (detect/timemap.py): the last L time bins of 30 s (10 min), 20 meaning-gap
// bins of 0.05. Ordinary axes: the origin is "now" and meaning gap 0; time runs to the right into the past.
// Labels every LABEL_EVERY bins (2 min, 0.2); a small tick at every bin.
const M = 20, L = 20, BIN_MIN = .5, LABEL_EVERY = 4;
const U0 = 0, U1 = L;  // the surface starts and ends exactly at the axes
const W = 10, D = 6, PEAK = 3.1, NX = 190, NZ = 56;
const PING_SEC = 2.4, PING_SPEED = 5;     // sonar: a ring leaves the antenna's corner at each data update and crosses the whole map; life (s), speed
const PING_IDLE = '#63CF97', PING_SWARM = '#FF3B3B';   // its colour: calm, and red while a swarm is on the map
// landing: the red dot of the "i" in the wordmark beats every BEAT_SEC s, and on each beat a cream sonar ring runs
// from the centre of the wave outwards. Both read the same frame clock (uTime), so they stay in step
const BEAT_SEC = 12, BEAT_SPEED = 3, RING_SEC = 3.2;   // a ring every 12 s; it crosses the wave in ~3 s, then the field is calm
// now and then the ring finds a peak, a disturbance of the field (a swarm) that was there unseen: the peak shows,
// red, only behind the ring's thin front as it passes over it; the ring runs on red, and the peak settles back
const SPOT_FALL = 3.5, SPOT_HOLD = 2.5, SPOT_H = .55, SPOT_W = .3;   // s ×2, units ×2
// the landing follows the sensitivity menu: each ring finds a swarm with this chance, from the strictest stop
// (sens 0) to the most sensitive one (sens 1). A demo of the trade-off, not a measurement
const spotP = sens => .1 + .75 * sens;
let sens = .5, spotRolled = -1;                      // the slider's position 0..1; the last beat rolled for
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let spot = null;                                     // the peak on screen ({x, z, d, hit, beat, end})
function spotTick(t) {
  const next = Math.floor(t / BEAT_SEC) + 1;          // the next ring: roll once whether it finds a swarm
  if (!spot && next !== spotRolled) { spotRolled = next; if (Math.random() < spotP(sens)) {
    const ang = Math.random() * Math.PI * 2, dist = 1.5 + Math.random() * 2.4;
    const x = Math.max(-4.2, Math.min(4.2, Math.cos(ang) * dist)), z = Math.max(-2.4, Math.min(2.4, Math.sin(ang) * dist * .65));
    const d = Math.hypot(x, z), beat = Math.floor(t / BEAT_SEC) + 1;   // the next ring finds it
    const hit = beat * BEAT_SEC + d / BEAT_SPEED;
    spot = {x, z, d, hit, beat, end: hit + SPOT_HOLD + SPOT_FALL};
  } }
  if (spot && t > spot.end) { spot = null; spotRolled = Math.floor(t / BEAT_SEC) + 1; }   // the ring after it rolls afresh
  if (!spot) { U.uSpot.value.z = 0; U.uSpot.value.w = 0; U.uRingRed.value = 0; return; }
  // there from the start of the ring that finds it, but shown only behind that ring's front (shader); it settles later
  const top = spot.hit + SPOT_HOLD;
  const amp = t >= spot.beat * BEAT_SEC ? 1 - ss(top, spot.end, t) : 0;
  U.uSpot.value.set(spot.x, spot.z, amp, amp > 0 ? 1 : 0);
  U.uSpotD.value = spot.d;
  U.uRingRed.value = Math.floor(t / BEAT_SEC) === spot.beat ? 1 : 0;   // the ring that found it runs on red
}
const V0 = 0, V1 = M;
const X = u => -W / 2 + (u - U0) / (U1 - U0) * W, Z = v => D / 2 - (v - V0) / (V1 - V0) * D;
const binU = x => (x + W / 2) / W * (U1 - U0) + U0, binV = z => (D / 2 - z) / D * (V1 - V0) + V0;
const canvas = $('scene'), stage = $('stage');
let renderer, composer, bloom, camera, scene, U, axisMat, axGeo, geoms = [], ok = true;
// Safari (WebKit) on a retina Mac kills the page when the GPU process runs out of memory: a 4x multisampled
// half-float target plus the bloom chain at DPR 2 (3024x1800) is several hundred MB. There: DPR <= 1.25, 2x MSAA.
const SAFARI = /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent);
const MAX_DPR = SAFARI ? 1.25 : 2, MSAA = SAFARI ? 2 : 4;
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
// the map's times in the viewer's own time zone
const localHM = ms => new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
const nowText = () => S.tmap ? localHM(originMs()) : 'now';
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
  if (thrLabel) {                    // only the number on the axis, in the threshold's colour; the meaning on hover
    thrLabel.el.textContent = thr > 0 ? `${thr.toFixed(1)} dB` : '';
    thrLabel.el.title = thr > 0 ? `Detection threshold: mean + ${CFAR_K}σ of the map, ${thr.toFixed(1)} dB. What rises above it stands out from the noise.` : '';
  }
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
let tickPhase = 0;                                    // see setOrigin: the time ticks move with the surface
function drawAxes() {
  const sx = axSide.x, sz = axSide.z, ax = [], zt = timeZ(sz), xg = gapX(sx), zf = timeZ(-sz);
  ax.push(X(0), 0, zt, X(L), 0, zt, xg, 0, Z(0), xg, 0, Z(M));
  const f = tickPhase % 1, k0 = Math.floor(tickPhase);
  for (let j = 0; j <= L; j++) {
    const l = j + f; if (l > L + 1e-6) break;
    const x = X(l), big = ((j - k0) % LABEL_EVERY + LABEL_EVERY) % LABEL_EVERY === 0;
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
  renderer = new THREE.WebGLRenderer({canvas, antialias: !SAFARI, powerPreference: 'high-performance'});  // the composer target is multisampled anyway
  renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_DPR));
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
    uPick: {value: new THREE.Vector4(9, 9, 9, 9)},        // the picked cell, outlined like the hovered one
    uBeatOn: {value: reduced ? 0 : 1},                                  // the landing's sonar (home only)
    uSpot: {value: new THREE.Vector4(0, 0, 0, 0)},       // the landing's peak: floor x, z, height (0..1), red (0..1)
    uSpotD: {value: 0}, uRingRed: {value: 0},             // its distance from the centre; 1 while the ring that found it runs
    uPingO: {value: new THREE.Vector2(0, 0)},           // where the sonar starts: the antenna's corner (placeTick)
    uPingOn: {value: 0}, uPingT: {value: -99}, uPingC: {value: new THREE.Color(PING_IDLE)},   // sonar from the origin (result view): start (uTime)
    uCool: {value: new THREE.Color(PAL.cool)}, uWarm: {value: new THREE.Color(PAL.warm)},
    uPeakC: {value: new THREE.Color(PAL.peak)}, uBg: {value: new THREE.Color(PAL.bg)}, uSelC: {value: new THREE.Color(PAL.sel)},
    uThrY: {value: 1e3},  // height of the detection threshold (setField); 1e3 = none
  };
  // sheet = the dark surface under the lines: the landing's peak lifts only the lines, so the sheet never hides
  // the lines around it (a dark ring)
  const vertOf = sheet => `
    attribute float aC; attribute float aP; attribute float aO;
    uniform float uTime, uCarpet, uPeak, uNoise, uBeatOn, uRingRed; uniform vec4 uSpot;
    varying float vHeat; varying float vSel; varying vec3 vP; varying float vBump;
    void main(){
      vec3 p = position;
      float n = sin(p.x*1.3+uTime*.55)*sin(p.z*1.9-uTime*.4) + .5*sin(p.x*3.1-uTime*.75+p.z*2.2);
      float hP = (aP + aO)*uPeak;  // all groups: one height and one colour ramp
      p.y = aC*uCarpet + hP + n*uNoise*.075;
      vec2 dq = p.xz - uSpot.xy;
      // the landing's peak (its shape, 0..1). It was there all along, unseen: it shows only where the ring that
      // finds it has passed, so it rises behind the ring's front
      float br = mod(uTime, ${BEAT_SEC.toFixed(2)}) * ${BEAT_SPEED.toFixed(2)};
      float seen = mix(1., 1. - smoothstep(br - .2, br + .2, length(p.xz)), uRingRed);
      vBump = uBeatOn * exp(-dot(dq, dq) / ${(2 * SPOT_W * SPOT_W).toFixed(3)}) * seen;
      // the sheet sits a hair below its lines: a depth offset alone fails on flat stretches (crests, troughs)
      // on some GPUs (Metal), where the sheet then hides the lines in dashed arcs
      ${sheet ? 'p.y -= .02;' : `p.y += vBump * uSpot.z * ${SPOT_H.toFixed(2)};`}
      vHeat = smoothstep(0.02, 1., hP/${PEAK.toFixed(2)});
      vSel = aP/max(aP + aO, 1e-4) * smoothstep(0., .05, aP*uPeak/${PEAK.toFixed(2)});  // share of the selected group
      vP = p;
      gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.);
    }`;
  const ramp = `
    vec3 ramp(float h){ vec3 c = mix(uCool, uWarm, smoothstep(0.,.5,h)); return mix(c, uPeakC, smoothstep(.5,1.,h)); }
    vec3 tint(float h, float sel){ return mix(ramp(h), uSelC, sel); }
    // the selected group is red only above the threshold, with a soft edge of a few pixels
    // fwidth of a line primitive is unreliable on some GPUs (Metal: huge or infinite at places): clamped, or the
    // edge maths turns into NaN and the line goes black in dashed arcs
    float above(float y){ float w = clamp(fwidth(y), 1e-3, .05); return smoothstep(uThrY - w, uThrY + w, y); }`;
  const lineMat = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: vertOf(false), transparent: true, depthWrite: false,
    fragmentShader: `
      uniform vec3 uCool, uWarm, uPeakC, uSelC; uniform float uGlow, uSweep, uSweepOn, uThrY, uTime; uniform vec4 uHover, uPick;
      uniform float uPingOn, uPingT, uBeatOn, uSpotD, uRingRed; uniform vec3 uPingC; uniform vec4 uSpot; uniform vec2 uPingO;
      varying float vHeat; varying float vSel; varying vec3 vP; varying float vBump; ${ramp}
      float sq(float x){ return x*x; }   // not pow(x, 2.): pow of a negative base is undefined in GLSL (NaN on some GPUs)
      void main(){
        float sel = vSel * above(vP.y);
        float sweep = exp(-sq((vP.x-uSweep)/.32))*uSweepOn;
        float hov = step(uHover.x,vP.x)*step(vP.x,uHover.y)*step(uHover.z,vP.z)*step(vP.z,uHover.w);
        hov = max(hov, step(uPick.x,vP.x)*step(vP.x,uPick.y)*step(uPick.z,vP.z)*step(vP.z,uPick.w));
        // sonar: at each data update a ring runs out over the grid from the origin cell (now, same meaning) and fades
        float age = uTime - uPingT, r = age * ${PING_SPEED.toFixed(2)};
        float ping = uPingOn * step(0., age) * step(age, ${PING_SEC.toFixed(2)}) * exp(-sq((length(vP.xz - uPingO) - r)/.22)) * (1. - age/${PING_SEC.toFixed(2)});
        float bage = mod(uTime, ${BEAT_SEC.toFixed(2)}), br = bage * ${BEAT_SPEED.toFixed(2)};
        float fade = max(0., 1. - bage/${RING_SEC.toFixed(2)});
        float beat = uBeatOn * exp(-sq((length(vP.xz) - br)/.32)) * fade;
        // the ring is cream; the ring that reaches the peak turns red there and runs on red to the edge
        float redK = uRingRed * smoothstep(uSpotD - .15, uSpotD + .35, br);
        vec3 ringC = mix(vec3(1., .93, .78), vec3(1., .16, .16), redK);
        // the peak: red where the ring that finds it has already passed (a thin front sweeping over it), then all red
        // sqrt: the whole zone of the peak, not only its tip. max(): far from the peak vBump underflows to 0 and the
        // GPU's interpolation along a line can take it a hair below, where sqrt is NaN: a black dashed circle around it
        float spot = sqrt(max(vBump, 0.)) * uSpot.z * uSpot.w;
        float far = 1.;  // no depth fade: in an orthographic view it reads as perspective and makes the far side look wider
        float a = uGlow*(.5+.9*max(vHeat, sel*.8))*far + sweep*.32 + hov*.6 + ping*.7 + beat*.75 + spot*.8;
        vec3 col = tint(vHeat, sel)*(1.+max(vHeat, sel*.7)*1.35+sweep*.25+hov) + uPingC*ping*.9;
        col = mix(col, ringC*1.25, clamp(beat*1.3, 0., 1.));   // the ring's own colour, not added light
        gl_FragColor = vec4(mix(col, vec3(1., .16, .16)*1.4, clamp(spot*2.2, 0., 1.)), clamp(a,0.,1.));
      }`,
  });
  const sheetMat = new THREE.ShaderMaterial({
    uniforms: U, vertexShader: vertOf(true), side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 4,   // keeps the dark sheet behind its own lines on steep slopes
    fragmentShader: `
      uniform vec3 uBg, uCool, uWarm, uPeakC, uSelC; uniform float uThrY;
      varying float vHeat; varying float vSel; varying vec3 vP; ${ramp}
      void main(){
        float sel = vSel * above(vP.y);
        vec3 c = uBg*1.2 + tint(vHeat, sel)*max(vHeat, sel*.7)*.14 + uSelC*sel*.22 + uCool*vP.y*.006;
        // dashed contour where the surface crosses the threshold: ~1.5 px wide, dashes of ~9 px on screen
        float d = abs(vP.y - uThrY) / clamp(fwidth(vP.y), 1e-4, .05);
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

  // the post-processing chain renders off screen, where the canvas's own antialiasing does not apply: without
  // multisampling there the 1 px lines break into stair steps ("torn fabric") wherever they run at a shallow angle
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {samples: MSAA, type: THREE.HalfFloatType}));
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
const DOCK_ZOOM = .62, DOCK_DROP = .05;   // DOCK_DROP: the view sits this share of the panel lower (the axes' labels hang below)               // the docked result panel is lower than the page: the view comes closer
let camAspect = 1;
const camTo = (name, duration = 1.25, ease = 'power3.inOut') =>
  gsap.to(cam, {...CAMS[name], duration: reduced ? 0 : duration, ease, overwrite: true});
let dragging = false;

const iDot = $('iDot');
function resize() {
  if (!ok) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h);
  camAspect = w / h;
}
function frame(t) {
  requestAnimationFrame(frame);
  const w = canvas.clientWidth, h = canvas.clientHeight, wide = w > 860;
  const docked = root.dataset.stage === 'result', off = docked ? 0 : cam.off;   // docked: the view is centred in its own panel
  U.uTime.value = reduced ? 0 : t / 1000;
  if (!reduced && root.dataset.stage === 'home') {    // the wordmark's dot flares on the beat, as the ring leaves the centre
    spotTick(U.uTime.value);
    const k = Math.exp(-(U.uTime.value % BEAT_SEC) * 1.6);
    iDot.style.opacity = (.5 + .5 * k).toFixed(3); iDot.style.transform = `scale(${(1 + .3 * k).toFixed(3)})`;
  }
  const az = cam.az, sp = Math.sin(cam.pol);  // no idle sway: the view stays exactly isometric
  const r = cam.r * (wide ? 1 : Math.min(2.15, Math.max(1, 1.38 / Math.max(.5, camAspect)))) * (docked ? DOCK_ZOOM : 1);
  // the view height at the target equals that of the old 34 degree lens at distance r, so framings carry over
  const hh = r * ORTHO_K;
  camera.left = -hh * camAspect; camera.right = hh * camAspect; camera.top = hh; camera.bottom = -hh;
  camera.position.set(cam.tx + r * sp * Math.sin(az), cam.ty + r * Math.cos(cam.pol), cam.tz + r * sp * Math.cos(az));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
  if (docked) camera.setViewOffset(w, h, 0, -h * DOCK_DROP, w, h);
  else if (wide) camera.setViewOffset(w, h, 0, -h * .055 * off, w, h);
  else camera.setViewOffset(w, h, 0, -h * .02 * off, w, h);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  faceAxes();
  composer.render();
  placeAxes(w, h);
  placePick(w, h);
  placeTick(w, h, t);
}

/* axis labels live in the DOM, projected from the floor; positions follow the edges the axes sit on */
const side = sx => sx < 0 ? 'r' : 'l';
const AXES = [
  {t: 'Time', p: (sx, sz) => [X(L / 2), 0, timeZ(sz) + sz * 1.15], a: () => 'c', title: 1},
  {t: 'Meaning gap', p: (sx, sz) => [gapX(sx) + sx * 1.35, 0, Z(M / 2)], a: side, title: 1},
  // tick labels: the local clock time of each label, counted back from the origin (filled by setOrigin)
  ...Array.from({length: L / LABEL_EVERY + 1}, (_, k) => ({t: '', tk: k,
    p: (sx, sz) => [X(k * LABEL_EVERY + tickPhase), 0, timeZ(sz) + sz * .4], a: () => 'c', k: 1})),
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
// the cell of the map under the pointer: {l (time bin), m (meaning-gap bin), x, z (floor point)}, or null
function cellAt(e) {
  const b = canvas.getBoundingClientRect();
  ndc.set((e.clientX - b.left) / b.width * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction; let hit = null;
  for (let s = 0; s < 70; s += .06) {  // orthographic: the ray starts at the near plane, up to ~45 from the scene
    const x = o.x + d.x * s, y = o.y + d.y * s, z = o.z + d.z * s, h = heightAt(x, z);
    if (h >= 0 && y <= h + .02) { hit = [x, z]; break; }
    if (y < -.2) break;
  }
  if (!hit) return null;
  const l = Math.floor(binU(hit[0])), m = Math.floor(binV(hit[1]));
  return l < 0 || m < 0 || l >= L || m >= M ? null : {l, m, x: hit[0], z: hit[1], h: heightAt(hit[0], hit[1])};
}
function hover(e) {
  const y = layers(shown());
  if (root.dataset.stage !== 'result' || dragging || !y) return hideTip();
  const c = cellAt(e);
  if (!c) return hideTip();
  const {l, m} = c, b = canvas.getBoundingClientRect();
  U.uHover.value.set(X(l), X(l + 1), Z(m + 1), Z(m));
  tip.innerHTML = `<b>${l * BIN_MIN}–${(l + 1) * BIN_MIN} min before ${nowText()}, meaning gap ${(m / M).toFixed(2)}–${((m + 1) / M).toFixed(2)}</b>
    <span>${y.sel[m][l]} this group, ${y.others[m][l]} other groups, ${y.rest[m][l]} background · ${cellDb(y, m, l)}</span>${thrNote(c)}`;
  const px = e.clientX - b.left, py = e.clientY - b.top;
  tip.style.transform = `translate(${Math.min(Math.max(8, px + 14), b.width - 256)}px,${Math.max(8, py - 66) + canvas.offsetTop}px)`;
  tip.style.opacity = 1;
}
// the coloured caps of the surface are the part above the detection threshold: the tooltip says so there
function thrNote(c) {
  if (S.thrY == null || c.h < S.thrY) return '';
  const i = Math.round((D / 2 - c.z) / D * (NZ - 1)) * NX + Math.round((c.x + W / 2) / W * (NX - 1));
  const mine = field.P[i] > field.O[i] + field.C[i];            // mostly the selected group's pairs: the accent cap
  return `<em class="thr">Above the detection threshold (mean + ${CFAR_K}σ = ${S.thrDb.toFixed(1)} dB): ${mine ? "this group's posts stand" : 'posts stand'} out from the noise here.</em>`;
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
let downAt = null;                   // where a press began: a press that barely moves is a click on a cell
canvas.addEventListener('pointerdown', e => {
  if (root.dataset.stage !== 'result' || !ok) return;
  if (e.pointerType !== 'mouse') hover(e);
  downAt = [e.clientX, e.clientY];
  gsap.killTweensOf(cam); dragging = true; canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId);
});
const endDrag = e => {
  if (!dragging) return;
  dragging = false; canvas.classList.remove('dragging');
  const click = e?.type === 'pointerup' && downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 6;
  downAt = null;
  if (click) { pickCell(cellAt(e)); return; }   // a click leaves the view where it is
  gsap.to(cam, {az: isoSnap(cam.az), pol: ISO_POL, duration: reduced ? 0 : .5, ease: 'power2.out', overwrite: true});
};
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);

/* a clicked cell: a sonar ping runs out over the grid from it, and a card over the cell says in words what is
   there and what the selected group says at that time (the lines themselves are one step away, "What they say") */
const PAIR_MAX_SEC = 120;            // detect/timemap.py: pairs of posts at most 2 min apart; a pair sits at its later post
function pickCell(c) {
  if (!c || !layers(shown())) return unpick();
  S.pick = {l: c.l, m: c.m}; S.pop && closePop();
  U.uPick.value.set(X(c.l), X(c.l + 1), Z(c.m + 1), Z(c.m));
  hideTip(); showCell();
}
function unpick() {
  S.pick = null; picked++;
  if (U) U.uPick.value.set(9, 9, 9, 9);
  $('pick').innerHTML = '';
}
/* an antenna stands where the time and meaning axes meet (just outside the map's origin, where the sonar starts). It fills from the ground up
   while the radar waits for the next update (the update clock above); full = the update is called and the sonar fires */
const tickEl = $('tick'), tickFill = $('tickFill'), tickV = new THREE.Vector3();
function placeTick(w, h, t) {
  const on = root.dataset.stage === 'result';
  tickEl.style.display = on ? '' : 'none';
  if (!on) return;
  U.uPingO.value.set(gapX(axSide.x), timeZ(axSide.z));   // the sonar leaves from the antenna, whichever corner the axes face
  tickV.set(U.uPingO.value.x, 0, U.uPingO.value.y).project(camera);   // where the two floor axes would meet if extended: off the surface
  const x = (tickV.x * .5 + .5) * w, y = (-tickV.y * .5 + .5) * h + canvas.offsetTop;
  tickEl.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;   // its foot on the origin
  const p = Math.min(1, Math.max(0, (t - clock.at) / clock.ms));
  tickFill.setAttribute('y', (32 * (1 - p)).toFixed(2)); tickFill.setAttribute('height', (32 * p).toFixed(2));
  tickEl.dataset.title = `Next update in ${Math.max(0, Math.ceil((clock.ms - (t - clock.at)) / 1000))} s`;
}
// the card sits over the top of the picked cell's column; frame() keeps it there while the view moves
const pickV = new THREE.Vector3();
function placePick(w, h) {
  const el = $('pick');
  if (!S.pick || !el.innerHTML) return;
  const {l, m} = S.pick, top = heightAt(X(l + .5), Z(m + .5));
  pickV.set(X(l + .5), Math.max(0, top), Z(m + .5)).project(camera);
  const x = (pickV.x * .5 + .5) * w, y = (-pickV.y * .5 + .5) * h, below = y < 250;
  el.style.display = ''; el.dataset.below = below;
  el.style.transform = `translate(${Math.min(w - 156, Math.max(156, x)).toFixed(1)}px,${(y + canvas.offsetTop).toFixed(1)}px) translate(-50%,${below ? '14px' : 'calc(-100% - 12px)'})`;
}
const what = m => (m + 1) / M <= .3 ? 'Same message' : (m + 1) / M <= .6 ? 'Similar messages' : 'Different messages';
const nOf = (k, one, many) => `${k} ${k === 1 ? one : many}`;
let picked = 0;                      // token: a newer pick supersedes a card still loading its posts
async function showCell() {
  const y = layers(shown()), f = shown(), el = $('pick'), mine = ++picked;
  if (!S.pick || !y || !f) return unpick();
  const {l, m} = S.pick, sel = y.sel[m][l], others = y.others[m][l], rest = y.rest[m][l];
  const t1 = originMs() - l * BIN_MS, t0 = t1 - BIN_MS;      // the cell's time bin, of the pair's later post
  const when = `${l * BIN_MIN}–${(l + 1) * BIN_MIN} min before ${nowText()}`;
  const db = cellDb(y, m, l);
  const text = said => `<b>${what(m)}, ${when}</b><span>${sel
    ? `${nOf(sel, 'pair', 'pairs')} of this group's posts here, at most ${PAIR_MAX_SEC / 60} min apart`
    : 'No pairs of this group here'}${others ? `; ${others} of other groups` : ''}${rest ? `; ${rest} background` : ''}.` +
    `${db === 'no pairs' ? '' : ` ${db[0].toUpperCase()}${db.slice(1)}.`}${said}</span>`;
  el.innerHTML = text('');
  if (!sel) return;
  let its;
  try { its = await loadItems(f); } catch { return; }
  if (mine !== picked) return;
  if (merged(f.accounts, its)) return;   // masked accounts cannot be told apart: no count per account
  // the group's posts in pairs that end in this time bin: the later post in it, its partner up to 2 min before
  const t = it => Date.parse(it.published_at);
  const keep = new Set();
  for (const a of its) {
    if (t(a) < t0 || t(a) >= t1) continue;
    for (const b of its) if (b.author !== a.author && t(b) <= t(a) && t(a) - t(b) <= PAIR_MAX_SEC * 1000) { keep.add(a); keep.add(b); }
  }
  const said = [...keep], lines = points(said).filter(p => p.accounts > 1).length;   // lines said by 2+ accounts
  if (!said.length) return;
  const who = `${new Set(said.map(it => it.author)).size} of ${f.accounts.length} accounts posted then`;
  el.innerHTML = text(` ${who}${lines ? `, repeating ${nOf(lines, 'line', 'lines')}` : ''}.`) +
    `<button type="button" class="say" data-say="${S.sel}">What they say</button>`;
}
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
  S.pop = null; unpick(); closeSheets();
  S.sel = Math.max(0, S.list.findIndex(f => f.id === findingId));
  S.pickedWeak = S.list[S.sel]?.verdict !== 'coordinated' && !!findingId;
  scrollTw?.kill(); scrollTw = null; mapSeq++;
  S.tmap = null; S.mapAt = null; S.drawnAt = null; S.mapPending = false; S.view = 0;
  setMapAt(rewindFor(shown()));  // the opened group on screen from the start (rewound if it is older than the map)
  history.replaceState(null, '', `?q=${encodeURIComponent(topic)}`);
  tl?.kill(); selTl?.kill();
  root.dataset.stage = 'scan'; scrollTo(0, 0); hideTip();
  $('q').value = topicLabel(topic); $('q').blur(); syncClear(); fixTopic(true);
  if (!ok) return showResult(true);
  gsap.killTweensOf([U.uCarpet, U.uPeak, U.uNoise, U.uGlow, U.uSweep, U.uSweepOn, axisMat, cam]);
  gsap.to(U.uBeatOn, {value: 0, duration: .4, overwrite: true});   // the landing's sonar stops: the topic's own takes over
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
  dock(); resize(); renderLive();                  // the play button's label depends on the stage
  if (ok) U.uPingOn.value = reduced ? 0 : 1;
  const d = reduced || instant ? 0 : 1;
  gsap.to('#pipe', {autoAlpha: 0, duration: .25 * d});
  gsap.fromTo('#vTitle', {autoAlpha: 0, y: 14}, {autoAlpha: 1, y: 0, duration: .45 * d, ease: 'power3.out'});
  gsap.fromTo('#groups', {autoAlpha: 0, y: 10}, {autoAlpha: 1, y: 0, duration: .45 * d, delay: .04 * d, ease: 'power3.out'});
  gsap.fromTo('#gLine', {autoAlpha: 0, y: 8}, {autoAlpha: 1, y: 0, duration: .4 * d, delay: .06 * d, ease: 'power3.out'});
  gsap.fromTo('#viewbar', {autoAlpha: 0, y: 8}, {autoAlpha: 1, y: 0, duration: .45 * d, delay: .18 * d, ease: 'power3.out'});
  if (!ok) return;
  gsap.to('#axes', {opacity: 1, duration: .55 * d, delay: .2 * d});
  gsap.to(axisMat, {opacity: .9, duration: .55 * d, delay: .2 * d});
}
/* result view = three docked panels: the header, the 3D view under it, the view switch under that.
   The view's panel is the space between the two, measured (both change height with their content) */
function dock() {
  if (root.dataset.stage !== 'result') return;
  const s = stage.getBoundingClientRect();
  const top = $('vHead').getBoundingClientRect().bottom - s.top + 8, bot = s.bottom - $('viewbar').getBoundingClientRect().top + 8;
  stage.style.setProperty('--dock-top', `${Math.round(top)}px`);
  stage.style.setProperty('--dock-bot', `${Math.round(bot)}px`);
}
for (const el of [$('vHead'), $('viewbar'), stage]) new ResizeObserver(dock).observe(el);
// the sonar turns red while a swarm (a coordinated group with pairs on the map) is on screen
let pingRed = false;
function pingColour() {
  if (!ok) return;
  const f = shown(), y = layers(f), red = f?.verdict === 'coordinated' && !!y && sum(y.sel) > 0;
  if (red === pingRed) return;
  pingRed = red;
  const c = new THREE.Color(red ? PING_SWARM : PING_IDLE);
  gsap.to(U.uPingC.value, {r: c.r, g: c.g, b: c.b, duration: reduced ? 0 : .6, overwrite: true});
}
// the selected group's colour on the map (caps above the threshold, its contour, the threshold's label): the colour
// of its verdict, as in the title: a swarm in the accent, a suspicious group in yellow
const SEL_COLOUR = {coordinated: PAL.sel, watching: PAL.peak, organic: PAL.cool};
function selColour() {
  const f = shown(), hex = f ? SEL_COLOUR[heldByNews(f) ? 'watching' : f.verdict] : PAL.sel;
  stage.style.setProperty('--thr', hex);
  if (!ok) return;
  const c = new THREE.Color(hex);
  gsap.to(U.uSelC.value, {r: c.r, g: c.g, b: c.b, duration: reduced ? 0 : .4, overwrite: true});
}
function goHome() {
  liveStop();
  scrollTw?.kill(); scrollTw = null;                 // a rewind still scrolling would bring the threshold back
  tl?.kill(); selTl?.kill();
  gsap.killTweensOf('#pipe,#pipeNow,#vTitle,#groups,#gLine,#viewbar,#axes');
  S.pop = null; unpick(); closeSheets();
  S.topic = null; history.replaceState(null, '', location.pathname);
  root.dataset.stage = 'home'; scrollTo(0, 0);
  fixTopic(false); $('q').value = ''; syncClear(); $('q').focus();
  renderHome(); renderLive();
  if (!ok) return;
  const d = reduced ? 0 : 1;
  gsap.to('#pipe', {autoAlpha: 0, duration: .22 * d});
  gsap.to([U.uCarpet, U.uPeak], {value: 0, duration: .85 * d, ease: 'power3.inOut', overwrite: true});
  gsap.to(U.uNoise, {value: 1, duration: .85 * d, overwrite: true});
  gsap.to(U.uGlow, {value: .3, duration: .85 * d, overwrite: true});
  gsap.to(axisMat, {opacity: 0, duration: .25 * d, overwrite: true});
  gsap.to('#axes', {opacity: 0, duration: .25 * d, overwrite: true});
  U.uThrY.value = 1e3;                               // the landing shows only the moving surface: no threshold contour
  U.uPingOn.value = 0;
  gsap.to(U.uBeatOn, {value: reduced ? 0 : 1, duration: .6 * d, overwrite: true});   // the landing's sonar comes back
  gsap.set(U.uSweepOn, {value: 0}); bloom.strength = .38;
  camTo('home', 1.1); hideTip(); resize();
}

/* ------------------------------------------------------------------ result copy */
const VERDICT = {
  coordinated: {title: 'Swarm Detected', light: '🔴'},
  watching: {title: 'Suspicious', light: '🟡'},
  organic: {title: 'Organic', light: '🟢'},
};
const dot = v => `<i class="dot" data-v="${v}"></i>`;

// The verdict in words: title, one sentence and the risk line with Pfa and SNR. The title and the sentence
// sit in the "Why" panel of the group, the risk line on top of its "How we got here" sheet.
function verdictCopy(f) {
  const weak = S.list.filter(g => g.verdict !== 'coordinated').length;
  if (!f) return {v: 'organic', title: 'Quiet',
    text: weak
      ? `No coordinated group in the last ${WINDOW_HOURS} h of ${topicLabel(S.topic)}; ${weak} weaker look-alike group${weak === 1 ? ' stays' : 's stay'} below the alert threshold.`
      : `No groups of look-alike accounts in the last ${WINDOW_HOURS} h of ${topicLabel(S.topic)}.`,
    risk: `🟢 Nothing above the detector threshold. <small>${pfaText()}</small>`};
  const hit = f.verdict === 'coordinated', n = f.accounts.length;
  const snr = f.snr_db_single != null ? `SNR ${f.snr_db_single.toFixed(1)} → ${f.snr_db.toFixed(1)} dB` : `SNR ${f.snr_db.toFixed(1)} dB`;
  return {v: f.verdict, title: VERDICT[f.verdict].title,
    text: hit && f.explanation?.summary ? f.explanation.summary
      : hit ? `${n} accounts posted near-identical messages close together in time.`
      : f.verdict === 'watching' ? `${n} accounts look alike, but the evidence is not strong enough yet.`
      : `${n} accounts: similar topic, but no coordination signal.`,
    risk: (hit ? `🔴 ${n} accounts are saying the same thing almost simultaneously.`
      : f.verdict === 'watching' ? '🟡 Suspicious — not sure yet.' : '🟢 Looks organic.') +
      ` <small>${pfaText()} · ${snr}</small>`};
}

/* the attack type of the selected group. It comes with the explanation, which the worker requests only for
   coordinated groups: a possible group says it is not assessed; a coordinated group without one shows nothing */
function attackType(g) {
  const t = g.verdict === 'coordinated' ? g.explanation?.technique : null;
  const text = t ? esc(t) : g.verdict === 'watching' && !heldByNews(g) ? 'not assessed yet' : '';
  return text ? `<span class="kind"><span>Attack type</span>${text}</span>` : '';
}

function render() {
  pingColour(); selColour();
  renderTitle();
  if (pressed) headDue = true; else freshHead();    // never rebuilt under a press (map reloads come every ~20 s)
  if (S.pick) showCell();                           // the picked cell's card follows the new numbers
  if (!$('says').open && !$('posts').open) shownPoints.clear();   // nothing on screen refers to them any more
}

/* the big verdict over the group picker, in the verdict's colour: Quiet, a possible group (yellow), or a
   coordinated one in the accent ("Swarm Detected"); its attack type heads the Why panel, not the title */
function renderTitle() {
  const f = shown(), c = verdictCopy(f), vt = $('vTitle');
  vt.dataset.v = f ? f.verdict : 'quiet';
  vt.textContent = c.title;   // always the verdict; the attack type heads the Why panel (whyHTML)
}
/* the header: one tab per group (the letter it carries everywhere), or one dropdown when there are more than
   MAX_TABS; under it the shown group's line. The tabs stay even for one group: they carry its verdict mark.
   */
function renderHead() {
  const f = shown();
  // which group is shown is picked on the timeline in the footer (renderStrip)
  // the shown group: attack type, then Why (panel), What they say and How we got here (sheets); a rewound map can go back to now
  const why = `<button type="button" data-pop="why" aria-controls="pop" aria-expanded="${S.pop === 'why'}">Why</button>`;
  setHTML($('gLine'), !S.topic ? '' : !f ? why
    : `${f.verdict === 'coordinated' ? '' : attackType(f)}${f.synthetic ? `<span class="sim">${SIM}</span>` : ''}${why}
    <button type="button" data-say="${S.sel}">What they say</button>
    <button type="button" data-how="${S.sel}">How we got here</button>`);
  $('pop').hidden = !S.pop;
  setHTML($('pop'), S.pop === 'why' ? whyHTML(f) : '');
  renderStrip();
}
/* the footer timeline: every group of the topic at its time over the detector window; the bracket = the map's span */
const strip = createStrip({el: $('strip'), onPick: k => select(k), onTime: timeTo, onNow: goLive});
function renderStrip() {
  if (!S.topic) return strip.set(null);
  const f = shown(), t1 = Date.now();
  const t0 = Math.min(t1 - WINDOW_HOURS * 3600e3, ...S.list.map(g => Date.parse(g.first_seen)));
  const marks = S.list.map((g, k) => ({k, start: Date.parse(g.first_seen), end: Date.parse(g.last_seen),
    verdict: heldByNews(g) ? 'watching' : g.verdict, sel: g === f,
    title: `${g.accounts.length} accounts · ${verdictLabel(g)} · ${span(g)} UTC${g.synthetic ? ` · ${SIM}` : ''}`}));
  strip.set({t0, t1, marks, live: !S.mapAt, win: S.tmap ? [originMs() - L * BIN_MS, originMs()] : null});
}
// empty time on the timeline: the map goes there (that moment in the middle of its 10 minutes), or back to live
function timeTo(t) {
  const at = t + L * BIN_MS / 2;
  if (at >= Date.now() - BIN_MS) goLive(); else setMapAt(new Date(at).toISOString());
}
// sets an element's HTML only when it differs: a rebuild loses the focus and swallows a click in progress
function setHTML(el, html) {
  const t = document.createElement('template'); t.innerHTML = html;
  const n = t.content.childNodes;
  if (n.length !== el.childNodes.length || ![...n].every((c, i) => c.isEqualNode(el.childNodes[i]))) el.replaceChildren(t.content);
}
// the attack types the explanation may name (ingest/explain.py TECHNIQUES), each with what it means in one line
const TECHNIQUE_INFO = {
  'fear appeal': 'Scares readers so they react before they think: danger, threat, "it could be you next".',
  'call to action': 'Tells readers what to do right now: share, sign, boycott, show up, demand.',
  'conspiracy / hidden truth': 'Claims a secret plot or a truth "they" hide, which only this message reveals.',
  'loaded language': 'Emotional, charged words that push a judgement instead of stating facts.',
  'bandwagon': '"Everyone already agrees": pressure to join the side that looks like the majority.',
  'discrediting': 'Attacks the people or institutions involved instead of their arguments.',
  'exaggeration': 'Blows the facts up: bigger numbers, worse outcomes, "the worst ever".',
  'whataboutism': 'Deflects criticism by pointing at someone else\'s wrongdoing.',
};
// the Why panel's heading for a coordinated group: its attack type(s) with a short meaning; "other" and unknown labels are left out
function attackHTML(f) {
  const t = f?.verdict === 'coordinated' ? f.explanation?.technique : null;
  if (!t) return '';
  const known = [...new Set(t.toLowerCase().split(' + ').map(s => s.trim()))].filter(s => TECHNIQUE_INFO[s]);
  return known.map(s => `<div class="atk"><b><span>Attack type</span>${esc(s[0].toUpperCase() + s.slice(1))}</b><p>${esc(TECHNIQUE_INFO[s])}</p></div>`).join('');
}
// "Why": the attack type (coordinated, once explained), the verdict of the shown group in a sentence,
// then what made it stand out, one phrase per detector step
function whyHTML(f) {
  const c = verdictCopy(f);
  return attackHTML(f) + `<p>${esc(c.text)}</p>` +
    (f ? `<ul>${reasons(f).map(r => `<li>${esc(r)}</li>`).join('')}</ul>${f.note ? `<p class="note">${esc(f.note)}</p>` : ''}`
      : `<p class="risk">${c.risk}</p>`);
}

/* the header with the new facts. Never rebuilt under a press, which would swallow its click: it waits for the release */
let pressed = false, headDue = false;
function freshHead() {
  const focus = document.activeElement?.closest?.('#vHead [data-pop],#vHead [data-g]');   // the header is rebuilt: keep the focus
  renderHead();
  if (focus) $('vHead').querySelector(focus.dataset.pop ? `[data-pop="${focus.dataset.pop}"]` : `[data-g="${focus.dataset.g}"]`)?.focus();
}
addEventListener('pointerdown', () => { pressed = true; }, true);
for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => {
  pressed = false;
  if (headDue) setTimeout(() => { if (headDue && !pressed) { headDue = false; freshHead(); } });   // after the click itself
}, true);

/** The group's posts, fetched once and cached (at most 200 ids per request, as the API allows). */
const ITEMS_PER_CALL = 200;                          // the API's limit of ids per /api/items request
async function loadItems(f) {
  const want = f.item_ids.filter(i => !S.items.has(i));
  for (let k = 0; k < want.length; k += ITEMS_PER_CALL) {   // a big group: one call per 200 ids, not one cut-off call
    const ids = want.slice(k, k + ITEMS_PER_CALL);
    for (const it of await api(`/api/items?ids=${ids.map(encodeURIComponent).join(',')}`)) S.items.set(it.id, it);
  }
  return f.item_ids.map(i => S.items.get(i)).filter(Boolean);
}

/* one point a group makes. It opens a window of its own with the posts grouped under it: the point stays
   fixed at the top while the posts scroll, so the grouping can always be checked against it. */
const shownPoints = new Map();                      // id on the button -> {point, accounts in the group (null: they cannot be told apart), letter}
const posts = k => `${k} ${k === 1 ? 'post' : 'posts'}`;
/* one header for every sheet: a Back button that shrinks to its arrow once the sheet scrolls, the group's letter, the title */
const sheetTop = (title, letter) => `<header class="howtop"><button type="button" class="hback" data-close><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Back</span></button>${letter ? `<span class="tag">${letter}</span>` : ''}<h2>${title}</h2></header>`;
function sheetOpen(dlg) { if (!dlg.open) dlg.showModal(); dlg.scrollTop = 0; dlg.classList.remove('scrolled'); }
// "More": the list shows its first SHOWN rows; the button reveals the rest (and goes away)
const moreHTML = n => n > SHOWN ? `<button type="button" class="more-btn" data-more>${n - SHOWN} more</button>` : '';
// a clamped text that does not fit gets its "Read more" toggle (measured after layout)
function markLong(root) {
  requestAnimationFrame(() => root.querySelectorAll('.posts li:not(.measured) .clip').forEach(c => {
    const li = c.closest('li');
    li.classList.toggle('long', c.scrollHeight > c.clientHeight + 1); li.classList.add('measured');
  }));
}
let pointId = 0;
function pointHTML(p, n, letter) {
  shownPoints.set(++pointId, {p, n, letter});
  return `<li><button type="button" data-point="${pointId}"><span class="clip">${esc(p.text)}</span><small>${n == null ? posts(p.posts) : `${p.accounts} of ${n} accounts${p.posts > p.accounts ? ` · ${p.posts} posts` : ''}`}</small></button></li>`;
}
/* the posts under a point arrive a page at a time while the sheet scrolls: when the footer under the list
   (skeleton rows) comes within 200 px of the sheet's bottom edge the next page is added; at the end a quiet
   line says all are shown. A scroll check, not an IntersectionObserver: created in the same task as
   showModal() the observer never reported in Chromium */
const PAGE = 10;
let pager = null;                                   // the open sheet's "load more" check: dropped on close or a new point
const postHTML = it => `<li><small>${esc(handle(it.author))} · ${hm(it.published_at)} UTC${it.platform ? ' · ' + esc(platformLabel(it.platform)) : ''}${it.synthetic ? `<span class="syn">${SIM}</span>` : ''}</small><span class="clip">${esc(it.text)}</span><button type="button" class="rm" data-expand>Read more</button>${/^https?:\/\//i.test(it.url ?? '') ? ` <a href="${esc(it.url)}" target="_blank" rel="noopener">source</a>` : ''}</li>`;
function stopPaging() { if (pager) $('posts').removeEventListener('scroll', pager); pager = null; }
function showPosts(id) {
  const s = shownPoints.get(id), dlg = $('posts');
  if (!s) return;
  const {p, n, letter} = s, items = p.items;
  stopPaging();
  dlg.innerHTML = `${sheetTop(`${posts(p.posts)}${n == null ? '' : `<small>${p.accounts} of ${n} accounts</small>`}`, letter)}
    <p class="frozen">${esc(p.text)}</p>
    <ul class="posts"></ul>
    <div class="pager" aria-live="polite"></div>`;
  const list = dlg.querySelector('.posts'), foot = dlg.querySelector('.pager');
  let shown = 0;
  const next = () => {
    const batch = items.slice(shown, shown + PAGE);
    list.insertAdjacentHTML('beforeend', batch.map(postHTML).join(''));
    if (!reduced && shown) [...list.children].slice(shown).forEach((li, k) => li.animate(
      [{opacity: 0, transform: 'translateY(6px)'}, {opacity: 1, transform: 'none'}],
      {duration: 260, delay: 40 * k, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards'}));
    shown += batch.length;
    markLong(list);
    if (shown < items.length) {
      foot.innerHTML = `<div class="sk"></div><div class="sk"></div><div class="sk"></div><p>${shown} of ${items.length} posts</p>`;
    } else {
      stopPaging();
      foot.innerHTML = items.length > PAGE ? `<p>All ${items.length} posts shown</p>` : '';
    }
  };
  next();
  sheetOpen(dlg);
  if (shown < items.length) {
    const near = () => foot.getBoundingClientRect().top < dlg.getBoundingClientRect().bottom + 200;
    pager = () => { while (pager && near()) next(); };   // fills a tall sheet at once, then one page per scroll step
    dlg.addEventListener('scroll', pager, {passive: true});
    requestAnimationFrame(() => pager?.());
  }
}

/* "What they say": the group's joined message when the detector has one, then the lines it repeats */
const MAX_POINTS = 12, SHOWN = 3;                  // points (and posts) on screen; the rest behind "More"
let saying = 0;                                     // token: only the latest request may fill the sheet
async function showSays(k) {
  const f = S.list[k], dlg = $('says'), mine = ++saying;
  if (!f) return;
  const x = f.explanation, n = f.accounts.length;
  const head = sheetTop(`What they say<small>${n} accounts</small>`, LETTER(k)) +
    (x ? `<p class="lead">${esc(x.summary)}</p><blockquote>“${esc(x.quote)}”</blockquote>${f.verdict === 'coordinated' && x.technique.toLowerCase() !== 'other' ? `<p class="foot">Attack type: ${esc(x.technique)}, ${Math.round(x.confidence * 100)}% confidence</p>` : ''}` : '');
  dlg.innerHTML = head + '<p class="foot">Loading posts…</p>';
  sheetOpen(dlg);
  let its;
  try { its = await loadItems(f); }
  catch (e) { if (mine === saying) dlg.innerHTML = head + `<p class="foot">Could not load posts (${esc(e.message)}).</p>`; return; }
  if (mine !== saying || !dlg.open) return;          // superseded, or closed meanwhile
  const all = points(its), top = all.slice(0, MAX_POINTS);
  dlg.innerHTML = head + `<h3>Points they make</h3>
    <ol class="points">${top.map(p => pointHTML(p, merged(f.accounts, its) ? null : n, LETTER(k))).join('')}</ol>${moreHTML(top.length)}
    <p class="foot">Grouped by shared wording across ${its.length} posts. Select a point to read them.${all.length > top.length ? ` ${all.length - top.length} rarer points hidden.` : ''}</p>`;
}

/* "How we got here": the risk line, then the detector's steps for one group (steps.js), in a sheet like
   "What they say"; the same steps open as a page of their own at /explain, for a link to one group */
let howing = 0;                                     // token: only the latest request may fill the sheet
async function showHow(k) {
  const f = S.list[k], dlg = $('how'), mine = ++howing;
  if (!f) return;
  // one title, one close button, one sentence of what was found: the steps below say the rest
  const say = verdictCopy(f).risk.replace(/^\S+\s/, '').replace(/\s*<small>[\s\S]*<\/small>/, '');
  const head = `${sheetTop('How we got here')}
    <p class="lead">${say}</p>`;
  dlg.innerHTML = head + '<p class="foot">Loading posts…</p>';
  sheetOpen(dlg);
  let its = [];
  try { its = await loadItems(f); } catch (e) { console.warn('items', e); }   // the steps still draw without the posts
  if (mine !== howing || !dlg.open) return;
  dlg.innerHTML = head + `<div class="steps">${stepsHTML(f, its, S.points, S.alpha)}</div>`;
  wireSteps(dlg);
  dlg.scrollTop = 0; dlg.classList.remove('scrolled');
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
// S.mapAt = the moment asked for, S.drawnAt = the moment of the map on screen (null = live). They differ only
// while a setMapAt request is in flight (S.mapPending); a failure goes back to what is drawn.
async function setMapAt(at) {
  if (at === S.mapAt && at === S.drawnAt && S.tmap && !S.mapPending) return;
  S.mapAt = at; S.mapPending = true; hideTip(); if (S.pick) unpick();
  const topic = S.topic, asked = S.alpha, seq = ++mapSeq;
  const target = at ? Date.parse(at) : Date.now(), from = S.tmap ? originMs() : target;
  const end = Math.max(from, target), live = !at;
  const minutes = Math.min(1440, Math.ceil(L * BIN_MIN + Math.abs(target - from) / 60000) + 1);
  let r;
  try {
    r = await api(`/api/timemap?topic=${encodeURIComponent(topic)}&minutes=${minutes}` +
      `${asked === DESIGN_ALPHA ? '' : `&alpha=${asked}`}${live ? '' : `&at=${encodeURIComponent(new Date(end).toISOString())}`}`);
  } catch (e) {
    console.warn('timemap', e);
    if (seq === mapSeq) { S.mapAt = S.drawnAt; S.mapPending = false; }  // state = what is drawn (no map yet: refresh retries)
    return;
  }
  if (seq !== mapSeq) return;  // a newer request owns the state
  if (S.topic !== topic || S.alpha !== asked) { S.mapAt = S.drawnAt; S.mapPending = false; return; }
  S.mapPending = false; S.drawnAt = at;
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
  S.sel = i; S.pickedWeak = S.list[i]?.verdict !== 'coordinated'; S.pop = null; hideTip(); unpick(); selTl?.kill();
  setMapAt(rewindFor(shown()));
  const d = reduced || instant ? 0 : 1;
  selTl = gsap.timeline().to('#vTitle,#gLine', {autoAlpha: 0, duration: .14 * d}).call(render).to('#vTitle,#gLine', {autoAlpha: 1, duration: .26 * d});
  if (!ok) return;
  setField(shown());  // the surface stays as it is: only the accent colour moves to the picked group
  camTo('over', 1.3 * d);
}
// on a topic's screen the field is the topic's name, fixed: no typing, no suggestions. Another topic = back home first
function fixTopic(on) {
  const q = $('q');
  q.readOnly = on; q.tabIndex = on ? -1 : 0;
  if (on) suggest(false);
}
function syncClear() { $('clear').classList.toggle('visible', $('q').value.length > 0); }

/* ------------------------------------------------------------------ home: topics + feed */
/* home: the topic picker under the search field: the monitored topics, then the latest alerts, filtered as you type */
let sugItems = [], sugAt = -1;                       // the options on screen ({topic, fid?}) and the highlighted one
let sugAll = false;                                  // "Show all N topics" pressed: every matching topic, the list scrolls
const SUG_TOPICS = 5, SUG_ALERTS = 5;                // any number of topics: the 5 most recently active (or best matching) ones
function renderHome() { if (!$('suggest').hidden) renderSuggest(); }
// every typed word must appear in the topic's name (or its id), in any order
const topicHit = typed => {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  return t => { const name = `${topicLabel(t).toLowerCase()} ${t}`; return words.every(w => name.includes(w)); };
};
// the topics that match, most recently active first (their newest finding), then the rest in the API's order
function matchTopics(typed) {
  const hit = topicHit(typed), last = new Map();
  for (const f of S.findings) if (f.created_at > (last.get(f.topic) ?? '')) last.set(f.topic, f.created_at);
  return S.topics.filter(hit).map((t, i) => ({t, i})).sort((a, b) => (last.get(b.t) ?? '').localeCompare(last.get(a.t) ?? '') || a.i - b.i).map(o => o.t);
}
function renderSuggest() {
  const typed = $('q').value.trim(), hit = topicHit(typed);
  const last = new Map();                            // topic -> its newest finding's time (the detector's last run there)
  for (const f of S.findings) if (f.created_at > (last.get(f.topic) ?? '')) last.set(f.topic, f.created_at);
  const count = t => S.findings.filter(f => f.topic === t && f.verdict === 'coordinated').length;
  const all = matchTopics(typed);
  const topics = sugAll ? all : all.slice(0, SUG_TOPICS), more = all.length - topics.length;
  const alerts = S.findings.filter(f => f.verdict !== 'organic' && S.topics.includes(f.topic) && hit(f.topic))
    .sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || b.created_at.localeCompare(a.created_at)).slice(0, SUG_ALERTS);
  sugItems = [...topics.map(t => ({topic: t})), ...alerts.map(f => ({topic: f.topic, fid: f.id}))];
  sugAt = Math.min(sugAt, sugItems.length - 1);
  let i = 0;
  const opt = html => { const k = i++; return `<button type="button" class="opt" role="option" id="sug${k}" data-i="${k}" aria-selected="${k === sugAt}">${html}</button>`; };
  $('suggest').innerHTML =
    (topics.length ? '<h3>Topics</h3>' + topics.map(t => opt(`<b>${esc(topicLabel(t))}</b>${count(t) ? `<span class="n" title="Swarms detected">${count(t)}</span>` : ''}${last.has(t) ? `<span class="t" title="Last detector run with a finding">${ago(last.get(t))}</span>` : ''}`)).join('') +
      (more ? `<button type="button" class="more" data-all>Show all ${all.length} topics <span>+${more}</span></button>`
        : sugAll && all.length > SUG_TOPICS ? '<button type="button" class="more" data-fewer>Show fewer</button>' : '') : '') +
    (alerts.length ? '<h3>Latest alerts</h3>' + alerts.map(f => opt(`${dot(f.verdict)}<span>${VERDICT[f.verdict].title}</span>
      <span class="m">${esc(topicLabel(f.topic))} · ${f.accounts.length} accounts${f.synthetic ? ` · ${SIM}` : ''}</span><span class="t">${ago(f.created_at)}</span>`)).join('') : '') ||
    `<p class="none">No monitored topic matches “${esc(typed)}”.</p>`;
  if (sugAt >= 0) { $('q').setAttribute('aria-activedescendant', `sug${sugAt}`); $(`sug${sugAt}`)?.scrollIntoView({block: 'nearest'}); }
  else $('q').removeAttribute('aria-activedescendant');
}
// the list never runs past the bottom of the window: its height is what is left under the field (440 px at most)
function fitSuggest() {
  const s = $('suggest'), top = s.getBoundingClientRect().top;
  s.style.maxHeight = `${Math.round(Math.max(160, Math.min(440, innerHeight - top - 16)))}px`;
}
addEventListener('resize', () => { if (!$('suggest').hidden) fitSuggest(); });
function suggest(on) {
  on &&= root.dataset.stage === 'home';
  $('suggest').hidden = !on; $('q').setAttribute('aria-expanded', on);
  if (on) { renderSuggest(); fitSuggest(); } else { sugAt = -1; sugAll = false; }
}
// picking fills the field; the check itself starts with Play (or Enter). An alert remembers its group for that
let pickedFid = null;
function pickSuggest(i) {
  const it = sugItems[i];
  if (!it) return;
  suggest(false);
  $('q').value = topicLabel(it.topic); syncClear();
  pickedFid = it.fid ? {topic: it.topic, id: it.fid} : null;
  $('playBtn').focus();
}

/* ------------------------------------------------------------------ data */
// one sonar ring from the map's origin (result view), the moment the radar asks for new data
function pulse() {
  if (ok && !reduced) U.uPingT.value = U.uTime.value;
  tickEl.classList.remove('emit'); void tickEl.getBoundingClientRect(); tickEl.classList.add('emit');
}

/* One clock for all updates. The antenna at the map's origin fills up over the wait; when it is full the update is
   called and the sonar fires, in that same moment: every live frame (10 s) while scanning, every poll (15 s) when not */
const clock = {at: performance.now(), ms: POLL_MS, timer: 0};
function schedule(ms) {
  clearTimeout(clock.timer);
  clock.at = performance.now(); clock.ms = ms;
  clock.timer = setTimeout(update, ms);
}
async function update() {
  const L = S.live;
  if (root.dataset.stage === 'result') pulse();
  schedule(L?.session ? LIVE_MS : POLL_MS);           // the next wait starts now, so the antenna fills at an even pace
  if (L?.session) await liveTick(L); else await refresh();
}
async function refresh() {
  try {
    const asked = S.alpha;
    const r = await api(asked === DESIGN_ALPHA ? '/api/alerts' : `/api/alerts?alpha=${asked}`);
    if (asked !== S.alpha) return false;  // the selector changed while this request was in flight
    S.findings = r.findings; S.lastPoll = r.last_poll_at;
  } catch (e) { console.warn('alerts', e); return false; }
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
      if (!S.tmap || (shown()?.id !== cur && want !== S.mapAt)) setMapAt(want);  // a new group on screen (or no map yet)
      else if (!S.drawnAt) glideMap(); else loadMap();
    } else if (!S.tmap) { if (!S.mapPending) setMapAt(rewindFor(shown())); }  // the first map never arrived: retry it
    else if (!S.drawnAt) glideMap();                 // live: every pulse moves the map on to "now", gliding
    else if (S.list.some(f => !S.tmap.groups[f.id])) loadMap();  // a rewound map stays put (new groups only)
  }
  return true;
}

// time x meaning map of the open topic, live or rewound; the scene shows a flat floor until it arrives
// the time axis: every label is a local clock time, counted back from the moment on screen (the origin)
// the labels and the big ticks sit on round clock times (every LABEL_EVERY bins) and move with the surface:
// tickPhase = bins from the origin to the newest labelled time, so a time stays attached to its column
const setOrigin = () => {
  const step = LABEL_EVERY * BIN_MS, o = S.tmap ? originMs() : 0, anchor = Math.floor(o / step) * step;
  const phase = S.tmap ? (o - anchor) / BIN_MS : 0;
  if (Math.abs(phase - tickPhase) > 1e-3) { tickPhase = phase; if (axGeo) drawAxes(); }
  for (const d of AXES) if (d.tk != null) {
    const u = d.tk * LABEL_EVERY + tickPhase;
    d.el.style.visibility = u > L + 1e-6 ? 'hidden' : '';
    d.el.textContent = S.tmap ? localHM(anchor - d.tk * step) : (d.tk ? '' : 'now');
  }
  renderStrip();
};
function showMap() {
  setOrigin();
  if (ok) setField(shown());
  if (root.dataset.stage === 'result') render();
}
// periodic reload of the current map: live = the last L bins, rewound = the same map again (new groups)
async function loadMap() {
  const topic = S.topic, asked = S.alpha, seq = mapSeq, base = S.tmap, rewound = !!(S.drawnAt && base);
  if (!topic || !base || S.mapBusy || S.mapPending || scrollTw) return;  // no map yet: refresh goes through setMapAt
  S.mapBusy = true;
  try {
    const r = await api(`/api/timemap?topic=${encodeURIComponent(topic)}` +
      `&minutes=${rewound ? S.tmap.n_bins * BIN_MIN : L * BIN_MIN}${asked === DESIGN_ALPHA ? '' : `&alpha=${asked}`}` +
      `${rewound ? `&at=${encodeURIComponent(S.tmap.now)}` : ''}`);
    if (seq !== mapSeq || S.tmap !== base || S.mapPending || scrollTw || S.topic !== topic || S.alpha !== asked) return;
    if (!rewound) S.view = 0;
    S.tmap = r; showMap();
  } catch (e) { console.warn('timemap', e); }
  finally { S.mapBusy = false; }
}

/* Live map: the surface drifts toward the past at real time (the origin is the clock's "now", one bin per 30 s),
   and every pulse (10 s scanning, 15 s polling) only refreshes the data under it. The map is fetched up to the last
   whole 30 s boundary, so its bins never re-phase between fetches: a post keeps its place and its clock time.
   S.view = -(now - map end) / bin, so screen column u always shows "u bins before now" */
const DRIFT_MS = 125;                                // 8 frames a second: 1/240 of a bin per frame
let driftK = null;                                   // the height scale, eased toward each new map's own scale
const alignedNow = () => new Date(Math.floor(Date.now() / BIN_MS) * BIN_MS).toISOString();
function driftView() { return -(Date.now() - Date.parse(S.tmap.now)) / BIN_MS; }
function drift() {
  if (root.dataset.stage !== 'result' || !S.tmap || S.drawnAt || scrollTw || S.mapPending) return;
  S.view = driftView();
  if (!ok) { setOrigin(); return; }
  const kNew = scaleOf(sample(shown()));
  driftK = driftK == null ? kNew : driftK + (kNew - driftK) * .15;
  setField(shown(), driftK); setOrigin();
}
setInterval(() => { if (!reduced) drift(); }, DRIFT_MS);
async function glideMap() {
  const topic = S.topic, asked = S.alpha, seq = mapSeq, base = S.tmap;
  if (!topic || !base || S.drawnAt || S.mapBusy || S.mapPending || scrollTw) return;
  S.mapBusy = true;
  try {
    const r = await api(`/api/timemap?topic=${encodeURIComponent(topic)}&minutes=${L * BIN_MIN + 2 * BIN_MIN}` +
      `&at=${encodeURIComponent(alignedNow())}${asked === DESIGN_ALPHA ? '' : `&alpha=${asked}`}`);
    if (seq !== mapSeq || S.tmap !== base || S.drawnAt || S.mapPending || scrollTw || S.topic !== topic || S.alpha !== asked) return;
    S.tmap = r;
    if (reduced) { S.view = driftView(); showMap(); return; }   // no drift: the surface moves on with each pulse
    drift(); render();
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
  update();                                           // the scan runs on the update clock from now on
}

function liveStop(msg) {
  const L = S.live;
  if (!L) return;
  S.live = null;
  if (L.session) closeSession(L.session);
  schedule(POLL_MS);                                  // back to polling, counted from now
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
    if (frames.length) {
      const f = frames.at(-1);
      L.frame = f; L.since = f.at;
    }
    if (!(await refresh())) throw new Error('alerts unavailable');
    L.error = null;
  } catch (e) {
    L.error = `connection problem (${e.message}), retrying…`;
  } finally {
    L.busy = false;
    if (S.live === L) renderLive();
  }
}

// the player controls in the search field: play checks the topic (or resumes its scan), pause pauses the scan
function renderLive() {
  const btn = $('playBtn'), on = !!S.live;
  btn.dataset.state = on ? 'pause' : 'play';
  btn.type = on ? 'button' : 'submit';
  const label = on ? 'Pause the live scan' : S.topic && root.dataset.stage === 'result' && sameTopic() ? 'Resume the live scan' : 'Check';
  btn.setAttribute('aria-label', label); btn.title = label;
}
// the search field still names the open topic: play resumes it instead of checking a new one
const sameTopic = () => !!S.topic && root.dataset.stage !== 'home';   // the topic's screen: play resumes its scan

/* ------------------------------------------------------------------ wiring */
$('q').addEventListener('input', syncClear);
$('search').addEventListener('submit', e => {
  e.preventDefault();
  if (root.dataset.stage !== 'home') return;        // the topic is fixed on its screen: Enter does not check it again
  const q = $('q').value.trim();
  if (!q) return;
  const lq = q.toLowerCase();
  const t = S.topics.find(t => t === q || topicLabel(t).toLowerCase() === lq) ?? matchTopics(q)[0];   // else the first in the picker
  if (t) { const fid = pickedFid?.topic === t ? pickedFid.id : null; pickedFid = null; openTopic(t, fid ? {findingId: fid} : {}); } else { $('q').value = ''; $('q').placeholder = `Not monitored: ${q}`; syncClear(); }
});
// the picker opens on a click or on typing (not on the page's own focus), arrows move in it, Enter picks
// a press on the field opens the list; on an expanded list ("Show all") it folds back to the short one, still open
$('q').addEventListener('pointerdown', () => {
  if ($('q').readOnly) return;
  if ($('suggest').hidden) suggest(true);
  else if (sugAll) { sugAll = false; sugAt = -1; renderSuggest(); $('suggest').scrollTop = 0; }
});
$('q').addEventListener('input', () => { sugAt = -1; sugAll = false; pickedFid = null; suggest(true); $('suggest').scrollTop = 0; });
$('q').addEventListener('blur', () => suggest(false));
$('q').addEventListener('keydown', e => {
  if (root.dataset.stage !== 'home') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if ($('suggest').hidden) { suggest(true); if (e.key === 'ArrowUp') return; }
    const n = sugItems.length; if (!n) return;
    sugAt = e.key === 'ArrowDown' ? (sugAt + 1) % n : (sugAt <= 0 ? n - 1 : sugAt - 1);
    renderSuggest();
  } else if (e.key === 'Enter' && !$('suggest').hidden && sugAt >= 0) { e.preventDefault(); pickSuggest(sugAt); }
  else if (e.key === 'Escape' && !$('suggest').hidden) { e.stopPropagation(); suggest(false); }
});
$('suggest').addEventListener('pointerdown', e => e.preventDefault());   // keep the focus in the field
$('suggest').addEventListener('click', e => {
  if (e.target.closest('[data-all],[data-fewer]')) {   // the list grows (or shrinks) in place; the field keeps the focus
    sugAll = !!e.target.closest('[data-all]'); sugAt = -1; renderSuggest();   // the highlight's index means another row now
    if (!sugAll) $('suggest').scrollTop = 0;
    return;
  }
  const o = e.target.closest('.opt'); if (o) pickSuggest(+o.dataset.i);
});
$('clear').addEventListener('click', () => {
  if (root.dataset.stage === 'home') { $('q').value = ''; syncClear(); $('q').focus(); }
  else goHome();
});
$('brandBtn').addEventListener('click', () => { if (root.dataset.stage !== 'home') goHome(); });
// Escape closes the innermost thing: a sheet (the dialog does that itself), the sensitivity menu, a header
// panel, a card over the plot, and only then leaves the topic
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (!$('fa').hidden) { sensitivity(false); $('alphaChip').focus(); return; }
  if (S.pop) { closePop(); return; }
  if (root.dataset.stage === 'home') return;
  if ($('pick').innerHTML) unpick(); else goHome();
});
$('vHead').addEventListener('click', e => {
  const say = e.target.closest('[data-say]'), how = e.target.closest('[data-how]'), pop = e.target.closest('[data-pop]'), b = e.target.closest('[data-g]');
  if (say) showSays(+say.dataset.say);
  else if (how) showHow(+how.dataset.how);
  else if (e.target.closest('[data-now]')) goLive();
  else if (pop) {                                     // render rebuilds the button: keep the keyboard focus on it
    S.pop = S.pop === pop.dataset.pop ? null : pop.dataset.pop;
    if (S.pop) unpick();                              // the panel replaces an open cell card
    renderHead();
    $('vHead').querySelector(`[data-pop="${pop.dataset.pop}"]`)?.focus();
  } else if (b) select(+b.dataset.g);
});
// closes the panel in place: no render(), which would rebuild the header under a press and swallow its click
function closePop() {
  S.pop = null; $('pop').hidden = true;
  for (const b of $('vHead').querySelectorAll('[data-pop]')) b.setAttribute('aria-expanded', 'false');
}
addEventListener('pointerdown', e => { if (S.pop && !e.target.closest('#pop,[data-pop]')) closePop(); });
const closeSheets = () => { for (const id of ['says', 'posts', 'how']) if ($(id).open) $(id).close(); };
$('how').addEventListener('close', () => { howing++; });
// the Back button rides along while the sheet scrolls, tucked into a round button (as on /metrics)
for (const id of ['says', 'posts', 'how'])
  $(id).addEventListener('scroll', e => e.currentTarget.classList.toggle('scrolled', e.currentTarget.scrollTop > 30), {passive: true});
$('says').addEventListener('close', () => { saying++; });
$('posts').addEventListener('close', stopPaging);
for (const id of ['says', 'posts', 'how']) $(id).addEventListener('click', e => {
  const pt = e.target.closest('[data-point]'), more = e.target.closest('[data-more]'), ex = e.target.closest('[data-expand]');
  if (more) { more.previousElementSibling?.classList.add('all'); more.remove(); markLong($(id)); }
  else if (ex) { const li = ex.closest('li'); li.classList.toggle('open'); ex.textContent = li.classList.contains('open') ? 'Show less' : 'Read more'; }
  else if (pt) showPosts(+pt.dataset.point);
  else if (e.target.closest('[data-close]')) $(id).close();                                 // Done
  else if (e.target === $(id)) {                     // the backdrop: outside the sheet's box, not its own padding
    const r = $(id).getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $(id).close();
  }
});
$('pick').addEventListener('click', e => { const say = e.target.closest('[data-say]'); if (say) showSays(+say.dataset.say); });
// the sensitivity menu of the scan pill: the sonar button toggles it, a click elsewhere or Escape closes it
function sensitivity(on) {
  $('fa').hidden = !on; $('alphaChip').setAttribute('aria-expanded', on);
  if (on) $('alphaRange').focus({preventScroll: true});
  else details(false);                              // the menu opens short again
}
function details(on) { $('alphaMore').hidden = !on; $('alphaInfo').setAttribute('aria-expanded', on); }
$('alphaInfo').addEventListener('click', () => details($('alphaMore').hidden));
$('alphaChip').addEventListener('click', () => sensitivity($('fa').hidden));
addEventListener('pointerdown', e => { if (!$('fa').hidden && !e.target.closest('#fa,#alphaChip')) sensitivity(false); });
$('playBtn').addEventListener('click', e => {
  if (S.live) { e.preventDefault(); liveStop(); }                                     // pause
  else if (sameTopic()) { e.preventDefault(); liveStart(S.topic); }                  // resume
});                                                                                    // otherwise: submit = Check
$('stopBtn').addEventListener('click', () => { liveStop(); goHome(); });              // stop: the scan ends, back to the start
addEventListener('pagehide', () => { if (S.live?.session) navigator.sendBeacon?.(`/api/scan/${S.live.session}/stop`); });
// T12c false-alarm slider: one stop per SPRT alpha, hint from the measured point (/api/operating_points)
const per = a => `~${Math.round(1 / a)}`;
// one short line under the slider; the rest (what it catches, how it was measured) behind the "!" button
function alphaHint(a) {
  const p = S.points?.points?.find(q => Math.abs(q.alpha - a) < 1e-9);
  const hint = `About 1 false alarm per ${per(a)} quiet windows`;
  const live = a !== DESIGN_ALPHA ? ` The live scan updates at ${pct(DESIGN_ALPHA)}; this point refreshes every ~5 min.` : '';
  if (!p) return [hint, `A quiet window = ${WINDOW_HOURS} h of one topic. Not measured yet.${live}`, ''];
  const dec = p.posts_to_decision != null ? `, deciding after <b>~${p.posts_to_decision.toFixed(1)} posts</b>` : '';
  const detail = `A quiet window = ${WINDOW_HOURS} h of one topic. Catches <b>${pct(p.pd_small)}</b> of 3-account swarms${dec}.${live}`;
  const alarms = Math.round(p.pfa * p.n_background);
  let meas = `Measured: ${alarms} false alarm${alarms === 1 ? '' : 's'} in ${p.n_background} test windows (≤ ${pct(p.pfa_upper95)} at 95%)`;
  if (p.n_independent) {
    const ia = Math.round((p.pfa_independent ?? 0) * p.n_independent);
    meas += ` · ${ia} in ${p.n_independent} independent live windows` +
      (p.pfa_independent_upper95 != null ? ` (≤ ${pct(p.pfa_independent_upper95)})` : '');
  }
  return [hint, detail, meas];
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
  $('alphaChip').hidden = alphas.length < 2;  // one served stop: nothing to choose
  range.value = String(alphas.indexOf(S.alpha));
  const at = i => i / Math.max(1, alphas.length - 1) * 100;
  $('alphaStops').innerHTML = alphas.map((a, i) =>
    `<button type="button" tabindex="-1" data-i="${i}" style="left:${at(i)}%">${pct(a)}</button>`).join('');
  const show = i => {
    const a = alphas[i];
    range.style.setProperty('--p', `${at(i)}%`);
    range.setAttribute('aria-valuetext', `${pct(a)} false alarm limit`);
    $('alphaVal').textContent = pct(a);
    for (const b of $('alphaStops').children) b.classList.toggle('on', +b.dataset.i === i);
    const [hint, detail, meas] = alphaHint(a);
    $('alphaHint').textContent = hint; $('alphaDetail').innerHTML = detail; $('alphaMeas').textContent = meas;
    // the landing's sonar follows the slider at once, while dragging: more sensitive = more swarms found
    sens = alphas.length > 1 ? i / (alphas.length - 1) : .5;
    const per = Math.max(1, Math.round(1 / spotP(sens)));
    $('alphaDemo').textContent = per === 1 ? 'On the radar below: almost every ping finds a swarm' : `On the radar below: about 1 ping in ${per} finds a swarm`;
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
  show(+range.value);
}

try { buildScene(); } catch (err) { ok = false; console.error(err); canvas.style.display = 'none'; }
if (ok) { new ResizeObserver(resize).observe(canvas); resize(); requestAnimationFrame(frame); }

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
  schedule(POLL_MS);
  setInterval(renderStrip, 30000);   // "now" moves on the timeline
})();
