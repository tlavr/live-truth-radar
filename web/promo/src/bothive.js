// BotHive: the antagonist. The red team console (web/redteam.html, the same markup and styles, rebranded) on the
// left, the hive on the right: a honeycomb whose armed cells are the bots. Two parts:
//   launch  (bothive-launch.html): a pointer sets Bots / Posts per bot / Scenario and presses ATTACK; the cells fire
//           volleys of red dots that fly out of frame (into the feed); the log fills with posts, all "· unseen".
//   caught  (bothive-caught.html): the radar answers: the log flips to "✓ detected" bot by bot, each caught cell
//           flashes green and goes dark, the hive dies out. ?caught=25 &first=2:14 → put the real numbers of your run.
import {createStage, THREE, PAL, clamp, ss, pulse, rng, qn, qs, glowTexture, GLSL_HASH} from './core.js';
import {BOT_TEXTS, botHandle} from './cast.js';

const TOPIC = 'CEO Scandal';
const BOTS = 25, PPB = 4, MAXB = 40;
const VOLLEYS = [2.05, 2.6, 3.05, 3.4];            // launch: the four volleys (posts per bot = volleys, as in the real console)
const SCEN_HINT = 'Paraphrase: every bot rewords the same message. Demo speed: 4× faster than the real schedule the metrics are measured on (~2.5 min for 2 posts per bot, ~6.5 min for 4). Expect a peak near zero lag, small wording gap.';

