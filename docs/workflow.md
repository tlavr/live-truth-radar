# Workflow: how the two of us work with agents

*Short and practical. Task cards: [tasks.md](tasks.md). Plan and schedule: [HANDOFF.md](HANDOFF.md). All times: Europe/Helsinki.*

## 1. The P1 / P2 split and why

| Who | Role | Folders | Tool |
|---|---|---|---|
| **P1 "Pipe"** | Context.dev ingest, Postgres, Docker Compose, Hostinger deployment (caddy HTTPS), FastAPI, Gemini explanations, dashboard, smoke | `ingest/ api/ web/ infra/` | Claude Code |
| **P2 "Brain"** | Gemini embeddings, topic beam + whitening, account-pair correlator, CFAR, SPRT, synthetic swarm generator, eval (ROC, metrics) | `detect/ synth/ eval/` | Claude Code (Codex — possibly later) |

We split **by layer**, not by feature, because there is exactly **one boundary** between layers:
- **Contract** `contracts/models.py` (`Item`, `Finding`, `Explanation`, `AlertsResponse`, `MetricsReport`) + function `detect.pipeline.detect(items) -> list[Finding]`. As long as the contract does not change, we stay out of each other's way.
- **Fixtures** `fixtures/items.json` and `fixtures/findings.json`: P2 runs completely offline (no network, no DB), and P1 displays data without waiting for the detector.
- **Mock detector** in P1 returns `fixtures/findings.json`. At I1 integration (Sat 15:00), it is replaced with the real `detect()` in a single line.

Result: before I1, nobody waits on anyone, and integration = "swap the import and check on live data".

## 2. T0 — kickoff (45 min, by Fri 22:00)

- [ ] Both read `CLAUDE.md` and skimmed `docs/tasks.md` (our own cards).
- [ ] Walked through `contracts/models.py` together: the fields are clear and nothing is missing. This is the last point when the contract can change freely.
- [ ] `make test` is green for both. Fixtures parse into the models.
- [ ] Chose 3–5 topics for polling (active, controversial, with social media) and recorded them in `.env.example` / HANDOFF.
- [ ] Not using Codex yet (writing with Claude). If we bring it in later, we maintain `docs/codex-log.md` starting from the very first task.
- [ ] Confirmed interfaces outside the contract (listed in HANDOFF §5, marked ⚙ in tasks.md): campaign generator for `/api/inject`, `eval/report.json` for `/api/metrics`, `eval/labels.csv`, `/api/source/{domain}`.
- [ ] Teammate added to the GitHub repository, and both can push branches.
- [ ] Agreed on the communication channel and sync points (§5).

## 3. Single-task cycle

1. **Fresh context**: `/clear` (new session) for each task. Do not drag in the tail of the previous task.
2. **Start**: prompt template from §10. The agent reads `CLAUDE.md`, its own card, and only the needed files.
3. **Plan mode**: the agent writes a plan: which files, which functions, which test, and how to verify "Done when".
4. **Human plan review (2–3 min)**: wrong file? touching someone else's folder? changing the contract? building a CUT feature? Fix before coding.
5. **Implementation** (implementer = main agent) + `make test` green (never start the loop on red).
6. **Verification loop**: at most 3 verification rounds and 2 fix rounds (details below).
7. **Human verification**: manual check of the "Done when" item from the card (run, inspect, `make smoke` after deploy), plus everything the verifiers put in `UNVERIFIED`.
8. **Small PR into main**. The main agent makes the commit after step 7 and only on the human's say-so. Subagents do not commit. We merge our own folders without cross-review, and `contracts/` only with both of us. In the PR description: how many verification rounds ran and what remains open.

### The "implement → verify → fix" loop
Subagents `verifier` and `analyzer` are described in `.claude/agents/`. The implementer and loop conductor is the main agent.
- **Verifiers** (`verifier`, read-only, edit nothing and run nothing that writes to the repo, accesses the network, or deploys): two parallel runs with different focuses.
  - `logic` = code correctness. For `detect/ synth/ eval/`: math against [signal-processing.md §3](signal-processing.md) and edge cases (empty input, single account, zero variance). For `ingest/ api/ web/ infra/`: DB schema, queries, error handling, compose/caddy configuration.
  - `fit` = "Done when" items, contract, test quality, others' folders, secrets, speed.
  - Every bug is confirmed by a run or an exact line quote, not a guess. Anything that cannot be verified offline (Docker, VPS, network, `make eval`) goes into the `UNVERIFIED` section with a command for the human and does not affect the verdict.
  - Outcome: `PASS` or `FAIL` and a list of findings.
