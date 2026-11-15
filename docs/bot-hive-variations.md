# Bot texts for Bot Hive: context for the agent

A document for the agent that will generate test data (swarm texts) for Bot Hive attacks (`/redteam`). Read `CLAUDE.md` first: project rules apply here as well.

## 1. Goal

Bot Hive (`/redteam`, `POST /api/attack`) launches a synthetic bot attack on a topic. Bot texts are **not generated on the fly**: they live in `synth/variations/<slug>.json` files (in git, working offline).

`GET /api/attack/topics` shows only topics that simultaneously:
1. exist in `TOPICS` on the VPS (currently 49 topics, listed in `docs/HANDOFF.md` §6).
2. have a `synth/variations/<slug>.json` file.

**Status (commit 725fb1e "Cover all monitored topics in Bot Hive"):** all 49 topics in `TOPICS` have files (plus the old `helsinki-tram-fares`, which is not in `TOPICS`). The first 3 were `europe-bomb-threat-hoaxes`, `jensen-huang-resignation` and `microsoft-global-outage`; the other 46 (table in §7) were added in that commit. Use this document to add a file for a new topic or to regenerate an existing one.

## 2. How text enters an attack (`api/main.py` `_attack_campaign`, `synth/campaign.py` `make_campaign`)

- Bots: 12 / 25 / 40, names are generated (`true_voice_123`), `source="synthetic"`, `platform="x"`.
- Posts per bot: 2 / 4 / 6. Two volleys. With 4 and 6 posts, the same two volleys repeat.
- **The attack uses only messages with `held_out: true`.** One such message is chosen per volley, and each bot posts one of its `variations` (bot `a` takes text `a % len(variations)` from the shuffled list, and with 40 bots and 30 variations, texts repeat).
- Scenarios:
  - `paraphrase`: different rephrasings of a single thesis (the main case).
  - `copypasta`: all bots in a volley post the same text (the first text of the volley).
  - `drift`: **all** variations for the topic (including messages with `held_out: false`) are ordered by cosine similarity to the first post, and the texts gradually drift in meaning. Therefore, messages without `held_out` are important too: they must be on-topic, just about something else.
- The detector (`detect/beam.py`) checks via embeddings that a post is "on-topic" (beam gain). A post that does not name the topic's subject may be dropped, and the attack will not trigger.
- `POST /api/inject` and `make eval` use the same file (§6).

## 3. File format

The schema is `synth/variations.py` (`VariationSet`, `Message`). Example (abbreviated—in a real file there are 30 variations each):

```json
{
 "topic": "microsoft-global-outage",
 "description": "Public discussion and media coverage of the Microsoft global cloud and Office 365 outage",
 "source": "gemini-3.8-flash",
 "messages": [
  {
   "claim": "The recent Microsoft Office 365 outage proves companies must stop relying entirely on a single cloud vendor.",
   "held_out": false,
   "variations": [
    "Putting every single workflow into Microsoft cloud was always a mistake. This massive downtime should be a wake-up call to diversify.",
    "Today's global Microsoft 365 disruption proves why tech monopolies are dangerous. Multi-cloud strategy is non-negotiable now."
   ]
  }
 ]
}
```

Requirements (as in the existing files and in `tests/test_synth_variations.py`):
- `topic` is strictly equal to the filename (slug, `[a-z0-9-]`).
- **5 messages with 30 variations each, the last 2 being `held_out: true`**, the first 3 being `false`.
- each message has at least 2 variations, unique ignoring case.
- no `@`, `http://`, `https://`, or `www.` (verified by the `test_committed_variation_sets_are_clean` test).
- 1–2 sentences, up to 240 characters, conversational social-media style, English language (the live stream is English).
- `source`: name of the generator model if the file was created using the command from §4, or `"handwritten"` if the texts were written manually or by an agent.

## 4. How to generate

**Primary path** — the standard generator (Gemini, requires `GEMINI_API_KEY` in `.env`—do not print the key):

```bash
set -a; . ./.env; set +a
.venv/bin/python -m synth.variations <slug> "<one sentence describing the topic>"
# Defaults: --messages 5 --variations 30 --held-out 2
```

