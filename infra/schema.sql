-- Live Truth Radar DB schema (P1, T4). Columns mirror contracts/models.py.
-- Applied by Postgres on first init (docker-entrypoint-initdb.d); idempotent, safe to re-run.
-- No pgvector: embeddings are cached on disk in cache/.

BEGIN;

-- Accounts / authors seen in items. Real handles live only in the DB, never in git.
CREATE TABLE IF NOT EXISTS actors (
    author        text PRIMARY KEY,
    platform      text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- contracts.Item. No FK to actors: inject / fixture loading must not depend on write order.
CREATE TABLE IF NOT EXISTS items (
    id           text PRIMARY KEY,
    source       text NOT NULL CHECK (source IN ('context_social', 'context_news', 'synthetic')),
    platform     text,
    author       text NOT NULL,
    published_at timestamptz NOT NULL,
    text         text NOT NULL,
    url          text,
    topic        text NOT NULL,
    synthetic    boolean NOT NULL DEFAULT false,
    campaign_id  text,
    ingested_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_topic_published_idx ON items (topic, published_at);
CREATE INDEX IF NOT EXISTS items_author_idx ON items (author);

-- contracts.Finding: scalars as columns, arrays / nested objects as jsonb.
-- Worker replaces all findings of a topic atomically (DELETE + INSERT in one transaction).
CREATE TABLE IF NOT EXISTS findings (
    id              text PRIMARY KEY,
    topic           text NOT NULL,
    created_at      timestamptz NOT NULL,
    verdict         text NOT NULL CHECK (verdict IN ('coordinated', 'organic', 'watching')),
    accounts        jsonb NOT NULL,
    item_ids        jsonb NOT NULL,
    llr             double precision NOT NULL,
    snr_db          double precision NOT NULL,
    snr_db_single   double precision,
    sprt_trace      jsonb NOT NULL,
    sprt_upper      double precision NOT NULL,
    sprt_lower      double precision NOT NULL,
    decided_at_item integer,
    first_seen      timestamptz NOT NULL,
    last_seen       timestamptz NOT NULL,
    correlation     jsonb NOT NULL,
    lag_sec         jsonb,
    explanation     jsonb,
    synthetic       boolean NOT NULL DEFAULT false,
    ambiguity       jsonb,
    note            text,
    CHECK (sprt_lower < sprt_upper),
    CHECK (first_seen <= last_seen)
);
CREATE INDEX IF NOT EXISTS findings_topic_idx ON findings (topic);

-- Manual labelling (T14); mirrors eval/labels.csv. account = contracts.pseudonym(...).
CREATE TABLE IF NOT EXISTS labels (
    account     text NOT NULL,
    topic       text NOT NULL,
    alerted     boolean NOT NULL,
    verdict     text CHECK (verdict IN ('coordinated', 'watching')),  -- NULL = no finding for the account
    label       text CHECK (label IN ('organic', 'suspicious', 'unclear')),
    note        text,
    labelled_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account, topic)
);

-- POST /api/inject writes a row; worker polls unprocessed rows (~10 s) and runs detect() for the topic.
CREATE TABLE IF NOT EXISTS inject_requests (
    id           bigserial PRIMARY KEY,
    topic        text NOT NULL,
    campaign_id  text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS inject_requests_pending_idx
    ON inject_requests (created_at) WHERE processed_at IS NULL;

-- Small key/value state, e.g. key 'last_poll_at' = last successful ingest cycle (AlertsResponse.last_poll_at).
CREATE TABLE IF NOT EXISTS worker_state (
    key   text PRIMARY KEY,
    value timestamptz NOT NULL
);

COMMIT;
