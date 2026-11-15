// Outro: silence. Black; the red dot; one sonar ring over a calm field that comes and goes; the dashboard's wordmark
// (ui/radar.css) builds around the dot, which settles into the "ı"; the tagline; the test-mode plate.
// ?tag="Find the swarm. Not the opinion." · ?url=srv2159471.hstgr.cloud
import {createStage, THREE, PAL, ss, pulse, qs, makeField} from './core.js';

const TAG = qs('tag', 'Find the swarm. Not the opinion.');
const URL_ = qs('url', 'srv2159471.hstgr.cloud');
const UI = `
<div class="p-outro">
  <div>
    <h1 class="hero-wordmark" style="font-size:76px;margin:0 0 10px">L<span class="idot">ı<i id="iDot"></i></span>ve Swarm Radar</h1>
    <div class="tagline" id="tag">${TAG}</div>
  </div>
  <div class="plate" id="plate"><b>BotHive</b> is our red-team test mode · every bot post it makes is synthetic and flagged in the data<br>
    ${URL_} · Hostinger · Context.dev · Gemini · Junction 2026</div>
  <div id="bigDot" style="position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:#FF4040;box-shadow:0 0 26px rgba(255,64,64,.95);opacity:0"></div>
</div>`;

export function run() {
  const ctx = createStage({
    id: 'outro', title: 'Outro', duration: 9, ui: UI, fov: 35, bloom: {strength: .7, radius: .6, threshold: .1},
    path: [{t: 0, p: [0, 26, 30], l: [0, 0, 0]}, {t: 9, p: [0, 24, 28], l: [0, 0, 0]}],
    frame, after,
  });
  const {scene, $} = ctx;
  const F = makeField({W: 44, D: 28, NX: 140, NZ: 90});
  F.U.uCalm.value = 1; F.U.uRingSpeed.value = 7; F.U.uRingT.value = 1.6;
  scene.add(F.mesh);
  const RING = 1.6;
  function frame(t, c) {
    F.U.uTime.value = t;
    F.U.uA.value = ss(RING, RING + .6, t) * .55 * (1 - ss(4.2, 5.6, t));    // the field shows only while the ring crosses it
    ctx.bloom.strength = .6 + pulse(t, RING, 3) * .6;
    c.fade = 0;
  }
  function after(t) {
    const word = $('.hero-wordmark'), idot = $('#iDot'), big = $('#bigDot');
    // the dot: on at 0.6, pulses, then (5.0 → 5.9) flies up into the "ı" while the wordmark fades in around it
    const u = ctx.ui.getBoundingClientRect(), r = idot.getBoundingClientRect(), sc = u.width / ctx.uiW;
    const to = {x: (r.left - u.left + r.width / 2) / sc - ctx.uiW / 2, y: (r.top - u.top + r.height / 2) / sc - ctx.uiH / 2};
    const k = ss(5.0, 5.9, t);
    big.style.opacity = t >= .6 && t < 5.9 ? ss(.6, .9, t) * (.8 + .2 * Math.sin(t * 5)) : 0;
    big.style.transform = `translate(${to.x * k}px,${to.y * k}px) scale(${(1 + .35 * pulse(t, RING, 4)) * (1 - .45 * k)})`;
    word.style.opacity = ss(5.2, 6.2, t);
    idot.style.opacity = t >= 5.9 ? .75 + .25 * Math.exp(-(t - 5.9) * 4) : 0;
    $('#tag').style.opacity = ss(6.5, 7.2, t);
    $('#plate').style.opacity = ss(7.3, 8.0, t);
  }
  ctx.start();
}
