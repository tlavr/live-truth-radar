// Promo scenes core: one 16:9 stage (WebGL canvas + a DOM layer with the real UI components, scaled together),
// a deterministic timeline (everything is a function of t, so a take can be scrubbed and re-recorded exactly),
// scripted / custom / free camera, keys, HUD. Every scene page imports createStage() from here.
//
// URL (any scene): ?rec (no HUD, plays at once) · ?w=1920&h=1080 (render size, default = window) · ?t=3.5 (start)
//   ?speed=0.5 · ?dpr=2 · ?glitch=0 (clean plate) · ?ui=0 (no DOM layer: 3D only) · ?ui3d=0 (DOM only, black 3D)
//   ?uiw=1440 (logical width of the DOM layer: smaller = bigger UI on screen)
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {RGBShiftShader} from 'three/addons/shaders/RGBShiftShader.js';

export {THREE};

/* ------------------------------------------------------------------ shared look */
// the dashboard's palette (web/app.js PAL, web/index.html :root) and the red team console's (web/redteam.html)
export const PAL = {bg: '#0C100E', surface: '#161D19', ink: '#F2F6F3', muted: 'rgba(218,232,222,.62)', cool: '#63CF97',
  salat: '#8EE87B', warm: '#B7F063', peak: '#FFE066', sel: '#FF5C9E', swarm: '#FF3B3B', cream: '#F4EBD0',
  hiveBg: '#08060A', hiveRed: '#FF4D6D', hiveAmber: '#FFB547', ok: '#5BE49B'};

// the scenes, in the order of the cut (index.html lists them; N / B jump to the next / previous one)
// one player page (player.html, built by build.py) runs every scene: player.html?scene=<id>
export const SCENES = [
  {id: 'bothive-launch', name: 'BotHive · launch', dur: 6.6},
  {id: 'feed', name: 'Feed', dur: 10.6},
  {id: 'market', name: 'Market (insert)', dur: 3.1},
  {id: 'shop', name: 'Shop (insert)', dur: 5.4},
  {id: 'social', name: 'Social (insert)', dur: 5.4},
  {id: 'decay', name: 'Decay → landing', dur: 10.3},
  {id: 'intercept', name: 'Intercept', dur: 19},
  {id: 'bothive-caught', name: 'BotHive · caught', dur: 7.5},
  {id: 'outro', name: 'Outro', dur: 9},
];
export const SCENE_ID = new URLSearchParams(location.search).get('scene') || SCENES[0].id;

/* ------------------------------------------------------------------ helpers */
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const ss = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const lerp = (a, b, k) => a + (b - a) * k;
export const pulse = (t, at, decay = 8) => (t >= at ? Math.exp(-(t - at) * decay) : 0);
export const ease = {lin: k => k, io: k => k * k * (3 - 2 * k), in: k => k * k * k, out: k => 1 - Math.pow(1 - k, 3),
  io3: k => (k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)};