- **Analyzer** (`analyzer`, runs alone after the verifiers finish): receives the findings, reproduces each one, rejects false positives with a reason, and for real ones writes a failing test and fixes the root cause. Does not weaken or delete tests, and does not touch `contracts/` or others' folders.

**Severity** (same everywhere):
- `BLOCKER` = proven wrong result, crash, unmet "Done when" item, red `make test`, secret or real handle in the diff, unapproved change to the contract or someone else's folder, or network calls in tests.
- `SHOULD-FIX` = proven defect that only manifests outside the "Done when" scenario, or a missing or vacuous test from the card.
- `NIT` = everything else. Does not affect the verdict and does not trigger the loop. The main agent passes only single-line NITs to the analyzer.
- `FAIL` = there is at least one `BLOCKER` or `SHOULD-FIX`. When in doubt between two severity levels, choose the lower one.

**"Task diff"** = working tree against merge-base with `origin/main`, including uncommitted changes and new files: `git diff $(git merge-base origin/main HEAD)` + `git ls-files --others --exclude-standard`. Before the loop, the main agent runs `git fetch origin main`. Each round checks the **entire** task diff anew, not just the latest edits, because a fix can break something adjacent.

**Algorithm** (iteration = one verification round):
```
round = 1
repeat:
    if make test fails → the last editor fixes it before any verifiers run
    verifiers review the entire task diff
    the main agent consolidates the reports
    if no BLOCKER or SHOULD-FIX remains (except findings marked "human decides") → done
    if round == 3 → stop and give the human the list to fix, simplify, or cut. Skip the analyzer.
    the analyzer reviews and fixes findings, then runs make test
    round += 1
```
A third fix is not made: unverified code never leaves the loop.

