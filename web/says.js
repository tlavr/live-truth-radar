// "What they say" (T12e): the lines a group repeats, read off its own posts. No model is involved:
// two posts count as one point when most of the meaningful words of the shorter one appear in the other.

const STOP = new Set(('a an the of to in on for and or but is are was were be been it its this that these those with as at by from ' +
  'their they them we you i me my our your he she his her not no so if than then there here just very can will would should ' +
  'has have had do does did about into over out up down all any some more most what when who how why').split(' '));
const SAME_POINT = .5;   // share of the shorter post's words found in the other
const MIN_SHARED = 2;    // and at least this many words in common, so a one-word post does not join everything

const words = text => new Set(String(text ?? '').toLowerCase().replace(/https?:\S+/g, ' ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
function overlap(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n >= Math.min(MIN_SHARED, a.size, b.size) && (n >= MIN_SHARED || a.size === b.size) ? n / Math.min(a.size, b.size) : 0;
}

/**
 * Points a group makes, most shared first. `items` = the group's posts (any order).
 * Each point: {text (its earliest post), accounts (distinct authors), posts, items (the posts grouped under it, by time)}.
 */
export function points(items) {
  const out = [];
  for (const it of [...items].sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)))) {
    const w = words(it.text);
    if (!w.size) continue;
    let best = null, score = 0;
    for (const p of out) { const s = overlap(w, p.words); if (s > score) { score = s; best = p; } }
    if (best && score >= SAME_POINT) { best.items.push(it); best.authors.add(it.author); }
    else out.push({text: it.text, words: w, items: [it], authors: new Set([it.author])});
  }
  return out.map(p => ({text: p.text, posts: p.items.length, accounts: p.authors.size, items: p.items}))
    .sort((a, b) => b.accounts - a.accounts || b.posts - a.posts);
}

/**
 * Posts that form a pair with a post of another account lo..hi seconds away (hi exclusive): what a group
 * says at one delay. Uses post times only; how close two posts are in meaning is the detector's measure.
 */
export function saidWithin(items, lo, hi) {
  const t = items.map(it => Date.parse(it.published_at) / 1000), keep = new Set();
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const d = Math.abs(t[i] - t[j]);
    if (items[i].author !== items[j].author && d >= lo && d < hi) { keep.add(i); keep.add(j); }
  }
  return [...keep].map(i => items[i]);
}
