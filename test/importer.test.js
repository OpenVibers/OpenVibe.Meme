'use strict';
/**
 * The importer reads the fixture Chat history/timeline, Rundown topics and VOD transcripts, finds "robot is
 * offline" across four uses on three days, canonicalises `/v/9001?t=60` → `/v/9002?t=120`, and inserts the
 * candidate hidden. It never publishes; a second run enriches nothing and makes no second entry. The deny-list
 * take (VOD 5709) never reaches a citation.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        let out = null;
        await check('the fixture produces one candidate from ≥2 uses on ≥2 days, hidden', async () => {
            out = await t.ctx.importer.runOnce();
            assert.strictEqual(out.errors.length, 0, JSON.stringify(out.errors));
            assert.ok(out.created >= 1);
            const e = await t.ctx.s.db.maybe("SELECT * FROM meme_entries WHERE slug = 'robot-is-offline'");
            assert.ok(e, 'the candidate entry exists');
            assert.strictEqual(e.visibility, 'hidden');
            assert.strictEqual(e.title, 'Robot is offline');
            const cites = await t.ctx.s.db.many('SELECT * FROM meme_citations WHERE entry_id = $1 ORDER BY observed_at, id', [e.id]);
            assert.ok(cites.length >= 3, `expected several citations, got ${cites.length}`);
            const days = new Set(cites.map((c) => String(c.observed_at).slice(0, 10)));
            assert.ok(days.size >= 2, 'uses are on at least two days');
            assert.strictEqual(cites.filter((c) => c.role === 'origin').length, 1);
            assert.ok(cites.some((c) => c.source_type === 'chat_message'));
            assert.ok(cites.some((c) => c.source_type === 'rundown_segment'));
            assert.ok(cites.some((c) => c.source_type === 'vod'));
        });

        await check('a joined-VOD redirect is stored canonically (9002@120, not 9001@60)', async () => {
            const c = await t.ctx.s.db.maybe("SELECT * FROM meme_citations WHERE source_type = 'rundown_segment' LIMIT 1");
            assert.strictEqual(Number(c.vod_id), 9002);
            assert.strictEqual(Number(c.offset_seconds), 120);
            assert.match(c.url, /\/v\/9002\?t=120$/);
        });

        await check('no citation names VOD 5709 or clip 483', async () => {
            const bad = await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_citations WHERE vod_id = 5709 OR clip_id = 483');
            assert.strictEqual(Number(bad), 0);
        });

        await check('the candidate is hidden from the public API and a second run does not duplicate it', async () => {
            const list = await t.get('/api/v1/entries');
            assert.strictEqual(list.json().count, 0);
            const one = await t.get('/api/v1/entries/robot-is-offline');
            assert.strictEqual(one.status, 404);
            const again = await t.ctx.importer.runOnce();
            assert.strictEqual(again.created, 0);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM meme_entries WHERE slug = 'robot-is-offline'")), 1);
        });
    } finally {
        await t.close();
    }
    done();
})();
