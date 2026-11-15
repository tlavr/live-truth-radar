/* First-visit tour: a small offer card, then a step-by-step overlay over the live page.
   Offered once; "Don't show again", finishing or closing the tour stops the offer (localStorage).
   The "?" button (or /?tour) replays it. Spotlight = a box with a huge box-shadow: no backdrop-filter,
   which crashed Safari's GPU over the 3D scene. A step whose element is not on screen shows centred. */
(() => {
  const KEY = 'lsr.tour', $ = id => document.getElementById(id);
  const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const put = v => { try { localStorage.setItem(KEY, v); } catch { /* private mode: offer again next time */ } };

  const STEPS = [
    {el: 'q', t: 'Pick a topic', d: 'Type or choose a topic from the list: news and Bluesky posts about it are what we watch.'},
    {el: 'playBtn', t: 'Check it', d: 'Press play to check the topic. The scan then stays live: pause or stop it here.'},
    {el: 'scene', t: 'The radar', d: 'Each dot is a post: time runs along one axis, meaning along the other. Posts that say the same thing at the same time form a swarm.'},
    {el: 'gLine', t: 'The alert', d: 'Why: the verdict in plain words. What they say: the lines the group repeats. How we got here: every step of the detector.'},
    {el: 'alphaChip', t: 'False alarms', d: 'Set how many false alarms you accept. Lower = stricter, fewer alerts.'},
    {el: null, t: 'Try to fool it', d: 'In the Bot hive you launch your own fake campaign and watch whether the radar catches it.',
      link: ['/redteam', 'Open the Bot hive']},
  ];

  let i = 0, box, hole, card, target;

  const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== 'hidden'; };

  function place() {
    if (!card) return;
    const phone = innerWidth < 600, r = visible(target) ? target.getBoundingClientRect() : null;
    hole.hidden = !r; box.classList.toggle('tour-dim', !r);
    card.classList.toggle('tour-mid', !r && !phone);
    card.style.left = card.style.top = card.style.bottom = '';
    if (r) {
      const pad = 6, top = Math.max(r.top - pad, 4), bot = Math.min(r.bottom + pad, innerHeight - 4);
      Object.assign(hole.style, {left: `${r.left - pad}px`, top: `${top}px`, width: `${r.width + 2 * pad}px`, height: `${bot - top}px`});
    }
    if (phone || !r) return;                       // phones: docked at the bottom (CSS); no target: centred (CSS)
    const ch = card.offsetHeight, cw = card.offsetWidth, gap = 14;
    let y = r.bottom + gap;
    if (y + ch > innerHeight - 12) y = r.top - gap - ch;
    if (y < 12) y = Math.max(12, (innerHeight - ch) / 2);   // target fills the screen (the radar): centre the card
    card.style.top = `${y}px`;
    card.style.left = `${Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), innerWidth - cw - 12)}px`;
  }

  function show(n) {
    i = n; const s = STEPS[i], last = i === STEPS.length - 1;
    target = s.el && $(s.el);
    if (target && !visible(target)) target = null;
    card.innerHTML = `
      <button class="tour-x" type="button" data-act="close" aria-label="Close the tour">&times;</button>
      <p class="tour-n">${i + 1} / ${STEPS.length}</p>
      <h2 id="tourTitle">${s.t}</h2>
      <p class="tour-d">${s.d}${s.el && !target ? ' <span class="tour-later">(appears after you check a topic)</span>' : ''}</p>
      ${s.link ? `<a class="tour-link" href="${s.link[0]}">${s.link[1]} &rarr;</a>` : ''}
      <div class="tour-nav">
        <span class="tour-dots">${STEPS.map((_, k) => `<button type="button" data-go="${k}" aria-label="Step ${k + 1}"${k === i ? ' aria-current="step"' : ''}></button>`).join('')}</span>
        ${i ? '<button type="button" data-act="back">Back</button>' : ''}
        <button type="button" class="tour-next" data-act="${last ? 'done' : 'next'}">${last ? 'Done' : 'Next'}</button>
      </div>`;
    place();
    card.querySelector('.tour-next').focus({preventScroll: true});
  }

  function end() {
    put('done');
    box?.remove(); box = card = hole = null;
    removeEventListener('resize', place); removeEventListener('scroll', place, true); removeEventListener('keydown', key, true);
  }
  function key(e) {   // capture phase: the tour's keys never reach app.js (its Escape would leave the topic)
    if (e.key === 'Tab') {                         // keep focus inside the card
      const f = [...card.querySelectorAll('button,a')], a = f[0], z = f[f.length - 1];
      if (!card.contains(document.activeElement)) { e.preventDefault(); a.focus(); }
      else if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      return;
    }
    const go = e.key === 'Escape' ? end : e.key === 'ArrowRight' && i < STEPS.length - 1 ? () => show(i + 1)
      : e.key === 'ArrowLeft' && i ? () => show(i - 1) : null;
    if (!go) return;
    e.preventDefault(); e.stopImmediatePropagation(); go();
  }

  function start() {
    document.querySelector('.tour-offer')?.remove();
    if (box) return;
    box = document.createElement('div');
    box.className = 'tour';
    box.innerHTML = '<div class="tour-shade"></div><div class="tour-hole" hidden></div><div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle"></div>';
    document.body.append(box);
    hole = box.querySelector('.tour-hole'); card = box.querySelector('.tour-card');
    card.addEventListener('click', e => {
      if (e.target.closest('.tour-link')) return put('done');
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.go) return show(+b.dataset.go);
      ({next: () => show(i + 1), back: () => show(i - 1), close: end, done: end})[b.dataset.act]?.();
    });
    addEventListener('resize', place); addEventListener('scroll', place, true); addEventListener('keydown', key, true);
    show(0);
  }

  function offer() {
    const o = document.createElement('div');
    o.className = 'tour-offer'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-label', 'Site tour');
    o.innerHTML = `<p><b>New here?</b> A 6-step tour of the radar, under a minute.</p>
      <div class="tour-nav"><button type="button" data-a="never">Don't show again</button><button type="button" data-a="later">Later</button><button type="button" class="tour-next" data-a="go">Show me</button></div>`;
    o.addEventListener('click', e => {
      const a = e.target.closest('button')?.dataset.a; if (!a) return;
      if (a === 'go') return start();
      if (a === 'never') put('never');
      o.remove();
    });
    document.body.append(o);
  }

  $('tourBtn')?.addEventListener('click', start);
  const forced = new URLSearchParams(location.search).has('tour');
  if (forced) start();
  else if (!get()) setTimeout(offer, 1200);   // after the first paint of the radar
})();