export function run(part) {
  const CAUGHT = clamp(Math.round(qn('caught', BOTS)), 0, BOTS);
  const FIRST = qs('first', '2:14');
  const launch = part === 'launch';
  const UI = `
  <div class="hive">
    <header><h1><span class="cell"></span>BotHive</h1><span>swarm launcher · ${BOTS} synthetic accounts ready</span></header>
    <main>
      <section class="box">
        <div class="row">
          <label>Target topic</label><span class="sel" id="hTopic">${TOPIC}</span>
          <label>Bots</label><span class="sel" id="hBots">${launch ? 12 : BOTS}</span>
          <label>Posts per bot</label><span class="sel" id="hPpb">${launch ? 2 : PPB}</span>
          <span class="hint" id="hTotal">= ${launch ? 24 : BOTS * PPB} posts</span>
          <label>Scenario</label><span class="sel" id="hScen">${launch ? 'Copypasta' : 'Paraphrase'}</span>
          <button class="btn" id="hAttack" type="button">Attack</button>
        </div>
        <p class="msg" id="hMsg">Ready.</p>
        <p class="hint" id="hHint">${SCEN_HINT}</p>
      </section>
      <section class="box stats">
        <div class="stat"><b id="sPosted">—</b><span>posts published</span></div>
        <div class="stat"><b id="sBots">—</b><span>bots active</span></div>
        <div class="stat hit" id="sCaughtBox"><b id="sCaught">—</b><span>bots caught by the radar</span></div>
        <div class="stat" id="sTimeBox"><b id="sTime">—</b><span>time to first detection</span></div>
      </section>
      <section class="box"><ul id="log"></ul></section>
    </main>
  </div>
  <div class="hive-count" id="hCount"><div class="l1"><b id="cBots">12</b><span>bots</span></div>
    <div class="l2" id="cMath">× 2 posts = 24</div><div class="l3" id="cOutBox"><b id="cOut">0</b><span>posts out</span></div></div>
  <div class="hive-tag">BOTHIVE · red-team test mode · every post it makes is flagged synthetic</div>
  <svg class="cursor" id="cur" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.6L21 10.8z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

  const DUR = launch ? 6.6 : 7.5;
  const ctx = createStage({
    id: `bothive-${part}`, title: `BotHive · ${part}`, duration: DUR, ui: UI, fov: 35,
    bloom: {strength: .7, radius: .6, threshold: .12},
    path: launch ? [
      {t: 0, p: [1.2, -.3, 18.5], l: [1.4, .2, 0]},
      {t: 1.9, p: [1.0, -.1, 17.2], l: [1.3, .2, 0], e: 'io'},
      {t: 3.6, p: [2.4, .1, 15.5], l: [3.6, .2, 0], e: 'io'},
      {t: 6.6, p: [8.5, .6, 10.5], l: [14, .6, 4], e: 'in'},        // rides the stream out of the hive
    ] : [
      {t: 0, p: [1.4, .1, 15.0], l: [1.6, .1, 0]},
      {t: 7.5, p: [1.0, -.2, 17.0], l: [1.3, 0, 0], e: 'io'},
    ],
    frame, after,
  });
  const {scene, $} = ctx;
  scene.background = new THREE.Color(PAL.hiveBg);

  /* ---------------- the hive: honeycomb cells (flat-top hexagons) ---------------- */
  const R = .43, HC = new THREE.Vector2(3.7, .55);   // up and left: the big counter sits in the bottom-right corner
  const cells = [];
  for (let c = -9; c <= 9; c++) for (let r = -8; r <= 8; r++) {
    const x = c * R * 1.5, y = (r + (c & 1 ? .5 : 0)) * R * Math.sqrt(3);
    const e = Math.hypot(x / 4.3, y / 4.0);                       // an egg-shaped hive
    if (e < 1) cells.push({x: HC.x + x, y: HC.y + y, e});
  }
  const rnd = rng(77);
  // the bot cells: the 40 that can be armed, nearer the centre first, a bit shuffled
  const order = cells.map((c, i) => ({i, k: c.e + rnd() * .55})).sort((a, b) => a.k - b.k).map(o => o.i);
  const botCell = order.slice(0, MAXB);
  const NC = cells.length;
  const aPos = new Float32Array(NC * 2), aBot = new Float32Array(NC), aSeed = new Float32Array(NC), aFire = new Float32Array(NC * 4).fill(-99);
  cells.forEach((c, i) => { aPos[i * 2] = c.x; aPos[i * 2 + 1] = c.y; aBot[i] = -1; aSeed[i] = rnd() * 100; });
  // when bot j fires in volley v: the volley time plus a small per-bot jitter (the same numbers drive the dots and the log)
  const fireAt = (v, j) => VOLLEYS[v] + ((j * 0.6180339 + v * 0.37) % 1) * .18;
  botCell.forEach((ci, j) => { aBot[ci] = j; if (launch) for (let v = 0; v < PPB; v++) aFire[ci * 4 + v] = fireAt(v, j); });
  const hexGeo = new THREE.InstancedBufferGeometry().copy(new THREE.CircleGeometry(R * .93, 6));
  hexGeo.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 2));
  hexGeo.setAttribute('aBot', new THREE.InstancedBufferAttribute(aBot, 1));
  hexGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
  hexGeo.setAttribute('aFire', new THREE.InstancedBufferAttribute(aFire, 4));
  hexGeo.instanceCount = NC;
  const UH = {
    uTime: {value: 0}, uArmed: {value: launch ? 12 : BOTS}, uArmT: {value: -10},
    uCaughtT0: {value: 1e3}, uCaughtStep: {value: .096}, uCaughtN: {value: CAUGHT}, uDie: {value: 0}, uR: {value: R * .93},
    uRed: {value: new THREE.Color(PAL.hiveRed)}, uOk: {value: new THREE.Color(PAL.ok)}, uAmber: {value: new THREE.Color(PAL.hiveAmber)},
  };
  const hexMat = new THREE.ShaderMaterial({
    uniforms: UH, transparent: true, depthWrite: false,
    vertexShader: `${GLSL_HASH}
      attribute vec2 aPos; attribute float aBot, aSeed; attribute vec4 aFire;
      uniform float uTime, uArmed, uArmT, uCaughtT0, uCaughtStep, uCaughtN;
      varying vec2 vP; varying float vArm, vFire, vCaught, vDead, vSeed;
      float fire(float t0){ return uTime >= t0 ? exp(-(uTime - t0)*7.) : 0.; }
      void main(){
        vP = position.xy; vSeed = aSeed;
        float bot = aBot;
        float armedNow = bot >= 0. ? step(bot, uArmed - .5) : 0.;
        // newly armed cells (12 → 25) light up one after another after the click
        float armAt = uArmT + max(0., bot - 11.)*.035;
        vArm = armedNow * (bot < 12. ? 1. : smoothstep(armAt, armAt + .12, uTime));
        vFire = vArm * (fire(aFire.x) + fire(aFire.y) + fire(aFire.z) + fire(aFire.w));
        float tc = uCaughtT0 + bot*uCaughtStep;
        float isC = bot >= 0. ? step(bot, uCaughtN - .5) : 0.;
        vCaught = isC * (uTime >= tc ? exp(-(uTime - tc)*3.2) : 0.);
        vDead = isC * step(tc + .25, uTime);
        float kick = vFire*.08;
        gl_Position = projectionMatrix * viewMatrix * vec4(aPos + position.xy*(1. + kick), vFire*.25, 1.);
      }`,
    fragmentShader: `${GLSL_HASH}
      uniform float uTime, uR, uDie; uniform vec3 uRed, uOk, uAmber;
      varying vec2 vP; varying float vArm, vFire, vCaught, vDead, vSeed;
      void main(){
        vec2 p = abs(vP);
        float d = max(p.y, p.x*.866 + p.y*.5) / (uR*.866);        // hexagon distance: 1 at the edge
        float edge = smoothstep(.80, .97, d) * (1. - smoothstep(.97, 1.02, d));
        float core = 1. - smoothstep(.0, .62, d);
        float breathe = .5 + .5*sin(uTime*1.7 + vSeed);
        vec3 c = vec3(.06, .035, .07) + uRed*edge*(.16 + .08*breathe);                 // an empty cell
        float live = vArm * (1. - vDead);
        c += live * (uRed*core*(.55 + .25*breathe) + uRed*edge*.6);                  // an armed bot: a red core
        c += live * vFire * (uAmber*core*2.2 + uRed*edge*1.4);                        // firing
        c += vCaught * (uOk*core*2.0 + uOk*edge*2.4);                                 // caught: a green flash
        c = mix(c, vec3(.05, .05, .055) + uRed*edge*.05, vDead);                      // then dark
        c *= 1. - uDie*.85;
        gl_FragColor = vec4(c, 1.);
      }`,
  });
  const hive = new THREE.Mesh(hexGeo, hexMat); hive.frustumCulled = false; scene.add(hive);

  /* ---------------- the stream: every post leaves as a burst of particles; all bursts funnel into one river ---------------- */
  // a particle runs a quadratic bezier from its cell, pulled through a shared mouth at the hive's right edge, out of frame
  const TRAIL = 5, PER = 10, NP = BOTS * PPB;
  const MOUTH = [HC.x + 4.8, HC.y + .3, 2.2];
  const geoD = new THREE.BufferGeometry();
  const nPts = NP * PER * TRAIL;
  const dS = new Float32Array(nPts * 3), dM = new Float32Array(nPts * 3), dE = new Float32Array(nPts * 3), dT = new Float32Array(nPts * 4);
  const posts = [];
  const prnd = rng(9);
  let w = 0;
  for (let v = 0; v < PPB; v++) for (let j = 0; j < BOTS; j++) {
    const c = cells[botCell[j]];
    const t0 = fireAt(v, j);
    posts.push({v, j, t0, land: t0 + .9, text: BOT_TEXTS[(j * PPB + v * 7) % BOT_TEXTS.length], who: botHandle(j)});
    for (let q = 0; q < PER; q++) {
      const st = [c.x + (prnd() - .5) * R, c.y + (prnd() - .5) * R, 0];
      const mid = [MOUTH[0] + (prnd() - .5) * 1.4, MOUTH[1] + (prnd() - .5) * 1.8, MOUTH[2] + (prnd() - .5) * 1.2];
      const en = [17 + prnd() * 7, (prnd() - .5) * 8, 4 + prnd() * 7];
      const tq = t0 + prnd() * .16, dur = 1.25 + prnd() * .6, seed = prnd() * 100;
      for (let k = 0; k < TRAIL; k++, w++) { dS.set(st, w * 3); dM.set(mid, w * 3); dE.set(en, w * 3); dT.set([tq, dur, k, seed], w * 4); }
    }
  }
  geoD.setAttribute('position', new THREE.BufferAttribute(dS, 3));
  geoD.setAttribute('aMid', new THREE.BufferAttribute(dM, 3));
  geoD.setAttribute('aEnd', new THREE.BufferAttribute(dE, 3));
  geoD.setAttribute('aT', new THREE.BufferAttribute(dT, 4));
  const UD = {uTime: {value: 0}, uScale: {value: 1}, uMap: {value: glowTexture('rgba(255,236,200,1)', 'rgba(255,77,109,1)', 'rgba(255,40,60,0)')}, uOn: {value: launch ? 1 : 0}};
  const dotMat = new THREE.ShaderMaterial({
    uniforms: UD, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec3 aMid, aEnd; attribute vec4 aT; uniform float uTime, uScale; varying float vA, vHot;
      void main(){
        float s = (uTime - aT.x - aT.z*.016) / aT.y;
        float e = clamp(s, 0., 1.); e = e*e*.45 + e*.55;                         // they accelerate out
        vec3 p = (1. - e)*(1. - e)*position + 2.*(1. - e)*e*aMid + e*e*aEnd;     // pulled through the mouth
        float sw = sin(e*11. + aT.w)*.35*(1. - e)*e*4.;                          // a little turbulence in the river
        p += vec3(0., sw, sw*.6);
        vA = step(0., s) * step(s, 1.) * (1. - aT.z/${TRAIL}.) * (1. - smoothstep(.8, 1., s));
        vHot = 1. - smoothstep(0., .25, s);                                       // white-hot as it leaves the cell
        vec4 mv = modelViewMatrix * vec4(p, 1.);
        gl_PointSize = (1. - aT.z/${TRAIL + 1}.) * (14. + 10.*vHot) * uScale / max(.5, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform sampler2D uMap; uniform float uOn; varying float vA, vHot;
      void main(){ vec4 c = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(max(c.rgb*c.a*vA*uOn*(1. + vHot), 0.), 1.); }`,
  });
  const dots = new THREE.Points(geoD, dotMat); dots.frustumCulled = false; scene.add(dots);

  /* ---------------- the console, driven by t ---------------- */
  const el = id => $(`#${id}`);
  const hms = s => { const x = 14 * 3600 + 2 * 60 + 10 + Math.floor(Math.max(0, s)); return [x / 3600, (x / 60) % 60, x % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':'); };
  const sorted = [...posts].sort((a, b) => a.land - b.land);
  // caught: every post is already published; bot j's posts flip at its turn
  const CT0 = .85, CSTEP = .096;
  UH.uCaughtT0.value = launch ? 1e3 : CT0; UH.uCaughtStep.value = CSTEP;
  let lastLog = '';
  // the pointer: keyframes [t, target (element id or [x, y] in DOM px), clickAt?]; it aims at the real elements
  const CUR = [[0, [560, 760]], [.25, [560, 700]], [.6, 'hBots', .65], [.9, 'hPpb', .95], [1.2, 'hScen', 1.25], [1.6, 'hAttack'], [1.8, 'hAttack', 1.85], [2.6, [880, 470]]];
  const clicks = CUR.filter(k => k[2]).map(k => k[2]);
  const at = target => {
    if (Array.isArray(target)) return target;
    const e = el(target), u = ctx.ui.getBoundingClientRect(), r = e.getBoundingClientRect(), sc = u.width / ctx.uiW;
    return [(r.left - u.left + r.width * .55) / sc, (r.top - u.top + r.height * .6) / sc];
  };
  const curAt = t => {
    if (!launch) return null;
    let a = CUR[0];
    for (const b of CUR) { if (t <= b[0]) { const k = ss(0, 1, (t - a[0]) / Math.max(1e-6, b[0] - a[0])), pa = at(a[1]), pb = at(b[1]); return [pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k]; } a = b; }
    return at(a[1]);
  };

  function frame(t, c) {
    UH.uTime.value = t; UD.uTime.value = t; UD.uScale.value = c.px / 810;
    // settings change on the clicks: Bots 12 → 25, Posts per bot 2 → 4, Scenario Copypasta → Paraphrase
    if (launch) {
      const [cb, cp, cs, ca] = clicks;
      UH.uArmed.value = t >= cb ? BOTS : 12; UH.uArmT.value = cb;
      el('hBots').textContent = t >= cb ? BOTS : 12;
      el('hPpb').textContent = t >= cp ? PPB : 2;
      el('hTotal').textContent = `= ${(t >= cb ? BOTS : 12) * (t >= cp ? PPB : 2)} posts`;
      el('hScen').textContent = t >= cs ? 'Paraphrase' : 'Copypasta';
      el('hBots').classList.toggle('hot', t >= cb - .15 && t < cb + .45);
      el('hPpb').classList.toggle('hot', t >= cp - .15 && t < cp + .45);
      el('hScen').classList.toggle('hot', t >= cs - .15 && t < cs + .45);
      el('hAttack').classList.toggle('down', t >= ca && t < ca + .14);
      el('hAttack').classList.toggle('armed', t >= cs + .2 && t < ca);
      el('hMsg').textContent = t >= ca + .12 ? `Campaign c7f3a1 launched: ${BOTS * PPB} posts until 14:09:41 UTC.` : 'Ready.';
      // the shot: a recoil of the camera and a burst of RGB shift on each volley (and the click)
      const kick = [ca, ...VOLLEYS].reduce((s, at) => s + pulse(t, at, 9), 0);
      c.shake = kick * .004; c.rgb = kick * .0035;
      c.fade = 1 - ss(0, .4, t) + ss(5.9, 6.6, t);
      // the numbers, big: 12 → 25 bots, × 4 posts = 100, then the posts going out, counted as they leave
      const nb = t >= cb ? BOTS : 12, np = t >= cp ? PPB : 2, out = posts.filter(p => p.t0 <= t).length;
      el('cBots').textContent = nb;
      el('cMath').textContent = `× ${np} posts = ${nb * np}`;
      el('cOut').textContent = out;
      el('hCount').style.opacity = ss(.3, .6, t);
      el('cBots').style.transform = `scale(${1 + .35 * pulse(t, cb, 6)})`;
      el('cMath').style.transform = `scale(${1 + .3 * pulse(t, cp, 6)})`;
      el('cOutBox').style.opacity = ss(ca, ca + .2, t);
      el('cOut').style.transform = `scale(${1 + VOLLEYS.reduce((a, at) => a + .12 * pulse(t, at, 9), 0)})`;
      ctx.bloom.strength = .65 + kick * .35;
    } else {
      c.fade = 1 - ss(0, .4, t) + ss(6.6, 7.4, t);
      el('cBots').textContent = BOTS; el('cMath').textContent = `× ${PPB} posts = ${BOTS * PPB}`;
      const caughtN = clamp(Math.floor((t - CT0) / CSTEP) + 1, 0, CAUGHT);
      el('cOut').textContent = caughtN; el('cOutBox').querySelector('span').textContent = 'bots caught';
      el('cOutBox').classList.add('ok');
      el('hCount').style.opacity = ss(.2, .6, t);
      UH.uDie.value = ss(CT0 + BOTS * CSTEP + .8, CT0 + BOTS * CSTEP + 2.2, t) * (CAUGHT === BOTS ? 1 : .35);
      c.rgb = pulse(t, CT0, 6) * .002;
    }
    // log + stats
    const shown = launch ? sorted.filter(p => p.land <= t) : sorted;
    const html = shown.slice(-14).reverse().map(p => {
      const caught = !launch && p.j < CAUGHT && t >= CT0 + p.j * CSTEP;
      const fresh = launch && t - p.land < .3;
      return `<li class="${fresh ? 'new' : ''}"><time>${hms((p.land - VOLLEYS[0]) * 90)}</time><div><span class="who">${p.who}</span> <span class="txt">${p.text}</span></div><span class="det ${caught ? 'on' : ''}">${caught ? '✓ detected' : '· unseen'}</span></li>`;
    }).join('');
    if (html !== lastLog) { el('log').innerHTML = html; lastLog = html; }
    const bots = new Set(shown.map(p => p.j)).size;
    el('sPosted').textContent = shown.length ? `${shown.length}` : '—';
    el('sBots').textContent = shown.length ? `${bots} / ${BOTS}` : '—';
    const nC = launch ? 0 : clamp(Math.floor((t - CT0) / CSTEP) + 1, 0, CAUGHT);
    el('sCaught').textContent = shown.length ? `${nC} / ${BOTS}` : '—';
    el('sTime').textContent = !launch && t >= CT0 - .45 ? FIRST : '—';
    el('sTimeBox').classList.toggle('flash', !launch && t >= CT0 - .45 && t < CT0 + .5);
    el('sCaughtBox').classList.toggle('flash', !launch && t >= CT0 && t < CT0 + BOTS * CSTEP + .3);
    if (!launch && t >= CT0 + BOTS * CSTEP + .5) el('hMsg').textContent = `Campaign finished: the radar caught ${CAUGHT} of ${BOTS} bots.`;
    else if (!launch) el('hMsg').textContent = `Campaign c7f3a1 launched: ${BOTS * PPB} posts until 14:09:41 UTC.`;
  }
  function after(t) {
    const cur = el('cur'), p = curAt(t);
    cur.style.display = p ? '' : 'none';
    if (p) { const down = clicks.some(at => t >= at && t < at + .12); cur.style.transform = `translate(${p[0]}px,${p[1]}px) scale(${down ? .86 : 1})`; }
  }
  ctx.start();
}
