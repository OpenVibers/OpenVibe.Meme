'use strict';
/**
 * The expand migration applies in one pass and creates exactly the tables the plan names, plus the SDK's account
 * receipts and telemetry. The three data-free templates are seeded; the entry constraints refuse an unknown kind.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('0001_initial.sql applies and creates the Meme tables', async () => {
            const names = (await t.ctx.s.db.many("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name")).map((r) => r.name);
            for (const table of ['meme_entries', 'meme_citations', 'meme_status_events', 'meme_votes', 'meme_templates', 'meme_captions', 'meme_reports', 'meme_outbox', 'account_data_events', 'telemetry_samples']) {
                assert.ok(names.includes(table), `missing ${table}`);
            }
        });

        await check('three data-free templates are seeded', async () => {
            const r = await t.get('/api/v1/templates');
            assert.strictEqual(r.status, 200);
            const b = r.json();
            assert.strictEqual(b.count, 3);
            for (const tpl of b.templates) {
                assert.match(tpl.image_url, /^(https:\/\/openvibe\.media\/|\/img\/)/);
                assert.ok(tpl.box_count >= 1 && tpl.box_count <= 8);
                assert.ok(tpl.license);
            }
        });

        await check('entry constraints refuse an unknown kind, a bad slug and a duplicate slug', async () => {
            const db = t.ctx.s.db;
            const at = new Date().toISOString();
            const id = () => `mem_${ids.ulid()}`;
            await assert.rejects(db.exec(
                `INSERT INTO meme_entries (id, slug, title, kind, first_seen_at, last_seen_at) VALUES ($1, 'bad-kind', 'Bad', 'notakind', $2, $2)`,
                [id(), at],
            ), /meme_entries_kind/);
            await assert.rejects(db.exec(
                `INSERT INTO meme_entries (id, slug, title, kind, first_seen_at, last_seen_at) VALUES ($1, 'Not A Slug', 'Bad', 'joke', $2, $2)`,
                [id(), at],
            ), /meme_entries_slug/);
            await db.exec(`INSERT INTO meme_entries (id, slug, title, kind, first_seen_at, last_seen_at) VALUES ($1, 'once', 'Once', 'joke', $2, $2)`, [id(), at]);
            await assert.rejects(db.exec(`INSERT INTO meme_entries (id, slug, title, kind, first_seen_at, last_seen_at) VALUES ($1, 'once', 'Twice', 'joke', $2, $2)`, [id(), at]), /duplicate key|unique/i);
        });

        await check('the one-vote-a-week primary key is real', async () => {
            const db = t.ctx.s.db;
            const at = new Date().toISOString();
            const id = () => `mem_${ids.ulid()}`;
            await db.exec(`INSERT INTO meme_entries (id, slug, title, kind, visibility, first_seen_at, last_seen_at) VALUES ($1, 'votable', 'Votable', 'joke', 'public', $2, $2)`, [id(), at]);
            const subject = ids.newId('user');
            const eid = await db.value("SELECT id FROM meme_entries WHERE slug = 'votable'");
            await db.exec("INSERT INTO meme_votes (week, entry_id, subject) VALUES ('2026-W44', $1, $2)", [eid, subject]);
            await assert.rejects(db.exec("INSERT INTO meme_votes (week, entry_id, subject) VALUES ('2026-W44', $1, $2)", [eid, subject]), /duplicate key|unique/i);
        });
    } finally {
        await t.close();
    }
    done();
})();