export function rng(seed = 1234567) { let s = seed % 2147483647 || 1; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
export const GLSL_HASH = `float h1(float n){return fract(sin(n)*43758.5453123);}
  float h2(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}`;
export const Q = new URLSearchParams(location.search);
export const qn = (k, d) => (Q.has(k) && Q.get(k) !== '' && !isNaN(+Q.get(k)) ? +Q.get(k) : d);
export const qs = (k, d) => (Q.has(k) && Q.get(k) !== '' ? Q.get(k) : d);
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export const v3 = a => new THREE.Vector3(...a);

// a soft round glow (dots, sparks)
export function glowTexture(inner = 'rgba(255,200,200,1)', mid = 'rgba(255,64,64,1)', outer = 'rgba(255,40,40,0)') {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const g = cv.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(.18, mid); gr.addColorStop(.45, mid.replace(/[\d.]+\)$/, '.35)')); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* ------------------------------------------------------------------ the stage */
const CSS = `
html,body{margin:0;height:100%;background:#000;overflow:hidden}
#pwrap{position:fixed;inset:0;display:grid;place-items:center;background:#000}
#pstage{position:relative;overflow:hidden;background:#000}
#pstage #pc{position:absolute;inset:0;width:100%;height:100%;display:block}
#pui{position:absolute;left:0;top:0;transform-origin:0 0;overflow:hidden}
#pfade{position:absolute;inset:0;background:#000;pointer-events:none;opacity:0}
#phud{position:fixed;left:12px;bottom:12px;font:12px/1.45 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:#cfe;background:rgba(0,0,0,.72);
  border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:9px 11px;max-width:min(620px,94vw);z-index:50;-webkit-font-smoothing:antialiased}
#phud b{color:#fff} #phud .k{color:#63CF97} #phud .warn{color:#FFB547} #phud a{color:#9fd;text-decoration:none}
#phud .bar{height:3px;background:rgba(255,255,255,.12);margin:6px 0 7px;border-radius:2px;position:relative}
#phud .bar i{position:absolute;left:0;top:0;bottom:0;background:#63CF97;border-radius:2px}
#phud .keys{color:rgba(220,240,230,.62)}
#ptoast{position:fixed;right:12px;bottom:12px;font:12px ui-monospace,Menlo,monospace;background:rgba(0,0,0,.78);color:#fff;
  padding:7px 10px;border-radius:5px;opacity:0;transition:opacity .25s;z-index:51;pointer-events:none}
.phide{display:none!important}`;

/**
 * createStage(opts) → ctx
 *   id        scene id (camera path storage key)
 *   title     HUD title
 *   duration  seconds
 *   ui        HTML of the DOM layer (real UI components), laid out at uiW × uiW·9/16 logical px
 *   uiW       logical width of the DOM layer (default 1440, ?uiw=)
 *   path      scripted camera: [{t, p:[x,y,z], l:[x,y,z], e:'io'|'in'|'out'|'lin'|'io3', fov?}]
 *   fov       default 35
 *   bloom     {strength, radius, threshold}
 *   frame(t, ctx)  called every frame before rendering; set ctx.shake, ctx.rgb, ctx.fade, ctx.bloom.strength here
 */
export function createStage(opts) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
  const REC = Q.has('rec'), FIX_W = qn('w', 0), FIX_H = qn('h', 0);
  const UIW = qn('uiw', opts.uiW || 1440), UIH = UIW * 9 / 16;
  document.body.insertAdjacentHTML('beforeend', `<div id="pwrap"><div id="pstage"><canvas id="pc"></canvas><div id="pui"></div><div id="pfade"></div></div></div><div id="phud"></div><div id="ptoast"></div>`);
  const canvas = document.getElementById('pc'), uiEl = document.getElementById('pui'), fadeEl = document.getElementById('pfade');
  const stageEl = document.getElementById('pstage');
  uiEl.style.width = `${UIW}px`; uiEl.style.height = `${UIH}px`;
  uiEl.innerHTML = opts.ui || '';
  if (Q.get('ui') === '0') uiEl.classList.add('phide');
  if (Q.get('ui3d') === '0') canvas.style.visibility = 'hidden';

  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true});
  renderer.setPixelRatio(FIX_W ? 1 : qn('dpr', Math.min(2, devicePixelRatio || 1)));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(opts.fov || 35, 16 / 9, .1, 800);
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {samples: 4, type: THREE.HalfFloatType}));
  composer.addPass(new RenderPass(scene, camera));
  // safety net: a NaN or Inf pixel from any shader would be blurred by the bloom into black squares; zero it first
  composer.addPass(new ShaderPass({
    uniforms: {tDiffuse: {value: null}},
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
      void main(){ vec4 c = texture2D(tDiffuse, vUv);
        if (any(isnan(c)) || any(isinf(c))) c = vec4(0., 0., 0., 1.);
        gl_FragColor = clamp(c, 0., 64.); }`,
  }));
  const b = opts.bloom || {};
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), b.strength ?? .55, b.radius ?? .55, b.threshold ?? .18);
  composer.addPass(bloom);
  const rgbPass = new ShaderPass(RGBShiftShader); composer.addPass(rgbPass);
  composer.addPass(new OutputPass());

  const ctx = {THREE, scene, camera, renderer, composer, bloom, ui: uiEl, canvas, t: 0, shake: 0, rgb: 0, fade: 0,
    glitch: Q.get('glitch') !== '0', uiW: UIW, uiH: UIH, $: sel => uiEl.querySelector(sel), $$: sel => [...uiEl.querySelectorAll(sel)]};

  function resize() {
    const ww = innerWidth, wh = innerHeight;
    const cw = Math.min(ww, wh * 16 / 9), ch = cw * 9 / 16;          // the stage is always 16:9, letterboxed
    const rw = FIX_W || Math.round(cw), rh = FIX_H || Math.round(ch);
    stageEl.style.width = `${cw}px`; stageEl.style.height = `${ch}px`;
    renderer.setSize(rw, rh, false); composer.setSize(rw, rh); bloom.resolution.set(rw, rh);
    uiEl.style.transform = `scale(${cw / UIW})`;
    camera.aspect = 16 / 9; camera.updateProjectionMatrix();
    ctx.px = rh;   // render height in pixels (point sizes)
  }
  addEventListener('resize', resize);

  // world point → DOM layer px (for UI elements that follow the 3D scene)
  const _v = new THREE.Vector3();
  ctx.toUI = p => { _v.copy(p).project(camera); return {x: (_v.x * .5 + .5) * UIW, y: (-_v.y * .5 + .5) * UIH, behind: _v.z > 1}; };

  /* camera: script / custom / free */
  const PATH = (opts.path || []).map(k => ({t: k.t, p: v3(k.p), l: v3(k.l), e: k.e || 'io', fov: k.fov}));
  const KEY = `lsr.promo.path.${opts.id}`;
  const loadPath = () => { try { return JSON.parse(store.get(KEY) || '[]').map(k => ({t: k.t, p: v3(k.p), l: v3(k.l), e: k.e || 'io', fov: k.fov})); } catch { return []; } };
  if (REC) { const c = document.createElement('style'); c.textContent = '*{cursor:none!important}'; document.head.appendChild(c); }
  const S = {t: qn('t', 0), playing: REC || Q.has('play'), speed: qn('speed', 1), mode: 'script', custom: loadPath(), hud: !REC, last: performance.now()};
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.dampingFactor = .08; controls.enabled = false;
  canvas.style.pointerEvents = 'auto'; uiEl.style.pointerEvents = 'none';
  function sample(path, t) {
    if (!path.length) return null;
    if (t <= path[0].t) return {p: path[0].p.clone(), l: path[0].l.clone(), fov: path[0].fov};
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], z = path[i];
      if (t <= z.t) { const k = (ease[z.e] || ease.io)((t - a.t) / Math.max(1e-6, z.t - a.t));
        return {p: a.p.clone().lerp(z.p, k), l: a.l.clone().lerp(z.l, k), fov: a.fov != null && z.fov != null ? lerp(a.fov, z.fov, k) : z.fov ?? a.fov}; }
    }
    const z = path[path.length - 1]; return {p: z.p.clone(), l: z.l.clone(), fov: z.fov};
  }
  const hs = n => { const x = Math.sin(n * 12.9898) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  function placeCamera(t) {
    if (S.mode === 'free') { controls.update(); return; }
    const c = sample(S.mode === 'custom' && S.custom.length >= 2 ? S.custom : PATH, t);
    if (!c) return;
    if (ctx.glitch && ctx.shake > 0) {   // stepped, so it reads as a glitch, not a wobble
      const tick = Math.floor(t * 15), amp = ctx.shake * c.p.distanceTo(c.l);
      c.p.x += hs(tick) * amp; c.p.y += hs(tick + 7.3) * amp;
    }
    camera.position.copy(c.p); camera.lookAt(c.l); controls.target.copy(c.l);
    const fov = c.fov ?? opts.fov ?? 35; if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }
  const ser = k => ({t: +k.t.toFixed(3), p: k.p.toArray().map(x => +x.toFixed(3)), l: k.l.toArray().map(x => +x.toFixed(3)), e: k.e});
  const savePath = () => store.set(KEY, JSON.stringify(S.custom.map(ser)));
  const toast = msg => { const el = document.getElementById('ptoast'); el.textContent = msg; el.style.opacity = 1; clearTimeout(toast.t); toast.t = setTimeout(() => el.style.opacity = 0, 1600); };
  const copy = (s, label) => (navigator.clipboard?.writeText(s) ?? Promise.reject()).then(() => toast(`${label} copied`), () => prompt(label, s));

  const idx = SCENES.findIndex(s => s.id === SCENE_ID);
  // switch scene, keeping the URL options (rec, w, h, glitch …) but not the start time
  const href = i => { const q = new URLSearchParams(location.search); q.delete('t'); q.set('scene', SCENES[i].id); return `player.html?${q}`; };
  const goTo = i => { if (SCENES[i] && i !== idx) location.href = href(i); };
  const go = d => goTo(idx + d);
  function hud() {
    const el = document.getElementById('phud'); el.classList.toggle('phide', !S.hud); if (!S.hud) return;
    const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
    const keys = S.custom.length ? S.custom.map(k => k.t.toFixed(2)).join(', ') : '—';
    el.innerHTML = `<b>${opts.title}</b> ${idx >= 0 ? `(${idx + 1}/${SCENES.length})` : ''} &nbsp; t <b>${fmt(S.t)}</b> / ${fmt(opts.duration)} · ${S.playing ? '▶' : '❚❚'} ×${S.speed} · <a href="index.html">all scenes</a><br>
       ${SCENES.map((s, i) => `<a href="${href(i)}" style="${i === idx ? 'color:#fff;font-weight:700' : ''}">${i + 1} ${s.name}</a>`).join(' · ')}<br>
      camera <b>${S.mode}</b>${S.mode === 'custom' && S.custom.length < 2 ? ' <span class="warn">(needs ≥ 2 keys, using script)</span>' : ''} · keys ${keys} · glitch ${ctx.glitch ? 'on' : 'off'}
      <div class="bar"><i style="width:${(S.t / opts.duration * 100).toFixed(2)}%"></i></div>
      <div class="keys"><span class="k">Space</span> play · <span class="k">R</span> restart · <span class="k">←/→</span> ±1 s (<span class="k">Shift</span> ±0.1) · <span class="k">[ ]</span> speed · <span class="k">1–9</span> pick scene · <span class="k">N/B</span> next/prev<br>
      <span class="k">F</span> free camera · <span class="k">M</span> script ↔ custom · <span class="k">K</span> key at t · <span class="k">X</span> del key · <span class="k">Shift+X</span> clear<br>
      <span class="k">C</span> copy path · <span class="k">L</span> paste path · <span class="k">P</span> copy camera key · <span class="k">G</span> glitch · <span class="k">U</span> UI layer · <span class="k">H</span> HUD · <span class="k">S</span> PNG</div>`;
  }
  const seek = t => { S.t = clamp(t, 0, opts.duration); };
  addEventListener('keydown', e => {
    const k = e.key;
    if (k === ' ') { S.playing = !S.playing; if (S.playing && S.t >= opts.duration) seek(0); e.preventDefault(); }
    else if (k === 'r' || k === 'R') { seek(0); S.playing = true; }
    else if (k === 'ArrowRight') seek(S.t + (e.shiftKey ? .1 : 1));
    else if (k === 'ArrowLeft') seek(S.t - (e.shiftKey ? .1 : 1));
    else if (k === ']') S.speed = Math.min(4, S.speed * 2);
    else if (k === '[') S.speed = Math.max(.125, S.speed / 2);
    else if (/^[1-9]$/.test(k)) goTo(+k - 1);
    else if (k === 'n' || k === 'N') go(1);
    else if (k === 'b' || k === 'B') go(-1);
    else if (k === 'f' || k === 'F') { S.mode = S.mode === 'free' ? (S.custom.length >= 2 ? 'custom' : 'script') : 'free'; controls.enabled = S.mode === 'free'; toast(`camera: ${S.mode}`); }
    else if (k === 'm' || k === 'M') { S.mode = S.mode === 'custom' ? 'script' : 'custom'; controls.enabled = false; toast(`camera: ${S.mode}`); }
    else if (k === 'k' || k === 'K') { S.custom = S.custom.filter(x => Math.abs(x.t - S.t) > .05); S.custom.push({t: S.t, p: camera.position.clone(), l: controls.target.clone(), e: 'io'}); S.custom.sort((a, z) => a.t - z.t); savePath(); toast(`key at ${S.t.toFixed(2)} s (${S.custom.length})`); }
    else if (k === 'x') { const i = S.custom.findIndex(x => Math.abs(x.t - S.t) < .5); if (i >= 0) { S.custom.splice(i, 1); savePath(); toast('key deleted'); } }
    else if (k === 'X') { S.custom = []; savePath(); toast('keys cleared'); }
    else if (k === 'c' || k === 'C') copy(JSON.stringify(S.custom.map(ser)), 'Camera path JSON');
    else if (k === 'l' || k === 'L') { const j = prompt('Paste camera path JSON:'); if (!j) return;
      try { S.custom = JSON.parse(j).map(x => ({t: x.t, p: v3(x.p), l: v3(x.l), e: x.e || 'io'})); S.custom.sort((a, z) => a.t - z.t); savePath(); S.mode = 'custom'; toast(`loaded ${S.custom.length} keys`); } catch { toast('bad JSON'); } }
    else if (k === 'p' || k === 'P') copy(`{t: ${S.t.toFixed(2)}, p: [${camera.position.toArray().map(x => x.toFixed(2))}], l: [${controls.target.toArray().map(x => x.toFixed(2))}], e: 'io'},`, 'Camera key');
    else if (k === 'g' || k === 'G') { ctx.glitch = !ctx.glitch; toast(`glitch ${ctx.glitch ? 'on' : 'off'}`); }
    else if (k === 'u' || k === 'U') uiEl.classList.toggle('phide');
    else if (k === 'h' || k === 'H') S.hud = !S.hud;
    else if (k === 's' || k === 'S') { render(S.t); const a = document.createElement('a'); a.download = `${opts.id}-${S.t.toFixed(2)}s.png`; a.href = canvas.toDataURL('image/png'); a.click(); toast('PNG of the 3D layer saved (use screen capture for the UI layer)'); }
    else return;
    hud();
  });

  function render(t) {
    ctx.t = t; ctx.shake = 0; ctx.rgb = 0; ctx.fade = 0;
    opts.frame(t, ctx);
    placeCamera(t);
    opts.after?.(t, ctx);      // after the camera: UI that follows 3D points (toUI)
    rgbPass.uniforms.amount.value = ctx.glitch ? ctx.rgb : 0;
    rgbPass.uniforms.angle.value = (Math.floor(t * 9) * 1.7) % 6.28;
    fadeEl.style.opacity = ctx.fade.toFixed(3);
    composer.render();
  }
  function loop(now) {
    const dt = Math.min(.1, (now - S.last) / 1000); S.last = now;
    if (S.playing) { S.t += dt * S.speed; if (S.t >= opts.duration) { S.t = opts.duration; S.playing = false;
      // ?all: the reel — every scene plays in a row, for one screen recording; a short black hold between scenes
      if (Q.has('all') && idx < SCENES.length - 1) setTimeout(() => go(1), 600); } }
    render(S.t);
    if (S.hud) hud();
    requestAnimationFrame(loop);
  }
  ctx.start = () => { resize(); hud(); requestAnimationFrame(loop); };
  ctx.seek = seek; ctx.state = S; ctx.controls = controls;
  window.promo = ctx;
  return ctx;
}

/* ------------------------------------------------------------------ the radar's field (shared by decay, intercept) */
// A line grid like the dashboard's surface (web/app.js): cool lines, a glow, a sonar ring, entropy noise that the
// ring calms, and peaks (gaussians) that turn swarm-red. heightFn in GLSL so points can sit on it too.
export const FIELD_GLSL = `${GLSL_HASH}
  uniform float uTime, uNoise, uRingT, uRingSpeed, uRingOn, uCalm;
  uniform vec2 uRingO;
  uniform vec4 uPeaks[8];          // xy = centre, z = height, w = width²
  uniform float uPeakKind[8];      // 0 organic (salat), 1 suspicious (yellow), 2 swarm (red)
  float fieldH(vec2 p, out float passed, out float ring, out float peak, out float nz){
    float d = length(p - uRingO), r = (uTime - uRingT)*uRingSpeed, on = uRingOn*step(0., uTime - uRingT);
    passed = max(uCalm, on * (1. - smoothstep(r - 1.2, r + .4, d)));
    float rr = (d - r)/.75;
    ring = on * exp(-rr*rr) * (1. - smoothstep(30., 40., r));
    float wave = .22*sin(p.x*.21 + uTime*.55)*cos(p.y*.27 - uTime*.42) + .12*sin(p.x*.07 - p.y*.11 + uTime*.3);
    nz = (h2(floor(p*2.2) + floor(uTime*14.)) - .5) * uNoise * (1. - passed);
    peak = 0.;
    for (int i = 0; i < 8; i++) { vec2 q = p - uPeaks[i].xy; peak += uPeaks[i].z * exp(-dot(q, q)/max(.01, uPeaks[i].w)); }
    return wave + nz*1.6 + peak;
  }
  vec3 peakKinds(vec2 p){             // how much of each kind of hill is under p: (organic, suspicious, swarm)
    vec3 k = vec3(0.);
    for (int i = 0; i < 8; i++) { vec2 q = p - uPeaks[i].xy; float h = uPeaks[i].z * exp(-dot(q, q)/max(.01, uPeaks[i].w));
      k += h * vec3(step(uPeakKind[i], .5), step(.5, uPeakKind[i])*step(uPeakKind[i], 1.5), step(1.5, uPeakKind[i])); }
    return k;
  }`;
export function makeField({W = 40, D = 24, NX = 150, NZ = 90, every = 3, thr = 1e3} = {}) {
  const pos = new Float32Array(NX * NZ * 3);
  for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
    const k = (iz * NX + ix) * 3; pos[k] = (ix / (NX - 1) - .5) * W; pos[k + 1] = 0; pos[k + 2] = (iz / (NZ - 1) - .5) * D;
  }
  const idx = [];
  for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX - 1; ix++) idx.push(iz * NX + ix, iz * NX + ix + 1);
  for (let ix = 0; ix < NX; ix += every) for (let iz = 0; iz < NZ - 1; iz++) idx.push(iz * NX + ix, (iz + 1) * NX + ix);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(idx);
  const U = {
    uTime: {value: 0}, uA: {value: 1}, uNoise: {value: 0}, uCalm: {value: 0}, uRingT: {value: 1e3}, uRingSpeed: {value: 9}, uRingOn: {value: 1},
    uRingO: {value: new THREE.Vector2(0, 0)}, uPeaks: {value: Array.from({length: 8}, () => new THREE.Vector4(0, 0, 0, 1))}, uPeakKind: {value: new Array(8).fill(0)},
    uThr: {value: thr}, uRingRed: {value: 0},
    uCool: {value: new THREE.Color(PAL.cool)}, uCream: {value: new THREE.Color(PAL.cream)}, uRed: {value: new THREE.Color(PAL.swarm)}, uSel: {value: new THREE.Color(PAL.sel)},
    uSalat: {value: new THREE.Color(PAL.warm)}, uYel: {value: new THREE.Color(PAL.peak)}, uKindOn: {value: 0},
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `${FIELD_GLSL}
      varying float vPassed, vRing, vPeak, vNz, vEdge, vY; varying vec3 vKind;
      void main(){
        float passed, ring, peak, nz;
        vec3 p = position; p.y = fieldH(p.xz, passed, ring, peak, nz);
        vPassed = passed; vRing = ring; vPeak = peak; vNz = nz; vY = p.y; vKind = peakKinds(p.xz);
        vEdge = 1. - smoothstep(.40, .5, max(abs(position.x)/${W.toFixed(1)}, abs(position.z)/${D.toFixed(1)}));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: `uniform float uA, uThr, uRingRed, uKindOn; uniform vec3 uCool, uCream, uRed, uSel, uSalat, uYel;
      varying float vPassed, vRing, vPeak, vNz, vEdge, vY; varying vec3 vKind;
      void main(){
        float flick = .45 + 1.6*abs(vNz);
        vec3 c = uCool * mix(flick, .55, vPassed);
        c *= 1. + clamp(vPeak*.35, 0., 1.4);                    // a rising hill glows
        // coloured hills (decay): organic salat, suspicious yellow, the swarm red, each by how much of it is here
        vec3 kc = uSalat*vKind.x + uYel*vKind.y + uRed*1.25*vKind.z; float kw = vKind.x + vKind.y + vKind.z;
        c = mix(c, kc/max(kw, 1e-3)*1.7, uKindOn*clamp(kw*.55, 0., 1.));
        c = mix(c, uSel*1.7, smoothstep(uThr - .25, uThr + .25, vY));   // above the CFAR threshold: the selected-group pink
        c += mix(uCream, uRed, uRingRed) * vRing * 1.35;
        gl_FragColor = vec4(c * uA * vEdge, 1.);
      }`,
  });
  const mesh = new THREE.LineSegments(geo, mat); mesh.frustumCulled = false;
  return {mesh, U, W, D, NX, NZ, pos};
}
