-- phase: expand
-- 0009 stopped two *public* entries from sharing a title, but the old candidate miner kept inserting hidden
-- candidates: it deduped the phrase's slug before the judge rewrote the title, so a new window of the same
-- running joke became a hidden row with the public entry's title, its own slug and its own citations. Those
-- rows cannot be published (the public unique index refuses them), they never appear on Trending, and one of
-- them took back the old slug `close-and-enemies`, hiding the 301 that 0009 had created. The miner is gone
-- (the importer only enriches known entries now), so this expands 0009 to settle the hidden rows it left.
--
-- Every hidden entry with the same (kind, title_key) as a public entry is merged into that public entry: its
-- citations, votes, reports, judgements, origins, spread, examples, variations, related rows and history move,
-- one merge event is written to the kept entry, and its old slug and id become 301 redirects. A redirect that
-- already points at the hidden row is retargeted first, so no link is lost when the row is deleted.

CREATE FUNCTION meme_merge_duplicate_entries() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    dup record;
    keeper_revision bigint;
    merged_ids text[] := '{}';
    moved integer := 0;
BEGIN
    FOR dup IN
        SELECT e.id, e.slug, e.kind, e.revision, e.first_seen_at, e.last_seen_at,
               k.id AS keeper_id, k.slug AS keeper_slug, k.status AS keeper_status
        FROM meme_entries e
        JOIN LATERAL (
            SELECT p.*
            FROM meme_entries p
            WHERE p.kind = e.kind AND p.title_key = e.title_key AND p.visibility = 'public'
            ORDER BY p.created_at ASC, p.id ASC
            LIMIT 1
        ) k ON true
        WHERE e.id <> k.id AND e.visibility IN ('public', 'hidden')
        ORDER BY e.kind, e.title_key, e.created_at, e.id
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

        -- Related memes: a relation between the two duplicates disappears; a relation the keeper already has
        -- wins; the rest are rewritten to the keeper.
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
                'approved', 'duplicate merged by migration 0011', now(), now(), 'service:meme:migration');

        INSERT INTO meme_status_events (entry_id, from_status, to_status, reason, changed_by, decision, from_visibility, to_visibility)
        VALUES (dup.keeper_id, dup.keeper_status, dup.keeper_status,
                'merged duplicate ' || dup.id || ' (/' || dup.slug || ') into /' || dup.keeper_slug,
                'service:meme:migration', 'merge', 'public', 'public');

        -- A redirect already pointing at this hidden row follows the merge, then the old slug and id get one.
        UPDATE meme_entry_redirects SET to_entry_id = dup.keeper_id WHERE to_entry_id = dup.id;
        INSERT INTO meme_entry_redirects (from_slug, from_entry_id, to_entry_id, reason)
        VALUES (dup.slug, dup.id, dup.keeper_id, 'duplicate merged by migration 0011')
        ON CONFLICT DO NOTHING;

        merged_ids := merged_ids || dup.id;
        moved := moved + 1;
    END LOOP;

    IF cardinality(merged_ids) > 0 THEN
        DELETE FROM meme_entries WHERE id = ANY(merged_ids);
    END IF;
    RETURN moved;
END
$$;

SELECT meme_merge_duplicate_entries();
