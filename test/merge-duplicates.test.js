'use strict';
/**
 * Migration 0009: a public entry's title is unique for its kind, and the duplicates that already exist are merged
 * into the oldest entry. This test boots the schema as it stood before 0009 (migrations 0001–0008), creates the
 * two-entry shape production had, applies 0009, and checks that everything moved, that the old address answers
 * 301, and that a second public entry with the same normalised title is refused.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { MIGRATIONS } = require('../server/db');

const ulid = () => ids.ulid();

(async () => {
    const beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-0009-'));
    for (const f of fs.readdirSync(MIGRATIONS)) {
        if (/^000[1-8]_/.test(f)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(beforeDir, f));
    }
    const t = await boot({ migrations: beforeDir });
    try {
        const db = t.ctx.s.db;
        const now = new Date().toISOString();
        const cite = (o) => ({ source_service: 'live', source_type: 'rundown_segment', url: 'https://openvibe.video/v/1?t=1', quote_text: 'keep friends close', observed_at: '2026-10-14T13:16:25.000Z', ...o });

        const keeper = await t.ctx.entries.createCandidate({
            slug: 'keep-friends-close', title: 'Keep friends close', kind: 'catchphrase', visibility: 'public',
            first_seen_at: '2026-10-14T13:16:25.000Z', last_seen_at: '2026-10-19T13:25:56.000Z',
            citations: [
                cite({ role: 'origin', source_id: '1', quote_text: 'Keep friends close.', observed_at: '2026-10-14T13:16:25.000Z' }),
                cite({ role: 'use', source_id: '2', quote_text: 'Keep friends close and enemies guessing.' }),
            ],
        });
        const dup = await t.ctx.entries.createCandidate({
            slug: 'close-and-enemies', title: 'Keep friends close and enemies guessing', kind: 'catchphrase', visibility: 'public',
            first_seen_at: '2026-10-19T13:25:56.000Z', last_seen_at: '2026-10-19T13:25:56.000Z',
            citations: [
                cite({ role: 'origin', source_id: '3', quote_text: 'Keep friends close and enemies guessing.', observed_at: '2026-10-19T13:25:56.000Z' }),
                cite({ role: 'use', source_id: '4', quote_text: 'Keep friends close and enemies guessing.' }),
                // The keeper already has this moment: the merge must drop it, not violate the citation key.
                cite({ role: 'use', source_id: '2', quote_text: 'Keep friends close and enemies guessing.' }),
            ],
        });
        const third = await t.ctx.entries.createCandidate({
            slug: 'third-meme', title: 'Third meme', kind: 'joke', visibility: 'public',
            first_seen_at: now, last_seen_at: now, citations: [cite({ source_id: '5', quote_text: 'third' })],
        });

        // Give the keeper a different title so both rows can exist before 0009, like the production pair: two
        // different phrases (and slugs) that the judge later rewrote into the same words.
        await db.exec("UPDATE meme_entries SET title = 'Keep friends close and enemies guessing' WHERE id = $1", [keeper.entry.id]);
        assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM meme_entries WHERE visibility = 'public'")), 3);

        const subjectA = `usr_${ulid()}`;
        const subjectB = `usr_${ulid()}`;
        await db.exec("INSERT INTO meme_votes (week, entry_id, subject) VALUES ('2026-W45', $1, $2)", [keeper.entry.id, subjectA]);
        await db.exec("INSERT INTO meme_votes (week, entry_id, subject) VALUES ('2026-W45', $1, $2)", [dup.entry.id, subjectB]);
        await db.exec("INSERT INTO meme_reports (id, entry_id, subject, kind, reason) VALUES ($1, $2, $3, 'correction', 'the quote is wrong')",
            [`mrp_${ulid()}`, dup.entry.id, subjectA]);
        await db.exec("INSERT INTO meme_status_events (entry_id, from_status, to_status, reason, changed_by, decision) VALUES ($1, 'peaked', 'peaked', 'judged', 'service:meme:judge', 'judge')", [dup.entry.id]);
        await db.exec("INSERT INTO meme_judgements (entry_id, score, reason, title) VALUES ($1, 0.750, 'duplicate judgement', 'Keep friends close and enemies guessing')", [dup.entry.id]);
        await db.exec("INSERT INTO meme_origins (entry_id, source, url, title) VALUES ($1, 'web', 'https://example.org/dup', 'dup origin')", [dup.entry.id]);
        await db.exec("INSERT INTO meme_spread_points (entry_id, observed_at, place, url, count) VALUES ($1, now(), 'reddit', 'https://example.org/spread', 12)", [dup.entry.id]);
        await db.exec("INSERT INTO meme_variations (entry_id, name) VALUES ($1, 'a variation')", [dup.entry.id]);
        await db.exec("INSERT INTO meme_examples (entry_id, media_id) VALUES ($1, $2)", [dup.entry.id, `med_${ulid()}`]);
        await db.exec("INSERT INTO meme_entry_related (entry_id, related_id) VALUES ($1, $2)", [dup.entry.id, keeper.entry.id]);
        await db.exec("INSERT INTO meme_entry_related (entry_id, related_id) VALUES ($1, $2)", [dup.entry.id, third.entry.id]);
        await db.exec("INSERT INTO meme_entry_related (entry_id, related_id) VALUES ($1, $2)", [keeper.entry.id, third.entry.id]);
        await db.exec("INSERT INTO meme_entry_revisions (entry_id, revision, author, change, diff, moderation_state) VALUES ($1, 2, 'service:meme', '{}'::jsonb, '[]'::jsonb, 'approved')", [keeper.entry.id]);
        await db.exec("INSERT INTO meme_entry_revisions (entry_id, revision, author, change, diff, moderation_state) VALUES ($1, 2, 'service:meme', '{}'::jsonb, '[]'::jsonb, 'approved')", [dup.entry.id]);
        await db.exec("INSERT INTO meme_entry_revisions (entry_id, revision, author, change, diff, moderation_state) VALUES ($1, 3, 'service:meme', '{}'::jsonb, '[]'::jsonb, 'approved')", [dup.entry.id]);
        await db.exec('UPDATE meme_entries SET revision = 3 WHERE id = $1', [dup.entry.id]);
        await db.exec('UPDATE meme_entries SET revision = 2 WHERE id = $1', [keeper.entry.id]);

        await check('0009 merges the public duplicates into the oldest id and moves everything to it', async () => {
            const sql = fs.readFileSync(path.join(MIGRATIONS, '0009_entry_title_key.sql'), 'utf8');
            await db.query(sql);

            const rows = await db.many("SELECT id, slug, title, kind, revision FROM meme_entries WHERE visibility = 'public' ORDER BY slug");
            assert.strictEqual(rows.length, 2, 'one public entry per title: ' + JSON.stringify(rows));
            const kept = rows.find((r) => r.id === keeper.entry.id);
            assert.ok(kept, 'the oldest id was kept');
            assert.strictEqual(kept.slug, 'keep-friends-close');
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_entries WHERE id = $1', [dup.entry.id])), 0);

            const cites = await db.many('SELECT role, source_id FROM meme_citations WHERE entry_id = $1 ORDER BY id', [kept.id]);
            assert.strictEqual(cites.length, 4, 'four distinct moments: ' + JSON.stringify(cites));
            assert.strictEqual(cites.filter((c) => c.role === 'origin').length, 1, 'the keeper keeps one origin');
            assert.strictEqual(cites.filter((c) => c.source_id === '2').length, 1, 'the shared moment was not copied twice');

            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_votes WHERE entry_id = $1', [kept.id])), 2);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_reports WHERE entry_id = $1', [kept.id])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_spread_points WHERE entry_id = $1', [kept.id])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_entry_related WHERE entry_id = $1', [kept.id])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_judgements WHERE entry_id = $1', [kept.id])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_origins WHERE entry_id = $1', [kept.id])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_entry_revisions WHERE entry_id = $1', [kept.id])), 4);
            assert.strictEqual(Number(await db.value("SELECT COUNT(*)::int AS n FROM meme_status_events WHERE entry_id = $1 AND decision = 'merge'", [kept.id])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_entry_redirects WHERE to_entry_id = $1', [kept.id])), 1);

            const redirect = await db.maybe('SELECT * FROM meme_entry_redirects WHERE from_slug = $1', ['close-and-enemies']);
            assert.strictEqual(redirect.from_entry_id, dup.entry.id);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_outbox WHERE topic = $1 AND payload->>\'id\' = $2', ['meme.index_document.deleted', dup.entry.id])), 1);
        });

        await check('the old slug and the old id both answer 301 to the kept entry', async () => {
            const page = await t.get('/m/close-and-enemies');
            assert.strictEqual(page.status, 301);
            assert.strictEqual(page.headers.get('location'), '/m/keep-friends-close');
            const byId = await t.get(`/m/${dup.entry.id}`);
            assert.strictEqual(byId.status, 301);
            assert.strictEqual(byId.headers.get('location'), '/m/keep-friends-close');
            const api = await t.get('/api/v1/entries/close-and-enemies');
            assert.strictEqual(api.status, 301);
            assert.strictEqual(api.headers.get('location'), '/api/v1/entries/keep-friends-close');
        });

        await check('a second public entry with the same title and kind is refused, and Trending lists it once', async () => {
            const at = new Date().toISOString();
            await assert.rejects(db.exec(
                `INSERT INTO meme_entries (id, slug, title, kind, visibility, first_seen_at, last_seen_at)
                 VALUES ($1, 'another-keep-friends', 'KEEP friends close, and enemies guessing!', 'catchphrase', 'public', $2, $2)`,
                [`mem_${ulid()}`, at],
            ), /meme_entries_public_title_key|duplicate key|unique/i);
            const trending = await t.ctx.entries.trending({ limit: 50 });
            const keys = trending.map((e) => `${e.kind}:${e.title.toLowerCase()}`);
            assert.strictEqual(new Set(keys).size, keys.length, 'no repeated title in Trending: ' + JSON.stringify(keys));
        });
    } finally {
        await t.close();
        fs.rmSync(beforeDir, { recursive: true, force: true });
    }
    done();
})();
