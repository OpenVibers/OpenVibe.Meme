-- phase: expand
-- One title, one public entry. The importer recognises a joke by a short phrase and the judge later rewrites the
-- title in natural case; two overlapping phrases from the same recurring line therefore became two entries with
-- different slugs and then the same title (Trending showed the joke twice, and its votes and citations were split).
--
-- title_key is the title lowercased, with quotes and punctuation stripped and whitespace collapsed. The trigger
-- keeps it right for every writer, old or new. A unique partial index makes it impossible for two public entries
-- of the same kind to share a title. Before that index is made, the duplicates that already exist are merged into
-- the oldest entry (its id and slug stay), their citations, votes, reports, judgements, history and related rows
-- are moved, and the old slug and id become 301 redirects. Nothing here is a secret.

-- The one normalisation the trigger, the backfill and the app's titleKey() share. Quotes are removed (so "don't"
-- and "dont" are one key); every other punctuation run becomes a space (so a dash or ellipsis reads like a space);
-- case and whitespace do not matter.
CREATE FUNCTION meme_title_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT btrim(regexp_replace(
        regexp_replace(
            translate(lower(value), chr(8217) || chr(8216) || chr(96) || chr(180) || chr(39), ''),
            '[^[:alnum:]]+', ' ', 'g'),
        '\s+', ' ', 'g'))
$$;

ALTER TABLE meme_entries ADD COLUMN title_key text;
UPDATE meme_entries SET title_key = meme_title_key(title);
ALTER TABLE meme_entries ALTER COLUMN title_key SET NOT NULL;

CREATE FUNCTION meme_entries_set_title_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.title_key := meme_title_key(NEW.title);
    RETURN NEW;
END
$$;
CREATE TRIGGER meme_entries_title_key
    BEFORE INSERT OR UPDATE OF title ON meme_entries
    FOR EACH ROW EXECUTE FUNCTION meme_entries_set_title_key();

CREATE INDEX meme_entries_by_title_key ON meme_entries (title_key, kind);

