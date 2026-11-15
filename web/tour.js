/* First-visit tour: a question first (take the tour / skip and never show again), then a step-by-step overlay
   over the live page: the start page, then a topic is checked for real and the tour walks the result page.
   Both answers end the offer for good (localStorage). The "?" button (or /?tour) replays it.
   Spotlight = a box with a huge box-shadow: no backdrop-filter, which crashed Safari's GPU over the 3D scene.
   A step whose element is not on screen shows centred. */
(() => {
  const KEY = 'lsr.tour.v2', $ = id => document.getElementById(id), root = document.documentElement;
  const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const put = v => { try { localStorage.setItem(KEY, v); } catch { /* private mode: asked again next time */ } };
  const stage = () => root.dataset.stage;
  const sens = on => { if (!$('alphaChip').hidden && $('fa').hidden === on) $('alphaChip').click(); };   // the app's own toggle

  // the start page, then the result page; `sel` = element to light up, `in`/`out` = what the step opens/closes
  const STEPS = [
    {sel: '#q', t: 'Search a topic', d: 'Type a topic or pick one from the list. The latest alerts are listed there too.'},
    {sel: '#fa', t: 'Target false alarm rate', d: 'How many false alarms you accept. 2% = about 2 of 100 calm topics get flagged by mistake. Lower = stricter, fewer alerts. Later, "!" shows the details.',
      in: () => sens(true), out: () => sens(false)},
    {sel: '.info', t: 'Metrics', d: 'Top right: how well the detector works, measured on test data.'},
    {sel: '#playBtn', t: 'Run the check', d: 'Press play to check a topic. Next, we run it for you on a real topic.', run: true},
    {sel: '#pipe', t: 'Checking…', d: 'Collect posts, compare their meaning and timing, measure the noise, give a verdict.', wait: true},
    {sel: '#scene', t: 'The map', d: 'Time runs along one axis, meaning gap along the other, height = how far above the usual level (dB). A peak = many posts saying the same thing at the same moment. After the tour: drag to turn the view, click a peak to see its posts.'},
    {sel: '#vHead', t: 'Groups and verdict', d: 'The verdict on top. Each letter is a group of accounts: after the tour, click one to show it.'},
    {sel: '#gLine', t: 'Why, What they say, How we got here', d: 'Why: the verdict in plain words. What they say: the lines the group repeats. How we got here: every step of the detector.'},
    {sel: '#strip', t: 'Timeline', d: 'Every group as a dot at its time. Drag to move along time, scroll or pinch to zoom. Click a dot to show its group, click empty time to rewind the map there.'},
    {sel: '#strip .nowbtn', t: 'Back to Now', d: 'After a rewind, "Now" brings the map back to live.'},
    {sel: '.ctrl', t: 'Live scan', d: 'The scan stays live: pause or stop it here. The logo takes you back to the start page.'},
    {sel: null, t: 'Try to fool it', d: 'In the Bot hive you launch your own fake campaign and watch whether the radar catches it. "?" at the top replays this tour.',
      link: ['/redteam', 'Open the Bot hive']},
  ];
  const RUN = STEPS.findIndex(s => s.run), WAIT = RUN + 1, FIRST_RESULT = RUN + 2, LAST = STEPS.length - 1;

  let i = -1, box, hole, card, waitT, giveUp, fetching = false, asking, opened = false;   // opened: the tour ran the check itself

  const visible = e => {
    if (!e || e.closest('[hidden]')) return false;
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && +cs.opacity > .05;
  };

  function place() {
    if (!card) return;
    const t = STEPS[i].sel && document.querySelector(STEPS[i].sel);
    const phone = innerWidth < 600, r = visible(t) ? t.getBoundingClientRect() : null;
    hole.hidden = !r; box.classList.toggle('tour-dim', !r);
    card.classList.toggle('tour-mid', !r && !phone);
    card.classList.toggle('tour-top', !!(phone && r && r.top + r.height / 2 > innerHeight * .55));   // phones: card above low targets
    card.style.left = card.style.top = '';
    if (r) {
      const pad = 6, top = Math.max(r.top - pad, 4), bot = Math.min(r.bottom + pad, innerHeight - 4);
      const left = Math.max(r.left - pad, 4), right = Math.min(r.right + pad, innerWidth - 4);
      Object.assign(hole.style, {left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bot - top}px`});
    }
    if (phone || !r) return;                       // phones: docked at the bottom (CSS); no target: centred (CSS)
    const ch = card.offsetHeight, cw = card.offsetWidth, gap = 14;
    let y = r.bottom + gap;
    if (y + ch > innerHeight - 12) y = r.top - gap - ch;
    if (y < 12) y = Math.max(12, (innerHeight - ch) / 2);   // the target fills the screen (the map): centre the card
    card.style.top = `${y}px`;
    card.style.left = `${Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), innerWidth - cw - 12)}px`;
  }

  function show(n) {
    if (!card) return;
    STEPS[i]?.out?.();
    clearInterval(waitT); clearTimeout(giveUp);
    i = n; const s = STEPS[i];
    s.in?.();
    const act = i === LAST ? 'done' : s.run ? 'run' : 'next';
    card.innerHTML = `
      <button class="tour-x" type="button" data-act="close" aria-label="Close the tour">&times;</button>
      <p class="tour-n">${i + 1} / ${STEPS.length}</p>
      <h2 id="tourTitle">${s.t}</h2>
      <p class="tour-d">${s.d}</p>
      ${s.link ? `<a class="tour-link" href="${s.link[0]}">${s.link[1]} &rarr;</a>` : ''}
      <div class="tour-nav">
        ${i && !s.wait ? '<button type="button" data-act="back">Back</button>' : ''}
        ${s.wait ? '' : `<button type="button" class="tour-next" data-act="${act}">${{done: 'Done', run: 'Run it', next: 'Next'}[act]}</button>`}
      </div>`;
    place();
    requestAnimationFrame(place);                  // after the step's own UI (the slider menu) has laid out
    setTimeout(place, 500);                        // and after its open animation
    (card.querySelector('.tour-next') ?? card.querySelector('.tour-x')).focus({preventScroll: true});
    if (s.wait) waitT = setInterval(() => {
      place();
      if (stage() === 'result') { clearInterval(waitT); setTimeout(() => i === WAIT && show(FIRST_RESULT), 700); }
    }, 200);
  }

  async function run() {
    if (stage() === 'result') return show(FIRST_RESULT);   // a topic is already open
    if (!$('q').value.trim()) {                     // nothing typed yet: take the first monitored topic
      if (fetching) return; fetching = true;
      const topics = await fetch('/api/topics').then(r => r.json()).catch(() => []);
      fetching = false;
      if (!card || i !== RUN) return;               // closed or moved on while it loaded
      if (!topics.length) return show(LAST);
      $('q').value = topics[0];
    }
    show(WAIT);
    giveUp = setTimeout(() => { if (i === WAIT && stage() === 'home') show(LAST); }, 4000);   // not a monitored topic
    opened = true;
    $('playBtn').click();                          // on the start page it submits the search (app.js); Safari < 16 has no requestSubmit
  }

  // Back never leaves the result page: from its first step it goes to "Run the check", skipping "Checking…"
  const back = () => show(i === FIRST_RESULT || (i === LAST && stage() !== 'result') ? RUN : i - 1);

  function end() {
    STEPS[i]?.out?.(); clearInterval(waitT); clearTimeout(giveUp);
    box?.remove(); box = card = hole = null; i = -1;
    if (opened && stage() !== 'home') $('stopBtn').click();   // the tour's own check: stop its scan, back to the start page
    opened = false;
    $('tourBtn')?.focus({preventScroll: true});    // focus back where the tour can be replayed
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
    const s = STEPS[i];
    const go = e.key === 'Escape' ? end
      : e.key === 'ArrowRight' && !s.wait && !s.run && i < LAST ? () => show(i + 1)
      : e.key === 'ArrowLeft' && i && !s.wait ? back : null;
    if (!go) return;
    e.preventDefault(); e.stopImmediatePropagation(); go();
  }

  function frame(cls, html) {
    const b = document.createElement('div');
    b.className = `tour ${cls}`; b.innerHTML = html;
    b.addEventListener('pointerdown', e => e.stopPropagation());   // the app closes its menus on a press elsewhere
    document.body.append(b);
    return b;
  }

  function start() {
    closeAsk();
    if (box) return;
    put('done');
    box = frame('', '<div class="tour-shade"></div><div class="tour-hole" hidden></div><div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle"></div>');
    hole = box.querySelector('.tour-hole'); card = box.querySelector('.tour-card');
    card.addEventListener('click', e => {
      if (e.target.closest('.tour-link')) return;
      const a = e.target.closest('button')?.dataset.act;
      ({next: () => show(i + 1), back, run, close: end, done: end})[a]?.();
    });
    addEventListener('resize', place); addEventListener('scroll', place, true); addEventListener('keydown', key, true);
    show(stage() === 'result' ? FIRST_RESULT : 0);
  }

  function closeAsk() { asking?.remove(); asking = null; removeEventListener('keydown', askKey, true); }
  function askKey(e) {   // the question: Escape = skip, focus stays on its two buttons
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); put('never'); closeAsk(); }
    else if (e.key === 'Tab') {
      const f = [...asking.querySelectorAll('button')], k = f.indexOf(document.activeElement);
      e.preventDefault(); f[(k + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
    }
  }
  function ask() {
    if (box || get()) return;                      // a tour already runs ("?" pressed first) or answered already
    const o = asking = frame('tour-ask tour-dim', `<div class="tour-shade"></div>
      <div class="tour-card tour-mid" role="dialog" aria-modal="true" aria-labelledby="tourAsk">
        <h2 id="tourAsk">Take a quick tour?</h2>
        <p class="tour-d">A short walk through the radar: search, sensitivity, metrics, then a real check and how to read it.</p>
        <div class="tour-nav"><button type="button" data-a="skip">Skip, don't show again</button><button type="button" class="tour-next" data-a="go">Start the tour</button></div>
      </div>`);
    o.addEventListener('click', e => {
      const a = e.target.closest('button')?.dataset.a; if (!a) return;
      if (a === 'go') return start();
      put('never'); closeAsk();
    });
    addEventListener('keydown', askKey, true);
    o.querySelector('.tour-next').focus({preventScroll: true});
  }

  $('tourBtn')?.addEventListener('click', start);
  if (new URLSearchParams(location.search).has('tour')) setTimeout(start, 600);
  else if (!get()) setTimeout(ask, 900);           // after the first paint of the radar
})();
