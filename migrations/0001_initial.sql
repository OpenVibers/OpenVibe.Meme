-- phase: expand
-- OpenVibe.Meme: the open meme database, rebuilt with AI. Every entry is built from OpenVibe's own running
-- jokes and cites the moment it happened (a chat line, a VOD second, a Rundown segment). A candidate is born
-- hidden and only a staff person publishes it. Nothing written here is a credential: a citation stores the
-- public URL and a hash of the verbatim quote, never private bytes or a person's token.

CREATE TABLE meme_entries (
    id            text COLLATE "C" PRIMARY KEY,              -- mem_ + 26 Crockford base32 characters (ULID)
    slug          text COLLATE "C" NOT NULL UNIQUE,          -- /m/<slug>
    title         text NOT NULL,
    kind          text COLLATE "C" NOT NULL,                 -- joke | catchphrase | bit | meme | saga
    summary       text,                                      -- AI-written, stored as written (describing people is fine)
    status        text COLLATE "C" NOT NULL DEFAULT 'rising',-- rising | peaked | classic | dead
    status_since  timestamptz NOT NULL DEFAULT now(),
    first_seen_at timestamptz NOT NULL,
    last_seen_at  timestamptz NOT NULL,
    visibility    text COLLATE "C" NOT NULL DEFAULT 'hidden',-- public | unlisted | hidden
    revision      bigint NOT NULL DEFAULT 1,                 -- +1 on every change; the Search revision
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_entries_id CHECK (id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_entries_slug CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 80),
    CONSTRAINT meme_entries_title CHECK (length(title) BETWEEN 1 AND 160),
    CONSTRAINT meme_entries_kind CHECK (kind IN ('joke', 'catchphrase', 'bit', 'meme', 'saga')),
    CONSTRAINT meme_entries_status CHECK (status IN ('rising', 'peaked', 'classic', 'dead')),
    CONSTRAINT meme_entries_visibility CHECK (visibility IN ('public', 'unlisted', 'hidden')),
    CONSTRAINT meme_entries_revision CHECK (revision > 0),
    CONSTRAINT meme_entries_seen CHECK (first_seen_at <= last_seen_at)
);
CREATE INDEX meme_entries_public ON meme_entries (visibility, status, last_seen_at DESC);
CREATE INDEX meme_entries_by_status ON meme_entries (status, last_seen_at DESC);
CREATE INDEX meme_entries_by_first_seen ON meme_entries (first_seen_at DESC, id DESC);

-- Where a use happened. role origin is the first moment (one per entry in practice), use is a later use, example
-- is an illustrative citation. quote_text is verbatim human speech, never rewritten; quote_hash is sha256 of it,
-- so a re-verification can tell whether the source still says the same thing. source_status: live | hidden | gone.
CREATE TABLE meme_citations (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id       text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    role           text COLLATE "C" NOT NULL,                -- origin | use | example
    source_service text COLLATE "C" NOT NULL,                -- live | chat | community
    source_type    text COLLATE "C" NOT NULL,                -- chat_message | vod | clip | rundown_segment | ai_paste | stream_memory
    source_id      text COLLATE "C" NOT NULL,                -- message id, VOD id, clip id, segment id, paste slug
    stream_id      bigint,
    vod_id         bigint,
    clip_id        bigint,
    chat_message_id bigint,
    offset_seconds numeric,                                  -- canonical VOD seconds (never stream seconds)
    quote_text     text NOT NULL,
    quote_hash     text COLLATE "C" NOT NULL,
    url            text NOT NULL,                            -- canonical public URL, e.g. https://openvibe.video/v/6025?t=1541
    observed_at    timestamptz NOT NULL,                     -- when the use happened
    source_status  text COLLATE "C" NOT NULL DEFAULT 'live',
    captured_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_citations_role CHECK (role IN ('origin', 'use', 'example')),
    CONSTRAINT meme_citations_source_service CHECK (source_service IN ('live', 'chat', 'community')),
    CONSTRAINT meme_citations_source_type CHECK (source_type IN ('chat_message', 'vod', 'clip', 'rundown_segment', 'ai_paste', 'stream_memory')),
    CONSTRAINT meme_citations_quote CHECK (length(quote_text) >= 1),
    CONSTRAINT meme_citations_hash CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT meme_citations_url CHECK (url ~ '^https?://'),
    CONSTRAINT meme_citations_offset CHECK (offset_seconds IS NULL OR offset_seconds >= 0),
    CONSTRAINT meme_citations_status CHECK (source_status IN ('live', 'hidden', 'gone'))
);
CREATE UNIQUE INDEX meme_citations_unique ON meme_citations
    (entry_id, source_service, source_type, source_id, COALESCE(offset_seconds, -1));