-- An old slug, or an old entry id, answers 301 to the entry it was merged into. The redirect stays when the
-- duplicate entry row is deleted; the target keeps its own row.
CREATE TABLE meme_entry_redirects (
    from_slug     text COLLATE "C" PRIMARY KEY,
    from_entry_id text COLLATE "C" NOT NULL UNIQUE,
    to_entry_id   text COLLATE "C" NOT NULL REFERENCES meme_entries (id) ON DELETE CASCADE,
    reason        text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_entry_redirects_slug CHECK (from_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(from_slug) <= 80),
    CONSTRAINT meme_entry_redirects_id CHECK (from_entry_id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$')
);
CREATE INDEX meme_entry_redirects_to ON meme_entry_redirects (to_entry_id);

-- The decision column learns 'merge' so the merged entry's history says what happened.
ALTER TABLE meme_status_events DROP CONSTRAINT meme_status_events_decision;
ALTER TABLE meme_status_events ADD CONSTRAINT meme_status_events_decision
    CHECK (decision IS NULL OR decision IN ('publish', 'keep_hidden', 'judge', 'hide', 'seed', 'merge'));

-- Merge every public duplicate group into its oldest entry. The function is kept: it is the same answer if a
-- duplicate ever reaches the table through a path that bypassed the index (a restore, or a manual insert).
CREATE FUNCTION meme_merge_public_duplicates() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    dup record;
    keeper_revision bigint;
    merged_ids text[] := '{}';
    moved integer := 0;
BEGIN
    FOR dup IN
        SELECT d.id, d.slug, d.kind, d.revision, d.first_seen_at, d.last_seen_at,
               k.id AS keeper_id, k.slug AS keeper_slug, k.status AS keeper_status
        FROM (
            SELECT e.*,
                   row_number() OVER (PARTITION BY e.kind, e.title_key ORDER BY e.created_at ASC, e.id ASC) AS rn,
                   first_value(e.id) OVER (PARTITION BY e.kind, e.title_key ORDER BY e.created_at ASC, e.id ASC) AS keeper_id
            FROM meme_entries e
            WHERE e.visibility = 'public'
        ) d
        JOIN meme_entries k ON k.id = d.keeper_id
        WHERE d.rn > 1
        ORDER BY d.kind, d.title_key, d.created_at, d.id
    LOOP
        -- Citations: the keeper's own copy of a moment wins; a second origin becomes a use.
        DELETE FROM meme_citations c
        WHERE c.entry_id = dup.id
          AND EXISTS (
              SELECT 1 FROM meme_citations k
              WHERE k.entry_id = dup.keeper_id
                AND k.source_service = c.source_service AND k.source_type = c.source_type
                AND k.source_id = c.source_id
                AND COALESCE(k.offset_seconds, -1) = COALESCE(c.offset_seconds, -1)
          );
        IF EXISTS (SELECT 1 FROM meme_citations WHERE entry_id = dup.keeper_id AND role = 'origin') THEN
            UPDATE meme_citations SET role = 'use' WHERE entry_id = dup.id AND role = 'origin';
        END IF;
        UPDATE meme_citations SET entry_id = dup.keeper_id WHERE entry_id = dup.id;

        -- The week's votes are a (week, subject) key: move the ones the keeper has no ballot for.
        DELETE FROM meme_votes v
        WHERE v.entry_id = dup.id
          AND EXISTS (SELECT 1 FROM meme_votes k WHERE k.entry_id = dup.keeper_id AND k.week = v.week AND k.subject = v.subject);
        UPDATE meme_votes SET entry_id = dup.keeper_id WHERE entry_id = dup.id;

        UPDATE meme_status_events SET entry_id = dup.keeper_id WHERE entry_id = dup.id;
        UPDATE meme_reports SET entry_id = dup.keeper_id WHERE entry_id = dup.id;

        -- One judgement, origin and deep dive per entry: the keeper's own row wins.
        IF EXISTS (SELECT 1 FROM meme_judgements WHERE entry_id = dup.keeper_id) THEN
            DELETE FROM meme_judgements WHERE entry_id = dup.id;
        ELSE
            UPDATE meme_judgements SET entry_id = dup.keeper_id WHERE entry_id = dup.id;
        END IF;
        IF EXISTS (SELECT 1 FROM meme_origins WHERE entry_id = dup.keeper_id) THEN
            DELETE FROM meme_origins WHERE entry_id = dup.id;
        ELSE
            UPDATE meme_origins SET entry_id = dup.keeper_id WHERE entry_id = dup.id;
        END IF;
        IF EXISTS (SELECT 1 FROM meme_deep_dives WHERE entry_id = dup.keeper_id) THEN
            DELETE FROM meme_deep_dives WHERE entry_id = dup.id;
        ELSE
            UPDATE meme_deep_dives SET entry_id = dup.keeper_id WHERE entry_id = dup.id;
        END IF;

        DELETE FROM meme_spread_points s
        WHERE s.entry_id = dup.id
          AND EXISTS (
              SELECT 1 FROM meme_spread_points k
              WHERE k.entry_id = dup.keeper_id AND k.observed_at = s.observed_at
                AND k.place = s.place AND k.url IS NOT DISTINCT FROM s.url
          );
        UPDATE meme_spread_points SET entry_id = dup.keeper_id WHERE entry_id = dup.id;

        UPDATE meme_variations SET entry_id = dup.keeper_id WHERE entry_id = dup.id;
        UPDATE meme_examples SET entry_id = dup.keeper_id WHERE entry_id = dup.id;

        -- Related memes: a relation from one duplicate to the other becomes a self-reference, so it goes; a
        -- relation the keeper already has wins; the rest are rewritten to the keeper.
        DELETE FROM meme_entry_related
        WHERE (entry_id = dup.id AND related_id = dup.keeper_id)
           OR (entry_id = dup.keeper_id AND related_id = dup.id);
        DELETE FROM meme_entry_related r
        WHERE (r.entry_id = dup.id
               AND EXISTS (SELECT 1 FROM meme_entry_related k WHERE k.entry_id = dup.keeper_id AND k.related_id = r.related_id))
           OR (r.related_id = dup.id
               AND EXISTS (SELECT 1 FROM meme_entry_related k WHERE k.entry_id = r.entry_id AND k.related_id = dup.keeper_id));
        UPDATE meme_entry_related SET entry_id = dup.keeper_id WHERE entry_id = dup.id;
        UPDATE meme_entry_related SET related_id = dup.keeper_id WHERE related_id = dup.id;
        DELETE FROM meme_entry_related WHERE entry_id = related_id;

        -- Wiki history: keep the keeper's revision numbers; the duplicate's colliding ones go, the rest move over.
        DELETE FROM meme_entry_revisions v
        WHERE v.entry_id = dup.id
          AND EXISTS (SELECT 1 FROM meme_entry_revisions k WHERE k.entry_id = dup.keeper_id AND k.revision = v.revision);
        UPDATE meme_entry_revisions SET entry_id = dup.keeper_id WHERE entry_id = dup.id;

        -- Search: a pending document for the merged id must not be delivered after the delete; queue the tombstone.
        DELETE FROM meme_outbox WHERE published_at IS NULL AND payload->>'id' = dup.id;
        INSERT INTO meme_outbox (event_id, topic, payload, created_at, next_attempt_at)
        VALUES ('evt_' || substr(dup.id, 5), 'meme.index_document.deleted',
                jsonb_build_object('owner', 'meme', 'type', 'entry', 'id', dup.id,
                                   'revision', dup.revision + 1, 'deleted', true),
                now(), now())
        ON CONFLICT (event_id) DO NOTHING;

        -- The kept entry takes the merged range, one revision and one history row per merge. The new revision is
        -- above the highest history row either entry brought, not just above the keeper's old counter.
        SELECT GREATEST(k.revision, COALESCE((SELECT MAX(r.revision) FROM meme_entry_revisions r WHERE r.entry_id = k.id), 0)) + 1
        INTO keeper_revision
        FROM meme_entries k WHERE k.id = dup.keeper_id;

        UPDATE meme_entries
        SET revision = keeper_revision,
            first_seen_at = LEAST(first_seen_at, dup.first_seen_at),
            last_seen_at = GREATEST(last_seen_at, dup.last_seen_at),
            updated_at = now()
        WHERE id = dup.keeper_id;

        INSERT INTO meme_entry_revisions (entry_id, revision, author, base_revision, change, diff, moderation_state, note, created_at, reviewed_at, reviewed_by)
        VALUES (dup.keeper_id, keeper_revision, 'service:meme:migration', keeper_revision - 1,
                jsonb_build_object('merge', jsonb_build_object('id', dup.id, 'slug', dup.slug)),
                jsonb_build_array(jsonb_build_object('field', 'merged', 'from', dup.slug, 'to', dup.keeper_slug)),
                'approved', 'duplicate merged by migration 0009', now(), now(), 'service:meme:migration');

        INSERT INTO meme_status_events (entry_id, from_status, to_status, reason, changed_by, decision, from_visibility, to_visibility)
        VALUES (dup.keeper_id, dup.keeper_status, dup.keeper_status,
                'merged duplicate ' || dup.id || ' (/' || dup.slug || ') into /' || dup.keeper_slug,
                'service:meme:migration', 'merge', 'public', 'public');

        INSERT INTO meme_entry_redirects (from_slug, from_entry_id, to_entry_id, reason)
        VALUES (dup.slug, dup.id, dup.keeper_id, 'duplicate merged by migration 0009')
        ON CONFLICT (from_slug) DO NOTHING;

        merged_ids := merged_ids || dup.id;
        moved := moved + 1;
    END LOOP;

    IF cardinality(merged_ids) > 0 THEN
        DELETE FROM meme_entries WHERE id = ANY(merged_ids);
    END IF;
    RETURN moved;
END
$$;

SELECT meme_merge_public_duplicates();

-- From here on a second public entry with the same normalised title and kind cannot exist.
CREATE UNIQUE INDEX meme_entries_public_title_key ON meme_entries (kind, title_key) WHERE visibility = 'public';
