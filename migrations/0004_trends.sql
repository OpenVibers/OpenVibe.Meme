-- phase: expand
-- OpenVibe.Meme M3: trends from Reddit's official API. One row per post we saw, one sample per observation so the
-- API can compute an upvote velocity instead of trusting a single score, and the dHash clusters that show a new
-- template repeating. Nothing here is copied from a scrape: the importer reads oauth.reddit.com under Reddit's
-- terms with this app's own credentials, and the pictures stay on Reddit or in OpenVibe.Media (media_id).

CREATE TABLE meme_reddit_posts (
    id            text COLLATE "C" PRIMARY KEY,             -- Reddit fullname, e.g. t3_1a2b3c
    subreddit     text COLLATE "C" NOT NULL,
    title         text NOT NULL,
    permalink     text NOT NULL,
    url           text,
    image_url     text,
    author        text,
    media_id      text COLLATE "C",                          -- med_… when the picture was uploaded to OpenVibe.Media
    phash         text COLLATE "C",                          -- 64-bit dHash, 16 hex characters
    score         integer NOT NULL DEFAULT 0,
    comments      integer NOT NULL DEFAULT 0,
    over_18       boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL,                      -- Reddit's created_utc
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    removed       boolean NOT NULL DEFAULT false,
    CONSTRAINT meme_reddit_posts_id CHECK (id ~ '^t3_[a-z0-9]{1,16}$'),
    CONSTRAINT meme_reddit_posts_subreddit CHECK (length(subreddit) BETWEEN 1 AND 80),
    CONSTRAINT meme_reddit_posts_title CHECK (length(title) BETWEEN 1 AND 500),
    CONSTRAINT meme_reddit_posts_phash CHECK (phash IS NULL OR phash ~ '^[0-9a-f]{16}$'),
    CONSTRAINT meme_reddit_posts_media CHECK (media_id IS NULL OR media_id ~ '^med_[0-9A-HJKMNP-TV-Z]{26}$')
);
CREATE INDEX meme_reddit_posts_by_sub ON meme_reddit_posts (subreddit, created_at DESC);
CREATE INDEX meme_reddit_posts_by_seen ON meme_reddit_posts (last_seen_at DESC);
CREATE INDEX meme_reddit_posts_phash ON meme_reddit_posts (phash) WHERE phash IS NOT NULL;

-- One observation of a post's score. The API's velocity is (last − first) / hours between the samples in the
-- requested window; with one sample it falls back to score / hours since the post was created, and says which.
CREATE TABLE meme_reddit_samples (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    post_id     text COLLATE "C" NOT NULL REFERENCES meme_reddit_posts (id) ON DELETE CASCADE,
    observed_at timestamptz NOT NULL DEFAULT now(),
    score       integer NOT NULL,
    comments    integer NOT NULL,
    CONSTRAINT meme_reddit_samples_score CHECK (score >= 0),
    CONSTRAINT meme_reddit_samples_comments CHECK (comments >= 0)
);
CREATE INDEX meme_reddit_samples_by_post ON meme_reddit_samples (post_id, observed_at);

-- A repeated perceptual hash is a template: the same joke picture appearing in several posts. The cluster keeps a
-- representative picture and its Media id when one was uploaded; staff can later promote it into meme_templates.
CREATE TABLE meme_reddit_templates (
    id            text COLLATE "C" PRIMARY KEY,             -- tpl_… (service id)
    phash         text COLLATE "C" NOT NULL,
    label         text,
    image_url     text,
    media_id      text COLLATE "C",
    post_count    integer NOT NULL DEFAULT 0,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_reddit_templates_id CHECK (id ~ '^tpl_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT meme_reddit_templates_phash CHECK (phash ~ '^[0-9a-f]{16}$'),
    CONSTRAINT meme_reddit_templates_count CHECK (post_count >= 0),
    CONSTRAINT meme_reddit_templates_media CHECK (media_id IS NULL OR media_id ~ '^med_[0-9A-HJKMNP-TV-Z]{26}$')
);
CREATE INDEX meme_reddit_templates_by_seen ON meme_reddit_templates (last_seen_at DESC);

CREATE TABLE meme_reddit_template_posts (
    template_id text COLLATE "C" NOT NULL REFERENCES meme_reddit_templates (id) ON DELETE CASCADE,
    post_id     text COLLATE "C" NOT NULL REFERENCES meme_reddit_posts (id) ON DELETE CASCADE,
    distance    integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (template_id, post_id),
    CONSTRAINT meme_reddit_template_posts_distance CHECK (distance BETWEEN 0 AND 64)
);
