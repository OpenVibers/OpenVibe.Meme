-- phase: expand
-- The judge and the encyclopedia. A candidate is judged by OpenVibe.AI from its own citations: a score, a reason and
-- the written entry (title, summary, where it started, how people use it, two or three examples). The judgement is
-- kept beside the entry, never inside it, so the entry stays the same shape it was.
--
-- The encyclopedia adds entries of kind 'classic': the well-known internet memes, cited to Wikipedia (CC BY-SA) and
-- to Wikidata (CC0) with a Commons image only when its licence allows it. A citation from the open web is a new
-- source_service ('web') and a new source_type ('wikipedia' | 'wikidata' | 'commons'); the OpenVibe sources keep
-- their own. Every decision the judge takes is a status event with its score, so the history says why.
--
-- Nothing here is a secret: a citation stores a public URL and the sha256 of the quoted text.

-- 'classic' joins the kinds: an encyclopedia entry is not an OpenVibe running joke.
ALTER TABLE meme_entries DROP CONSTRAINT meme_entries_kind;
ALTER TABLE meme_entries ADD CONSTRAINT meme_entries_kind CHECK (kind IN ('joke', 'catchphrase', 'bit', 'meme', 'saga', 'classic'));

-- The open web is a source now: Wikipedia, Wikidata and Wikimedia Commons.
ALTER TABLE meme_citations DROP CONSTRAINT meme_citations_source_service;
ALTER TABLE meme_citations ADD CONSTRAINT meme_citations_source_service CHECK (source_service IN ('live', 'chat', 'community', 'web'));
ALTER TABLE meme_citations DROP CONSTRAINT meme_citations_source_type;
ALTER TABLE meme_citations ADD CONSTRAINT meme_citations_source_type CHECK (source_type IN ('chat_message', 'vod', 'clip', 'rundown_segment', 'ai_paste', 'stream_memory', 'wikipedia', 'wikidata', 'commons'));

-- An encyclopedia entry keeps its picture and where it came from. The licence is the Commons file's own.
ALTER TABLE meme_entries ADD COLUMN image_url text;
ALTER TABLE meme_entries ADD COLUMN image_credit text;
ALTER TABLE meme_entries ADD COLUMN image_license text;
ALTER TABLE meme_entries ADD COLUMN image_license_url text;
ALTER TABLE meme_entries ADD COLUMN image_source_url text;
ALTER TABLE meme_entries ADD COLUMN attribution text;                           -- the licences the entry's text is under
ALTER TABLE meme_entries ADD COLUMN external_id text;                            -- the Wikidata Q id, when there is one
CREATE UNIQUE INDEX meme_entries_external_id ON meme_entries (external_id) WHERE external_id IS NOT NULL;

-- One judgement per entry: what the AI decided, why, and what it wrote.
CREATE TABLE meme_judgements (
    entry_id    text COLLATE "C" PRIMARY KEY REFERENCES meme_entries (id) ON DELETE CASCADE,
    score       numeric(4,3) NOT NULL,                                            -- 0 to 1
    reason      text NOT NULL,                                                   -- why the AI gave that score
    title       text,                                                            -- the AI's title, in natural case
    summary     text,                                                            -- the AI's short summary
    origin      text,                                                            -- where it started
    spread      text,                                                            -- how people use it, and how it spread
    examples    jsonb NOT NULL DEFAULT '[]'::jsonb,                              -- two or three example uses
    denied      boolean NOT NULL DEFAULT false,                                 -- a denied source or a denied word
    looks       boolean NOT NULL DEFAULT false,                                 -- the text named looks
    model       text,
    provider    text,
    run_id      text,
    judged_at   timestamptz NOT NULL DEFAULT now(),
    judged_by   text COLLATE "C" NOT NULL DEFAULT 'service:meme:judge',
    CONSTRAINT meme_judgements_score CHECK (score >= 0 AND score <= 1),
    CONSTRAINT meme_judgements_examples CHECK (jsonb_typeof(examples) = 'array')
);
CREATE INDEX meme_judgements_by_score ON meme_judgements (score DESC);

-- A decision is a status event: the visibility moved, the score says why.
ALTER TABLE meme_status_events ADD COLUMN decision text;                         -- publish | keep_hidden | judge
ALTER TABLE meme_status_events ADD COLUMN from_visibility text;
ALTER TABLE meme_status_events ADD COLUMN to_visibility text;
ALTER TABLE meme_status_events ADD COLUMN score numeric(4,3);
ALTER TABLE meme_status_events ADD CONSTRAINT meme_status_events_decision CHECK (decision IS NULL OR decision IN ('publish', 'keep_hidden', 'judge', 'hide', 'seed'));

-- A template says where its picture came from and under which licence.
ALTER TABLE meme_templates ADD COLUMN credit text;
ALTER TABLE meme_templates ADD COLUMN source_url text;
ALTER TABLE meme_templates ADD COLUMN attribution text;
-- The picture may be an openvibe.media object, a file of this site, or a Wikimedia Commons file under a free licence.
ALTER TABLE meme_templates DROP CONSTRAINT meme_templates_image;
ALTER TABLE meme_templates ADD CONSTRAINT meme_templates_image CHECK (image_url ~ '^(https://openvibe\.media/|/img/|https://upload\.wikimedia\.org/)');
