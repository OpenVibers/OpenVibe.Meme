-- phase: expand
-- OpenVibe.Meme: what each person used of the AI features today (analyze, research, generate), so one person cannot
-- spend the day's whole budget for everyone. One row per UTC day, person and feature; staff are not counted.
CREATE TABLE meme_person_usage (
    day         date NOT NULL,
    subject     text COLLATE "C" NOT NULL,
    kind        text NOT NULL,
    uses        integer NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, subject, kind),
    CONSTRAINT meme_person_usage_subject CHECK (subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_person_usage_kind CHECK (kind IN ('analyze', 'research', 'generate')),
    CONSTRAINT meme_person_usage_uses CHECK (uses >= 0)
);
