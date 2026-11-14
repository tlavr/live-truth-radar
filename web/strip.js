// Group timeline of a topic (dashboard footer): one horizontal strip over the detector window, every group of the
// topic as a mark at its own time, coloured by verdict. Drag to pan, wheel or pinch to zoom; a mark picks its group,
// a click on empty time moves the map there. The span the map shows is drawn as a bracket; "Now" at the right end
// brings the map back to live.

const MIN_SPAN_MS = 10 * 60000;
const NOW_W = 78;                               // right end kept for the "Now" button: the time axis stops before it
const TICK_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180];
const hm = ms => new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});   // the viewer's clock

/**
 * `el`: the strip element; onPick(k): a group's mark was chosen; onTime(ms): empty time was clicked; onNow(): "Now".
 * set({t0, t1, live, marks: [{k, start, end, verdict, title, sel}], win: [start, end] | null}) draws it (ms).
 */
export function createStrip({el, onPick, onTime, onNow}) {
  let data = null, a = 0, b = 0, fitted = false;    // [a, b]: the time span on screen
  const width = () => Math.max(1, el.clientWidth - NOW_W);
  const x = t => (t - a) / (b - a) * width();
  const clamp = () => {
    const span = Math.min(Math.max(b - a, MIN_SPAN_MS), data.t1 - data.t0);
    a = Math.min(Math.max(a, data.t0), data.t1 - span); b = a + span;
  };

  function draw() {
    el.replaceChildren();
    if (!data) return;
    const w = width(), span = b - a;
    const step = (TICK_MIN.find(m => m * 60000 * w / span >= 90) ?? 360) * 60000;
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
      const tk = document.createElement('span');
      tk.className = 'tk'; tk.style.left = `${x(t)}px`; tk.textContent = hm(t);
      el.append(tk);
    }
    if (data.win) {
      const [s, e] = data.win, bx = document.createElement('span');
      bx.className = 'win'; bx.style.left = `${x(s)}px`; bx.style.width = `${Math.max(2, x(e) - x(s))}px`;
      bx.title = `On the map: ${hm(s)}–${hm(e)}`;
      el.append(bx);
    }
    const now = document.createElement('span');
    now.className = 'now'; now.style.left = `${x(data.t1)}px`;
    el.append(now);
    for (const m of data.marks) {
      const l = x(m.start), r = Math.max(x(m.end), l + 8);
      if (r < -20 || l > w + 20) continue;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'mk'; btn.dataset.k = m.k; btn.dataset.v = m.verdict;
      btn.setAttribute('aria-pressed', m.sel); btn.title = m.title; btn.setAttribute('aria-label', m.title);
      btn.style.left = `${l}px`; btn.style.width = `${r - l}px`;
      el.append(btn);
    }
    const nb = document.createElement('button');
    nb.type = 'button'; nb.className = 'nowbtn'; nb.dataset.live = data.live;
    nb.title = data.live ? 'The map is live' : 'Back to now: the map goes live';
    nb.innerHTML = '<i></i>Now';
    el.append(nb);
  }

  /* pan by dragging, zoom with the wheel (or a pinch on a trackpad) around the pointer */
  let drag = null;
  el.addEventListener('pointerdown', e => {
    if (!data) return;
    drag = {x: e.clientX, a, b, moved: false, id: e.pointerId};
  });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) { drag.moved = true; el.setPointerCapture(drag.id); el.classList.add('dragging'); }
    const dt = dx / width() * (drag.b - drag.a);
    a = drag.a - dt; b = drag.b - dt; clamp(); draw();
  });
  const end = e => {
    if (!drag) return;
    const was = drag; drag = null; el.classList.remove('dragging');
    if (was.moved || e.type !== 'pointerup') return;
    const mk = e.target.closest('.mk');
    if (e.target.closest('.nowbtn')) { const span = b - a; b = data.t1; a = b - span; clamp(); draw(); onNow?.(); }
    else if (mk) onPick?.(+mk.dataset.k);
    else { const r = el.getBoundingClientRect(), px = e.clientX - r.left; if (px <= width()) onTime?.(a + px / width() * (b - a)); }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', e => {
    if (!data) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), at = a + Math.min(e.clientX - r.left, width()) / width() * (b - a);
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const dt = e.deltaX / width() * (b - a); a += dt; b += dt; }
    else { const k = Math.exp(e.deltaY * .002); a = at - (at - a) * k; b = at + (b - at) * k; }
    clamp(); draw();
  }, {passive: false});
  el.addEventListener('keydown', e => {                // arrows pan when the strip has focus
    if (!data || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.target !== el) return;
    const dt = (b - a) * .2 * (e.key === 'ArrowLeft' ? -1 : 1); a += dt; b += dt; clamp(); draw();
  });
  new ResizeObserver(draw).observe(el);

  return {
    set(d) {
      const first = !data || !fitted;
      data = d;
      if (!d) { fitted = false; draw(); return; }
      if (first) { a = d.t0; b = d.t1; fitted = true; }           // a new topic: the whole window
      else if (b >= d.t1 - 60000 || b > d.t1) { const span = b - a; b = d.t1; a = b - span; }   // follows "now" when at the right end
      clamp(); draw();
    },
    reset() { fitted = false; },
  };
}
