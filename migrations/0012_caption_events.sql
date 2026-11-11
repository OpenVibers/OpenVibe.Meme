-- phase: expand
-- Public caption activity reaches Quest through Events after the caption commits.
CREATE TABLE IF NOT EXISTS event_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id text NOT NULL UNIQUE,
    envelope jsonb NOT NULL,
    traceparent text,
    created_at bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at bigint,
    seq bigint,
    rejected_at bigint,
    last_error text
);
CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_sent ON event_outbox (sent_at) WHERE sent_at IS NOT NULL;