The prompt and its rules are in the `PROMPT` constant in `synth/variations.py`. Take the topic description from the "News query (topic description)" column in §7 and expand it into a single sentence ("Public discussion of …"). One invocation makes one request to Gemini. After generation, **inspect the file by eye**: the model may return fewer than 30 variations (a warning will appear), duplicates, or off-topic texts.

**Fallback path** (no key or Gemini refused): write the JSON yourself following the same rules, `"source": "handwritten"`.

## 5. Content rules (mandatory)

This is a test astroturf campaign for a detector demo, not a real one. Therefore:
- theses are opinions, slogans, and calls to action ("share", "boycott", "sign", "don't believe the hype"), not facts.
- **no unverified factual accusations against real people or organizations**: crimes, private life, health, espionage, etc. Be especially careful with topics about specific people and legal cases (`russell-brand-trial`, `epstein-files`, `musk`, `sean-duffy-faa`, `schumer-leadership`, `uk-starmer`) and sensitive topics (`israel`, `gaza-ceasefire`, `abortion`, `vaccines`, `rfk-vaccines`, `measles-outbreak`, `deportations`). For medicine, no medical misinformation ("vaccines cause X"). A thesis can be political ("fund local clinics", "demand transparency").
- no hate speech, no calls to violence, no real `@handles`, no URLs.
- **every variation must name the topic's subject** (company, person, place, event) in its own words: this is mandatory. The keyword filter from §7 (`ingest.contextdev.on_topic(text, slug, whole=True)`) does not filter out synthetic texts and serves only as a guide. In existing files, 27 (europe), 149 (jensen), and 113 (microsoft) texts out of 150 do not pass it, yet attacks on them are detected in ~30 s.
- the 5 theses for a topic must differ noticeably in meaning. The 30 variations of a single thesis must share one meaning with different wording and different "people" (length, tone, word order).

## 6. Consequences and constraints

- **eval.** `make eval` injects attacks into all background topics that have a variations file (`eval/run.py`, `inject_topics`). The eval background contains `france-riots` and `ukraine-peace-talks` (`fixtures/items_live_background.json`): their files **change `eval/report.json`** (Pd, Pfa, and the operating point in the README and in the video). Commit 725fb1e added them and recomputed `eval/report.json` and `eval/operating_points.json`. Adding or regenerating either of these two files means re-running `make eval` and committing the report (P2 decides). The other topics do not affect eval. `make test` does not change: `tests/test_eval_report.py` pins two topics.
- **Embedding warmup.** When the worker starts, `warm_attack_texts()` (`ingest/worker.py`) computes embeddings once for all topic variations from `TOPICS`: 49 topics × 150 texts ≈ 7 350 texts sent to Gemini (afterward they reside in `cache/embeddings/`). This affects Gemini quota and startup time. If quota is insufficient, process topics in batches.
- **Tests.** `test_committed_variation_sets_are_clean` is parameterized over all files and will automatically verify new ones. `make test` runtime will increase only slightly.
- **Ownership.** `synth/` belongs to P2. Branch `p2/<task-id>-bot-hive-texts`. Per `CLAUDE.md`: card in `docs/tasks.md` → plan → human OK → work → `make test` → verification (`docs/workflow.md` §3). Subagents do not commit. Do not mention model names in commits and PRs (the `source` field in JSON is allowed).
- **Deployment.** Merging into `main` deploys automatically (GitHub Actions). Do not merge during video recording: each deploy causes ~10–30 s of 502 errors and resets the news schedule. Do not deploy manually.

## 7. Topics added in commit 725fb1e (46)

The "Topic filter" column is `TOPIC_SPECS` from `ingest/contextdev.py`: a post matches the topic if at least one word is found in each group (word start, case-insensitive, where `\b` is a word boundary).

