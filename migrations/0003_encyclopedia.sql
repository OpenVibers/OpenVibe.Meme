-- phase: expand
-- OpenVibe.Meme M2: the encyclopedia. An entry now has a scope (`openvibe` for OpenVibe's own running jokes,
-- `internet` for the encyclopedia), a meaning/usage written by people, labels from the L1 set, an origin with a
-- citation, spread points, variations, Media examples, related entries and a moderated revision history.
--
-- Everything here is additive. Existing OpenVibe entries keep scope `openvibe` and get one approved revision at
-- their current revision number, so every entry has a history from the day this migration runs. Labels are the
-- consent plan's set (nudity, language, graphic, 18+, flashing, spoilers): they describe content, they never ban it.

ALTER TABLE meme_entries
    ADD COLUMN scope        text COLLATE "C" NOT NULL DEFAULT 'openvibe',
    ADD COLUMN meaning      text,
    ADD COLUMN usage        text,
    ADD COLUMN labels       text[] NOT NULL DEFAULT '{}'::text[],
    ADD COLUMN submitted_by text COLLATE "C";

-- The seeded classics (main's encyclopedia) are the internet's, not OpenVibe's own running jokes: they keep
-- the scope the two scopes are for.
UPDATE meme_entries SET scope = 'internet' WHERE kind = 'classic';
ALTER TABLE meme_entries DROP CONSTRAINT meme_entries_kind;
ALTER TABLE meme_entries ADD CONSTRAINT meme_entries_kind
    CHECK (kind IN ('joke', 'catchphrase', 'bit', 'meme', 'saga', 'classic', 'format', 'event', 'person', 'phrase', 'deep_dive'));
ALTER TABLE meme_entries ADD CONSTRAINT meme_entries_scope CHECK (scope IN ('openvibe', 'internet'));
ALTER TABLE meme_entries ADD CONSTRAINT meme_entries_labels CHECK (
    labels <@ ARRAY['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers']::text[]
    AND coalesce(array_position(labels, NULL), 0) = 0
    AND cardinality(labels) <= 6
);
ALTER TABLE meme_entries ADD CONSTRAINT meme_entries_submitted_by CHECK (
    submitted_by IS NULL OR submitted_by ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'
);
CREATE INDEX meme_entries_scope_public ON meme_entries (scope, visibility, status, last_seen_at DESC);
CREATE INDEX meme_entries_labels ON meme_entries USING GIN (labels);

-- Where an internet meme came from: a public page, with the title and publisher as they were when it was read.
-- OpenVibe entries keep using meme_citations('origin'); this row is for the outside world. The source field says
-- which official API/site it came from (web, reddit, media, openvibe).
CREATE TABLE meme_origins (
    entry_id     text COLLATE "C" PRIMARY KEY REFERENCES meme_entries (id) ON DELETE CASCADE,
    source       text COLLATE "C" NOT NULL DEFAULT 'web',
    url          text NOT NULL,
    title        text NOT NULL,
    publisher    text,
    author       text,
    published_at timestamptz,
    retrieved_at timestamptz NOT NULL DEFAULT now(),
    quote        text,
    CONSTRAINT meme_origins_source CHECK (source IN ('web', 'reddit', 'media', 'openvibe')),
    CONSTRAINT meme_origins_url CHECK (url ~ '^https?://' AND length(url) <= 2048),
    CONSTRAINT meme_origins_title CHECK (length(title) BETWEEN 1 AND 300),
    CONSTRAINT meme_origins_quote CHECK (quote IS NULL OR length(quote) <= 2000)
);

-- How far a meme spread: one point per date and place (a subreddit, a site, a country), with the count the source
-- stated. A point without a count is still a sighting, never an invented number.
CREATE TABLE meme_spread_points (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id    text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    observed_at timestamptz NOT NULL,
    place       text NOT NULL,
    url         text,
    count       integer,
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_spread_place CHECK (length(place) BETWEEN 1 AND 80),
    CONSTRAINT meme_spread_count CHECK (count IS NULL OR count >= 0),
    CONSTRAINT meme_spread_url CHECK (url IS NULL OR (url ~ '^https?://' AND length(url) <= 2048)),
    CONSTRAINT meme_spread_note CHECK (note IS NULL OR length(note) <= 500),
    CONSTRAINT meme_spread_unique UNIQUE (entry_id, observed_at, place, url)
);
CREATE INDEX meme_spread_by_entry ON meme_spread_points (entry_id, observed_at);

-- A named variation of the format (e.g. "the surprised Pikachu face, but with a cat"), optionally with one Media
-- picture. The picture stays a Media object id; Meme never copies the bytes.
CREATE TABLE meme_variations (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id    text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    name        text NOT NULL,
    description text,
    media_id    text COLLATE "C",
    source_url  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_variations_name CHECK (length(name) BETWEEN 1 AND 120),
    CONSTRAINT meme_variations_media CHECK (media_id IS NULL OR media_id ~ '^med_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_variations_url CHECK (source_url IS NULL OR (source_url ~ '^https?://' AND length(source_url) <= 2048))
);
CREATE INDEX meme_variations_by_entry ON meme_variations (entry_id, id);

-- Examples are Media object ids (med_…) with an optional caption and the page they came from. Reposted pictures
-- keep their source link.
CREATE TABLE meme_examples (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entry_id   text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    media_id   text COLLATE "C" NOT NULL,
    caption    text,
    source_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_examples_media CHECK (media_id ~ '^med_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_examples_caption CHECK (caption IS NULL OR length(caption) <= 300),
    CONSTRAINT meme_examples_url CHECK (source_url IS NULL OR (source_url ~ '^https?://' AND length(source_url) <= 2048))
);
CREATE INDEX meme_examples_by_entry ON meme_examples (entry_id, id);

-- Related memes are a plain directed pair; the API returns both directions together.
CREATE TABLE meme_entry_related (
    entry_id   text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    related_id text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entry_id, related_id),
    CONSTRAINT meme_entry_related_self CHECK (entry_id <> related_id)
);

-- Wiki-style history. A proposal is a revision whose moderation_state is `pending`; applying it copies `change`
-- onto the entry and bumps the entry's revision to this row's revision. The diff is the field-by-field before/after
-- the reviewer sees, computed by the API, never by the client.
CREATE TABLE meme_entry_revisions (
    entry_id         text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    revision         bigint NOT NULL,
    author           text COLLATE "C" NOT NULL,
    base_revision    bigint,
    change           jsonb NOT NULL,
    diff             jsonb NOT NULL,
    moderation_state text COLLATE "C" NOT NULL DEFAULT 'pending',
    note             text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    reviewed_at      timestamptz,
    reviewed_by      text COLLATE "C",
    PRIMARY KEY (entry_id, revision),
    CONSTRAINT meme_entry_revisions_revision CHECK (revision > 0),
    CONSTRAINT meme_entry_revisions_state CHECK (moderation_state IN ('pending', 'approved', 'rejected')),
    CONSTRAINT meme_entry_revisions_note CHECK (note IS NULL OR length(note) <= 1000)
);
CREATE INDEX meme_entry_revisions_pending ON meme_entry_revisions (created_at) WHERE moderation_state = 'pending';

-- Every existing entry keeps its history from here: one approved revision, authored by the service, whose change
-- is the entry as it stood when this migration ran.
INSERT INTO meme_entry_revisions (entry_id, revision, author, base_revision, change, diff, moderation_state, created_at, reviewed_at, reviewed_by)
SELECT id, revision, 'service:meme', NULL,
       jsonb_build_object('title', title, 'kind', kind, 'summary', summary, 'status', status,
                          'scope', scope, 'meaning', meaning, 'usage', usage, 'labels', to_jsonb(labels)),
       '[]'::jsonb, 'approved', updated_at, updated_at, 'service:meme'
FROM meme_entries
ON CONFLICT DO NOTHING;
