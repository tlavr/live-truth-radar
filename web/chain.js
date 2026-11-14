// What made a group stand out (T12e), for the "Why" panel of the selected group: one plain sentence (gist)
// and under it one short phrase per detector step (reasons).
// The figures behind each step (threshold, integration gain, evidence path, news check) live on the
// "How we got here" sheet and page (steps.js); the main screen only states their outcome.

// CFAR threshold in noise widths. Not in the Finding payload: the same constant as steps.js (kept here too,
// steps.js imports this module through groups.js) and detect/config.py; it goes stale if k ever changes.
const CFAR_K = 3;
const CLOSE_MISMATCH_BINS = 3;   // ambiguity rows 0..0.3 = "nearly the same meaning", as in steps.js
const NEWS = ['news echo: ', 'news reprint: ', 'viral echo: '];   // detect/news_echo.py, detect/viral_echo.py

const sum = g => (g ?? []).flat().reduce((a, b) => a + b, 0);
const pct = x => `${Math.round(x * 100)}%`;
const widths = db => 10 ** (db / 20);          // dB of a z statistic -> noise widths
const posts = n => `${n} ${n === 1 ? 'post' : 'posts'}`;
const times = x => x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1).replace(/\.0$/, '')}×`;

/** True only when the news check overruled the evidence: the path reached the upper line, yet nothing was decided
 *  (detect/pipeline.py resets a "coordinated" result to "watching" with no deciding post; other verdicts keep the note). */
export function heldByNews(f) {
  const t = f?.sprt_trace ?? [];
  return NEWS.some(p => f?.note?.startsWith(p)) && f.decided_at_item == null && t.length > 0 && t.at(-1) >= f.sprt_upper;
}

/** Where a value in noise widths stands against the alarm line. */
const standing = v => v < CFAR_K ? 'close to the noise' : v < CFAR_K * 1.5 ? 'just past the alarm line' : 'well past the alarm line';

/** Share of the pairs that are close in time and nearly the same in meaning (same quantity as steps.js). */
function closeShare(counts) {
  const all = sum(counts);
  return all ? sum((counts ?? []).slice(0, CLOSE_MISMATCH_BINS)) / all : null;
}

/** The group in plain words: how much of it matches (its own share, the figure "Why" shows) and where it stands against the alarm line. */
export function gist(f) {
  if (heldByNews(f)) return f.note.startsWith('viral echo: ') ? 'Looks coordinated, but the same message also spreads outside the group, so it is not flagged.' : 'Looks coordinated, but it repeats a news article, so it is not flagged.';
  if (f.verdict === 'organic') return 'They stood out from the background, but the post-by-post test cleared them.';
  const g = closeShare(f.ambiguity?.counts), all = widths(f.snr_db);
  const share = g == null ? '' : `Their posts ${g < .05 ? 'rarely' : g < .5 ? 'partly' : 'mostly'} match. `;
  return `${share}Together they are ${standing(all)}.`;
}

/** What made a group stand out: one short phrase per detector step that says something about it. */
export function reasons(f) {
  const out = [], all = widths(f.snr_db), one = f.snr_db_single != null ? widths(f.snr_db_single) : null;
  const g = closeShare(f.ambiguity?.counts), bg = closeShare(f.ambiguity?.background);
  if (g != null) out.push(`${pct(g)} of pairs match${bg == null ? '' : ` (${pct(bg)} elsewhere)`}`);
  out.push(one != null && all / one >= 1.05 ? `${times(all / one)} stronger as a group` : `Together ${standing(all)}`);
  const t = f.sprt_trace, d = f.decided_at_item;
  if (heldByNews(f)) out.push(f.note.startsWith('viral echo: ') ? 'Held back: spreads outside the group too' : 'Held back: repeats a news article');
  else if (d != null) out.push(t[d] >= f.sprt_upper ? `Decided at post ${d + 1}` : `Cleared at post ${d + 1}`);
  else if (t.length) out.push(t.at(-1) >= f.sprt_upper ? `Evidence reached the line after ${posts(t.length)}` : `Not decided after ${posts(t.length)}`);
  return out;
}