| # | slug | News query (topic description) | Topic filter (at least one word per group) |
|---|---|---|---|
| 1 | `france-riots` | France riots | (`france` / `french` / `paris`) **AND** (`riot` / `protest` / `unrest` / `looting`) |
| 2 | `us-midterms-ai-fakes` | US midterms AI deepfakes | (`midterm` / `election` / `campaign` / `voter`) **AND** (`deepfake` / `ai-generated` / `fake` / `disinformation` / `misinformation`) |
| 3 | `ukraine-peace-talks` | Ukraine peace talks | (`ukrain`) **AND** (`peace` / `talks` / `negotiat` / `ceasefire`) |
| 4 | `faa-ground-stop` | FAA nationwide ground stop | (`faa` / `ground stop` / `air traffic`) **AND** (`ground stop` / `grounded` / `outage` / `equipment` / `l3harris` / `telecom` / `halt`) |
| 5 | `sean-duffy-faa` | Sean Duffy FAA contract | (`duffy`) **AND** (`faa` / `contract` / `son-in-law` / `transportation` / `aviation`) |
| 6 | `new-orleans-cruise-tanker` | New Orleans cruise ship tanker collision | (`cruise`) **AND** (`tanker` / `collision` / `collided` / `crash` / `new orleans`) |
| 7 | `midterm-vote-count` | midterm close races vote count | (`midterm` / `house race` / `senate race` / `ballots`) **AND** (`count(?:s\|ed\|ing)?\b` / `recount` / `results` / `called` / `lead(?:s\|ing)?\b` / `race` / `seat`) |
| 8 | `schumer-leadership` | Schumer leadership challenge | (`schumer` / `jeffries`) **AND** (`leader` / `replace` / `step down` / `leadership` / `ousted` / `resign`) |
| 9 | `ice-overhaul` | Congress ICE overhaul | (`ice\b` / `immigration and customs`) **AND** (`immigra` / `deport` / `agents` / `detention` / `abolish` / `overhaul` / `raid`) |
| 10 | `trump-cuba` | Trump Cuba military operation | (`cuba` / `havana`) **AND** (`trump` / `military` / `invasion` / `operation` / `regime` / `blockade`) |
| 11 | `measles-outbreak` | US measles outbreak elimination status | (`measles`) **AND** (`case` / `outbreak` / `elimination` / `vaccin` / `spread`) |
| 12 | `rfk-vaccines` | RFK Jr vaccines HHS | (`kennedy` / `rfk\b`) **AND** (`vaccin` / `autism` / `hhs\b` / `cdc\b` / `fda\b` / `acip`) |
| 13 | `epstein-files` | Epstein files | (`epstein`) |
| 14 | `tariffs` | Trump tariffs trade war | (`tariff`) **AND** (`trump` / `china` / `trade` / `court` / `canada` / `europe` / `price`) |
| 15 | `deportations` | deportations immigration raids | (`deport(?:ed\|ee\|ees\|ing\|ation\|ations\|s)?\b` / `ice raid` / `immigration raid`) |
| 16 | `trump-xi-putin-summit` | Trump Xi Putin summit APEC China | (`summit` / `apec` / `trilateral`) **AND** (`xi\b` / `putin`) |
| 17 | `us-iran-strikes` | US Iran strikes | (`iran`) **AND** (`strike` / `drone` / `radar` / `bahrain` / `missile` / `attack` / `war` / `bomb`) |
| 18 | `hormuz-tankers` | Strait of Hormuz tankers mines | (`hormuz` / `persian gulf` / `gulf of oman`) **AND** (`tanker` / `mine` / `oil` / `ship` / `attack` / `iran`) |
| 19 | `gaza-ceasefire` | Gaza ceasefire | (`gaza` / `hamas`) **AND** (`ceasefire` / `truce` / `hostage` / `deal` / `phase` / `aid` / `killed`) |
| 20 | `turkey-qatar-defense-pact` | Turkey Qatar defense pact | (`qatar` / `turk` / `türkiye`) **AND** (`defen` / `pact` / `agreement`) |
| 21 | `ukraine-territory-nato` | Ukraine cede territory NATO membership | (`ukrain` / `zelensk`) **AND** (`territor` / `nato` / `cede` / `donbas` / `land`) |
| 22 | `poland-russia-border` | Poland Russia border sabotage | (`poland` / `polish\b` / `kaliningrad`) **AND** (`sabotage` / `border` / `russia` / `drone` / `shoot` / `gunman`) |
| 23 | `sudan-war` | Sudan war RSF | (`sudan` / `rsf\b` / `darfur` / `el fasher`) **AND** (`army` / `attack` / `killed` / `famine` / `war` / `genocide`) |
| 24 | `south-sudan-elections` | South Sudan elections postponed | (`south sudan`) **AND** (`election` / `vote` / `postpone` / `violence`) |
| 25 | `pakistan-militants` | Pakistan militants border | (`pakistan`) **AND** (`militant` / `raid` / `border` / `taliban` / `killed` / `afghan` / `attack`) |
| 26 | `taiwan-china` | Taiwan China military pressure | (`taiwan`) **AND** (`china` / `chinese` / `pla\b` / `drill` / `invasion` / `strait`) |
| 27 | `north-korea` | North Korea | (`north korea` / `pyongyang` / `kim jong`) |
| 28 | `venezuela` | Venezuela Maduro | (`venezuela` / `maduro`) |
| 29 | `uk-starmer` | Starmer UK government | (`starmer`) |
| 30 | `chile-fuel-protests` | Chile fuel protests Kast | (`chile` / `kast`) **AND** (`fuel` / `protest` / `strike` / `price` / `president`) |
| 31 | `israel` | Israel | (`israel`) |
| 32 | `putin-russia` | Putin Russia | (`putin` / `kremlin`) |
| 33 | `nato` | NATO | (`nato\b`) |
| 34 | `cop31-climate` | COP31 climate summit | (`cop31` / `cop 31` / `climate summit` / `climate talks` / `climate conference`) |
| 35 | `climate-change` | climate change | (`climate` / `global warming`) |
| 36 | `vaccines` | vaccines | (`vaccin`) |
| 37 | `abortion` | abortion | (`abortion`) |
| 38 | `bird-flu` | H5N1 bird flu | (`bird flu` / `h5n1` / `avian flu` / `avian influenza`) |
| 39 | `wildfire` | wildfire | (`wildfire` / `bushfire` / `forest fire`) |
| 40 | `openai-chatgpt` | OpenAI ChatGPT | (`openai` / `chatgpt` / `altman`) |
| 41 | `musk` | Elon Musk | (`musk\b`) |
| 42 | `spacex-starship` | SpaceX Starship launch | (`starship` / `spacex`) |
| 43 | `ai-data-centers` | AI data centers | (`data center` / `data centre` / `datacenter`) |
| 44 | `cyberattacks` | cyberattack ransomware data breach | (`cyberattack` / `cyber attack` / `ransomware` / `data breach` / `hacked`) |
| 45 | `bitcoin-crypto` | Bitcoin crypto | (`bitcoin` / `btc\b` / `crypto\b` / `cryptocurrenc`) |
| 46 | `russell-brand-trial` | Russell Brand trial | (`russell brand`) |

