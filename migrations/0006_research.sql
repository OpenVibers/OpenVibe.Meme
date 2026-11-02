-- phase: expand
-- OpenVibe.Meme M5: deep dives. A research job gathers sources with OpenVibe.AI's research.gather, then writes one
-- long read in which every paragraph cites a numbered source. The finished read can be saved as a public entry;
-- meme_deep_dives keeps the full text and its numbered sources next to that entry. Usage is counted per UTC day.

CREATE TABLE meme_research (
    id            text COLLATE "C" PRIMARY KEY,              -- rsc_ + ULID
    subject       text COLLATE "C",                          -- usr_… who started it (NULL only for staff jobs)
    topic         text NOT NULL,
    status        text COLLATE "C" NOT NULL DEFAULT 'queued',-- queued | running | succeeded | failed
    title         text,
    summary       text,
    body_markdown text,
    sources       jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{n,title,url,provider,retrieved_at,license,snippet}]
    facts         jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{label,value}] from research.gather
    citations     jsonb NOT NULL DEFAULT '[]'::jsonb,        -- the numbered sources the read actually cites
    cost_usd      numeric(14, 6) NOT NULL DEFAULT 0,
    error_code    text COLLATE "C",
    error_detail  text,
    entry_slug    text COLLATE "C",                          -- set when saved as a deep-dive entry
    created_at    timestamptz NOT NULL DEFAULT now(),
    started_at    timestamptz,
    finished_at   timestamptz,
    CONSTRAINT meme_research_id CHECK (id ~ '^rsc_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_research_subject CHECK (subject IS NULL OR subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_research_topic CHECK (length(topic) BETWEEN 2 AND 300),
    CONSTRAINT meme_research_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    CONSTRAINT meme_research_cost CHECK (cost_usd >= 0)
);
CREATE INDEX meme_research_by_subject ON meme_research (subject, created_at DESC);
CREATE INDEX meme_research_by_status ON meme_research (status, created_at);

-- The full read, kept next to the entry it was saved as. The entry itself is the public record; this is its body
-- and the sources numbered exactly as the Markdown cites them.
CREATE TABLE meme_deep_dives (
    entry_id      text COLLATE "C" PRIMARY KEY REFERENCES meme_entries (id) ON DELETE CASCADE,
    research_id   text COLLATE "C" NOT NULL UNIQUE REFERENCES meme_research (id) ON DELETE CASCADE,
    body_markdown text NOT NULL,
    sources       jsonb NOT NULL,
    citations     jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_deep_dives_body CHECK (length(body_markdown) BETWEEN 1 AND 200000)
);
CREATE INDEX meme_deep_dives_by_research ON meme_deep_dives (research_id);

-- The research budget: two runs per job (gather + write), reserved before the first, cost added when it finishes.
CREATE TABLE meme_research_usage (
    day        date PRIMARY KEY,
    calls      integer NOT NULL DEFAULT 0,
    cost_usd   numeric(14, 6) NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_research_usage_calls CHECK (calls >= 0),
    CONSTRAINT meme_research_usage_cost CHECK (cost_usd >= 0)
);
