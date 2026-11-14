// The groups of one topic as the dashboard and the "How we got here" page both name them (T12e):
// the same order, the same letters and the same verdict words on every page.
import {heldByNews} from './chain.js';

const RANK = {coordinated: 0, watching: 1, organic: 2};
/** Verdict in the page's words. "Coordinated behaviour", never "bots": we measure synchrony, not intent. */
export const LABEL = {coordinated: 'Swarm detected', watching: 'Suspicious', organic: 'Nothing unusual'};
/** The same verdicts as a headline (the result title on the dashboard and on /explain). */
export const TITLE = {coordinated: 'Swarm Detected', watching: 'Suspicious', organic: 'Nothing unusual'};
export const HELD = 'Not flagged';          // the news check overruled the evidence (RadarFrame.top_capped on /live)
export const LETTER = k => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[k] ?? '•';

/** A topic's groups in display order: flagged first, then possible, then the rest; in time order inside each
 *  (a group is one wave of posts, so the list reads top to bottom in time). */
export const ordered = findings => [...findings]
  .sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || a.first_seen.localeCompare(b.first_seen) || a.id.localeCompare(b.id));

export const verdictLabel = f => heldByNews(f) ? HELD : LABEL[f.verdict];
export const verdictTitle = f => heldByNews(f) ? HELD : TITLE[f.verdict];

/** One group as a line of a group picker: "B · 8 accounts · Suspicious". */
export const optionText = (f, k) => `${LETTER(k)} · ${f.accounts.length} accounts · ${verdictLabel(f)}${f.synthetic ? ' · test' : ''}`;
