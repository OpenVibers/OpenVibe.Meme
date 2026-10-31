-- phase: expand
-- OpenVibe.Meme M4: analyse. Two AI calls per analysis (vision, then a structured extraction) are reserved
-- against a daily budget here; the finished analysis is kept so staff can audit what the model said and what it
-- cost. Nothing in this table is a credential or a person's private data: it holds the public input URL/Media id,
-- the model's answer and the run's stated cost.

CREATE TABLE meme_ai_usage (
    day       date NOT NULL,
    kind      text COLLATE "C" NOT NULL,                    -- analyze | research | generate
    calls     integer NOT NULL DEFAULT 0,
    cost_usd  numeric(14, 6) NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, kind),
    CONSTRAINT meme_ai_usage_kind CHECK (kind IN ('analyze', 'research', 'generate')),
    CONSTRAINT meme_ai_usage_calls CHECK (calls >= 0),
    CONSTRAINT meme_ai_usage_cost CHECK (cost_usd >= 0)
);

CREATE TABLE meme_analyses (
    id          text COLLATE "C" PRIMARY KEY,               -- anl_ + ULID
    subject     text COLLATE "C",                            -- usr_… when signed in, NULL for a public analysis
    input_url   text,
    media_id    text COLLATE "C",
    status      text COLLATE "C" NOT NULL DEFAULT 'succeeded', -- succeeded | failed
    result      jsonb,
    error_code  text COLLATE "C",
    cost_usd    numeric(14, 6) NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_analyses_id CHECK (id ~ '^anl_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_analyses_subject CHECK (subject IS NULL OR subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_analyses_media CHECK (media_id IS NULL OR media_id ~ '^med_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_analyses_status CHECK (status IN ('succeeded', 'failed')),
    CONSTRAINT meme_analyses_url CHECK (input_url IS NULL OR (input_url ~ '^https?://' AND length(input_url) <= 2048))
);
CREATE INDEX meme_analyses_by_subject ON meme_analyses (subject, created_at DESC);