## 8. Pre-commit check

```bash
.venv/bin/python - <<'PY'
from datetime import datetime, timezone
from ingest.contextdev import on_topic
from synth.variations import available_topics, load_variations
from synth.campaign import make_campaign
now = datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc)
for t in available_topics():
    vs = load_variations(t)                       # Validate the schema
    held = [m.held_out for m in vs.messages]
    texts = [v for m in vs.messages for v in m.variations]
    long_ = [v for v in texts if len(v) > 240]
    off = [v for v in texts if not on_topic(v, t, whole=True)]
    items = make_campaign(t, now, n_accounts=25, schedule="future")  # Offline
    print(f"{t}: msgs={len(vs.messages)} held={held} texts={len(texts)} >240={len(long_)} "
          f"off_topic={len(off)} campaign={len(items)}")
    for v in off[:3]:
        print("   off:", v)
PY
make test
```

Expected: `held=[False, False, False, True, True]`, `texts=150`, `>240=0`, `campaign=50`. `off_topic` is for reference (see §5). Review the `off:` lines and rewrite any texts that genuinely do not name the topic subject. The old `helsinki-tram-fares` (4 messages, without `held_out`) is an exception. Do not touch it.

**After deploy** (done by a human or P1): `curl -s https://liveswarmradar.tech/api/attack/topics` — new topics in the list. On `/redteam`, an attack on a new topic (25 bots, paraphrase) should produce `coordinated` in about 30–60 s. No more than 1 attack per 5 min per topic (otherwise 429).
