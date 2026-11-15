# Labeling live accounts (T14)

Goal: `live_precision` and `live_fpr` in `/api/metrics` on real accounts. Formulas and reweighting are described in [signal-processing.md §3.10](signal-processing.md#310-metrics-pd-pfa-precision), and the file format is in [HANDOFF §5](HANDOFF.md#5-task-plan).

## What we label
A row in `eval/labels.csv` = one account in one topic. For the news stream, an account = **publisher domain** (outcome of T2), so we label publishers, not people. Look only at the account's posts in the detector window (the `review.md` sheet), not from memory about the publisher.

The `verdict` column indicates where the row in the sample came from (`coordinated` = alert, `watching` = top-up, empty = random without an alert). **Label without looking at verdict:** base the decision on the posts, not on the detector.

## Rubric
| `label` | When to assign |
|---|---|
| `suspicious` | Nearly verbatim text (headline/lead) across multiple accounts within minutes, **without** a link to a common primary source; content farm or clone aggregator (no editorial staff, "About us", or authors; mass rewriting of others' articles); a batch of posts with the same narrative and identical phrasing; fly-by-night domain. |
| `organic` | Recognizable publication with its own framing (its own headline, details, and author); a wire-service reprint (AP, Reuters, AFP, dpa…) **with attribution** — that is a "news echo", not a swarm; matching wording is explained by a common primary source (press release, statement, quote). |
| `unclear` | Too few posts (1–2) to decide; site unavailable; signals pointing both ways. Excluded from formulas, and the `unclear` count is recorded honestly. |

Rules:
- If in doubt between `suspicious` and `organic`, assign `unclear`—do not guess.
- There is no synthetic data in the sample (the script excludes it). If any is still visible (`synthetic`, `campaign_id`), delete the row and tell P1.
- ~20–40 s per account. For 50 rows, ≈ 30 min.

## `note` (goes to public git)
Reason only, **without handles, domains, names, or URLs**: "rewrite without attribution", "wire reprint", "1 post, too little data". Pre-commit check: no handle from `cache/label_handles.csv` appears in `eval/`.

## Procedure
1. On VPS: `ssh $VPS 'cd live-truth-radar && docker compose -f infra/docker-compose.yml exec -T api python -m ingest.label_sample --review'` → `cache/labels/` (`labels.csv`, `labels_meta.json`, `review.md`).
2. Locally: `scp` from `cache/labels/` and `cache/label_handles.csv` (commands in the docstring of `ingest/label_sample.py`), `cp -n cache/labels/labels.csv cache/labels/labels_meta.json eval/`. If `eval/` already contains an old unlabeled `labels.csv`, delete it first: `cp -n` will not replace it, and the numbers from `review.md` will drift out of sync with the rows.
3. Using `cache/labels/review.md` (number = row of `labels.csv` excluding the header), fill in `label` and `note` in `eval/labels.csv`.
4. `make eval` → check `n_labelled`, `live_precision`, `live_precision_ci`, `live_fpr` in `eval/report.json` → `make test` → commit `eval/labels.csv`, `eval/labels_meta.json`, `eval/report.json` → PR → `make deploy` → `make smoke`.

`review.md` and `label_handles.csv` contain real handles and live only in `cache/` (git-ignored).

## Labeling summary (14.11)
Sample from VPS: 6 h window, 5 topics, 51 accounts (`coordinated` 0, `watching` 9, without alert 42; `--n-quiet 42` to get ≥ 40 rows in the formulas). Labeling: model draft based on this rubric, human-verified (P1). Outcome: organic 49, unclear 1, suspicious 1 (without alert). `n_labelled = 42`, `live_fpr = 0.0`. `live_precision` is undefined: there were no live `coordinated` in the window. Write it exactly like this in the submission.