CREATE INDEX meme_citations_by_entry ON meme_citations (entry_id, role, observed_at);
CREATE INDEX meme_citations_for_reverify ON meme_citations (source_status, captured_at);

CREATE TABLE meme_status_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id    text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    from_status text COLLATE "C",
    to_status   text COLLATE "C" NOT NULL,
    reason      text,
    changed_by  text COLLATE "C",                            -- usr_… or service:meme
    changed_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_status_events_from CHECK (from_status IS NULL OR from_status IN ('rising', 'peaked', 'classic', 'dead')),
    CONSTRAINT meme_status_events_to CHECK (to_status IN ('rising', 'peaked', 'classic', 'dead'))
);
CREATE INDEX meme_status_events_by_entry ON meme_status_events (entry_id, changed_at DESC);

-- One vote a week: (week, subject) is the key, so a second vote in the same ISO week changes the choice, never
-- adds a second ballot. week is YYYY-Www (ISO-8601, UTC).
CREATE TABLE meme_votes (
    week       text COLLATE "C" NOT NULL,
    entry_id   text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    subject    text COLLATE "C" NOT NULL,                    -- usr_…
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (week, subject),
    CONSTRAINT meme_votes_week CHECK (week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'),
    CONSTRAINT meme_votes_subject CHECK (subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')
);
CREATE INDEX meme_votes_by_entry ON meme_votes (week, entry_id);

CREATE TABLE meme_templates (
    id         text COLLATE "C" PRIMARY KEY,
    name       text NOT NULL,
    image_url  text NOT NULL,                                -- openvibe.media object, or a local data-free placeholder
    box_count  integer NOT NULL,
    source     text NOT NULL,
    license    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_templates_box_count CHECK (box_count BETWEEN 1 AND 8),
    CONSTRAINT meme_templates_image CHECK (image_url ~ '^(https://openvibe\.media/|/img/)'),
    CONSTRAINT meme_templates_name CHECK (length(name) BETWEEN 1 AND 80)
);

CREATE TABLE meme_captions (
    id          text COLLATE "C" PRIMARY KEY,                -- mcp_ + ULID
    subject     text COLLATE "C" NOT NULL,                   -- usr_…
    template_id text COLLATE "C" NOT NULL REFERENCES meme_templates (id),
    lines       jsonb NOT NULL,                              -- array of 1–4 plain-text lines
    created_at  timestamptz NOT NULL DEFAULT now(),
    visibility  text COLLATE "C" NOT NULL DEFAULT 'public',  -- public | unlisted | hidden
    CONSTRAINT meme_captions_id CHECK (id ~ '^mcp_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_captions_subject CHECK (subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_captions_lines CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 4),
    CONSTRAINT meme_captions_visibility CHECK (visibility IN ('public', 'unlisted', 'hidden'))
);
CREATE INDEX meme_captions_by_subject ON meme_captions (subject, created_at DESC);
CREATE INDEX meme_captions_by_template ON meme_captions (template_id, created_at DESC);

CREATE TABLE meme_reports (
    id         text COLLATE "C" PRIMARY KEY,                 -- mrp_ + ULID
    entry_id   text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    subject    text COLLATE "C" NOT NULL,
    kind       text COLLATE "C" NOT NULL,                    -- takedown | correction
    reason     text NOT NULL,
    note       text,
    status     text COLLATE "C" NOT NULL DEFAULT 'open',     -- open | handled | dismissed
    created_at timestamptz NOT NULL DEFAULT now(),
    handled_at timestamptz,
    handled_by text COLLATE "C",
    CONSTRAINT meme_reports_id CHECK (id ~ '^mrp_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_reports_subject CHECK (subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_reports_kind CHECK (kind IN ('takedown', 'correction')),
    CONSTRAINT meme_reports_reason CHECK (length(reason) BETWEEN 3 AND 2000),
    CONSTRAINT meme_reports_note CHECK (note IS NULL OR length(note) <= 4000),
    CONSTRAINT meme_reports_status CHECK (status IN ('open', 'handled', 'dismissed'))
);
CREATE INDEX meme_reports_by_entry ON meme_reports (entry_id, created_at DESC);
CREATE INDEX meme_reports_open ON meme_reports (status, created_at);

-- The Search Fabric outbox (Today's shape). A document for a public entry is written with this fixed evt_ id in
-- the same transaction as the entry change; a hidden entry writes a tombstone. No service grant is needed to
-- queue it, and the rows wait until OpenVibe.Search's document writer is configured.
CREATE TABLE meme_outbox (
    event_id       text COLLATE "C" PRIMARY KEY,
    topic          text COLLATE "C" NOT NULL,
    payload        jsonb NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    published_at   timestamptz,
    attempts       integer NOT NULL DEFAULT 0,
    last_error     text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claimed_at     timestamptz,
    claimed_by     text
);
CREATE INDEX meme_outbox_pending ON meme_outbox (next_attempt_at) WHERE published_at IS NULL;

-- openvibe-sdk/account-data keeps its own idempotency here (ADR-033): a redelivered export or deletion changes
-- nothing. It holds an export_id or deletion_id, the subject and the counts sent to Network; it is not a secret.
CREATE TABLE account_data_events (
    id         text PRIMARY KEY,
    kind       text NOT NULL,
    subject    text NOT NULL,
    outcome    jsonb,
    applied_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz
);

-- Request telemetry (openvibe-sdk/telemetry): one row per aggregated sample, pruned after 14 days.
CREATE TABLE telemetry_samples (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                    timestamptz NOT NULL,
    service               text NOT NULL,
    project               text,
    subject               text,
    resource              text,
    provider              text,
    node                  text,
    cell                  text,
    region                text,
    operation             text NOT NULL,
    latency_ms            double precision,
    queue_delay_ms        double precision,
    ttfb_ms               double precision,
    throughput_per_second double precision,
    bytes                 bigint,
    status                text,
    cache_status          text,
    cost_estimate         double precision,
    route_epoch           bigint,
    trace_id              text,
    extra                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX telemetry_samples_at_idx ON telemetry_samples (at);
CREATE INDEX telemetry_samples_service_idx ON telemetry_samples (service, operation, at);

-- v1 ships three data-free placeholders; a real template is an openvibe.media object added by staff. The
-- generator preview is HTML text over the image, and no caption is ever stored as an image.
INSERT INTO meme_templates (id, name, image_url, box_count, source, license) VALUES
    ('tpl_classic', 'Classic two-line', '/img/template-classic.svg', 2, 'OpenVibe', 'CC0-1.0'),
    ('tpl_reaction', 'Reaction', '/img/template-reaction.svg', 1, 'OpenVibe', 'CC0-1.0'),
    ('tpl_triptych', 'Three panels', '/img/template-triptych.svg', 3, 'OpenVibe', 'CC0-1.0')
ON CONFLICT (id) DO NOTHING;