**What is passed between agents:**
- To the verifier: task ID, owner (P1/P2), round number, focus, and list of findings rejected or handed off to a human in previous rounds (with reasons).
- The main agent merges the reports: same location (`file:line`) and same cause = one finding with the highest severity. The round result is `FAIL` if at least one verifier reports `FAIL`. Findings are numbered `R<round>-<n>`.
- To the analyzer: task ID, owner, round number, and the merged, numbered list of findings.
- For each finding, the analyzer returns: "fixed" / "rejected" (with a reason) / "human decides".
- A verifier can only resubmit a rejected finding with a new reproduction that refutes the reason for rejection. A second rejection on the same finding = dispute: it goes to a human and no longer affects the verdict. If verifiers contradict each other, the analyzer's reproduction decides. If it is a design question, a human decides.
- "Human decides" (a design or contract decision is needed, or an edit outside one's own folders): the analyzer leaves the finding untouched, the main agent reports it to a human immediately, and the loop continues with the rest. It does not affect the verdict of subsequent rounds, but the task is not considered done until the human decides.

**Loop scope** (saving limits):
| What's in the diff | Loop |
|---|---|
| `detect/`, `synth/`, `eval/`, `ingest/`, `api/`, `infra/` (DB schema, compose, caddy), `contracts/` | Full: two verifiers |
| Only `web/`, only `tests/`, `Makefile`, or fewer than ~30 lines of code | One verifier focused on `both` |
| Only `docs/` and `*.md` | No loop |

The stopping rules are the same. Loop subagents do not count toward the "1–2 agents per person" limit (§4): verifiers are read-only and work in the same worktree.

**At the end, the main agent shows the human:** how many verification rounds ran, the findings table (number, severity, fixed / rejected with reason / human decides / open), the `UNVERIFIED` list with commands for manual verification, and the last line of `make test` output.

*Example:* T10. The implementer wrote the correlator. Round 1: verifier `logic` found `R1-1 BLOCKER`: "the lag is computed with the opposite sign; in the input, bot 2 is 80 s after bot 1, and the output is −80". The analyzer added a test for the lag sign, fixed it, and `make test` is green. Round 2: both verifiers report `PASS`. In the PR, we write "loop: 2 verification rounds, 1 fix, no open findings".

## 4. Git

- Branches: `p1/<task-id>-slug`, `p2/<task-id>-slug` (for example, `p1/T4-compose-skeleton`, `p2/T10-cfar-sprt`).
- Maximum 1–2 agents per person. Parallel agents for the same person: use separate **git worktree**s (`git worktree add ../ltr-T9 -b p2/T9-synth`), otherwise they overwrite each other's files.
- Merge into `main` every 1–2 hours in small PRs. `main` must always pass `make test`.
- Do not mention model names in commits or PRs. Commit messages must be in English.
- **Contract change protocol** (`contracts/models.py`):
  1. Whoever wants to make a change messages the other person: what, why, and whether it is backward-compatible (a new field with a default is almost always OK).
  2. Both agree → one `contract/<slug>` branch, editing the model + fixtures + `tests/test_contracts.py` in a single PR.
  3. Both rebase onto main immediately after the merge.
  4. Deleting/renaming fields after I1 — only if the demo does not work without it.

## 5. Sync checkpoints (10 minutes each)

Sat 04:30 (before P1's sleep) · Sat 11:00 · **I1 Sat 15:00** · Sat 19:00 · Sun 01:00.

10-minute checklist:
- [ ] Both merged completed work into `main`, and `make test` is green on main.
- [ ] Deployed `main` to the VPS, and `make smoke URL=https://<domain>` passes.
- [ ] Live chain: ingest writes items → detector (mock or real) → `/api/alerts` → dashboard.
- [ ] Checked status against tasks.md: what is done, what is behind schedule (§9).
- [ ] Are any contract changes needed? If yes, follow the protocol in §4.
- [ ] Each person's next 1–2 tasks and the time of the next sync.

## 6. Testing (minimal, but mandatory)

**We test:**
- `detect/`: synthetic unit tests per task card (T7: 3, T10: 6–8), entire `make test` < 5 s: lagged pair → correlation peak at the expected lag; independent random accounts → no alert; SPRT crosses the upper threshold on a known LLR sequence and the lower threshold on organic data; CFAR stays silent on a flat background and triggers on a spike.
- Contract: fixtures parse into models (2–3 tests, `tests/test_contracts.py`).
- `tests/smoke.py`: live `/health` and `/api/alerts`, schema check. After every deploy.

**We don't test:** UI, Context.dev/Gemini mocks (except Pydantic response validation), or coverage. There is no network access in `make test`: everything that calls Gemini/Context.dev is behind a flag or cached.

## 7. Saving limits

- What burns through limits is not tests, but **re-reading large docs**. The agent reads `CLAUDE.md` + the task card + the needed files, not the entire `docs/`.
- One task = one session. `/clear` between tasks.
- Task cards are small. If a task does not fit into a single plan, we split it into two.
- Do not ask to "improve everything": only the "Done when" criteria from the card.
- Cache Context.dev and Gemini responses to disk/DB: a repeated request costs the same credits.
- Do not paste entire long logs into the chat: only the last 30 lines or a grep for the error.

## 8. Codex for P2 and `docs/codex-log.md`

Not currently in use: we write code with Claude. This section is in case we bring it in later and P2 actually writes `detect/` (and/or `synth/`, `eval/`) in Codex. That is the honest path for the Codex tech challenge. If we did not use Codex, we do not write a log and do not claim Codex.

Entry format (one per task, brief, honest, including failures):

```markdown
## T10 · CFAR + SPRT · Sat 13:40
- Task: what was asked of Codex (1–2 lines).
- What Codex did: files/functions, how many iterations.
- What we fixed manually: errors, what had to be rewritten and why.
- Outcome: are tests green? in main?
```

## 9. If we fall behind

- **Checkpoint Sat 14:00 (T10):** the detector must find a synthetic swarm in the fixtures. If not → **we cut S1**, and P1 after T8/T11 helps P2 (integration, eval, debugging on live data). We simplify the math: first a working pair correlator + SPRT, and CFAR can be replaced with a fixed threshold on `R_ij`.
- We start S1 only if all MUST items, except T14 labeling, are ready by Sat 20:00.
- Any task falls behind by > 1 h → at the next sync we decide whether to simplify or cut. A live URL and honest metrics matter more than features.
- **F, Sun 02:00 — code freeze.** After: only fixes, video, slides, submit.

## 10. Prompt template for starting a task

```text
Task <ID> from docs/tasks.md. I am <P1 "Pipe" | P2 "Brain">.
Read CLAUDE.md and card <ID> in docs/tasks.md. Open other docs
only if the card or CLAUDE.md points to them.
First, a plan (plan mode): which files you will modify/create, which functions and signatures,
which test you will add, and how we will verify the "Done when" item. Do not write code until I approve the plan.
Constraints: only my folders (<ingest/ api/ web/ infra/ | detect/ synth/ eval/>),
do not touch contracts/, no network in tests, keys only from .env.
After implementation: make test, then the verification loop from docs/workflow.md §3 (loop scope per
the table there: verifier subagents with logic and fit focuses → analyzer fixes → verifier again;
at most 3 verification rounds and 2 fix rounds; if the third verification again finds a BLOCKER
or SHOULD-FIX, do not fix anything, stop, and show me the list).
At the end: show how "Done when" was satisfied, how many verification rounds ran, a table
of findings (fixed / rejected with reason / human decides / open), the UNVERIFIED list
with commands for manual verification, and the last line of make test. Do not commit without my go-ahead.
Propose a commit message in English without model names.
```
