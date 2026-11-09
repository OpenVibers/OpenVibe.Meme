'use strict';
/** Live mentions enrich a known internet meme with source-linked uses; repeated stream phrases never become entries. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const now = new Date().toISOString();
        const known = await t.ctx.entries.createCandidate({
            slug: 'robot-is-offline', title: 'Robot is offline', kind: 'classic', scope: 'internet',
            summary: 'A test encyclopedia entry with a sourced origin.', status: 'classic',
            first_seen_at: '2026-10-20T00:00:00Z', last_seen_at: '2026-10-20T00:00:00Z', visibility: 'public',
            citations: [{ role: 'origin', source_service: 'web', source_type: 'wikipedia', source_id: 'robot-is-offline',
                quote_text: 'This test entry has an independently cited origin.', url: 'https://en.wikipedia.org/wiki/Internet_meme', observed_at: '2026-10-20T00:00:00Z' }],
        });
        let out = null;
        await check('known meme references add cited uses without creating stream-meme entries', async () => {
            out = await t.ctx.importer.runOnce();
            assert.strictEqual(out.errors.length, 0, JSON.stringify(out.errors));
            assert.strictEqual(out.created, 0);
            assert.ok(out.candidates >= 1, 'the known meme title was named in source text');
            assert.ok(out.enriched >= 1, 'the known entry gained citations');
            const entry = await t.ctx.s.db.maybe("SELECT * FROM meme_entries WHERE slug = 'robot-is-offline'");
            assert.ok(entry);
            assert.strictEqual(entry.id, known.entry.id);
            assert.strictEqual(entry.visibility, 'public');
            assert.strictEqual(entry.scope, 'internet');
            const cites = await t.ctx.s.db.many('SELECT * FROM meme_citations WHERE entry_id = $1 ORDER BY observed_at, id', [entry.id]);
            assert.ok(cites.length >= 4, `expected origin and several uses, got ${cites.length}`);
            assert.strictEqual(cites.filter((c) => c.role === 'origin').length, 1);
            assert.ok(cites.some((c) => c.role === 'use' && c.source_type === 'chat_message'));
            assert.ok(cites.some((c) => c.role === 'use' && c.source_type === 'rundown_segment'));
            assert.ok(cites.some((c) => c.role === 'use' && c.source_type === 'vod'));
        });

        await check('joined-VOD references keep their canonical time and prohibited sources stay absent', async () => {
            const c = await t.ctx.s.db.maybe("SELECT * FROM meme_citations WHERE source_type = 'rundown_segment' LIMIT 1");
            assert.strictEqual(Number(c.vod_id), 9002);
            assert.strictEqual(Number(c.offset_seconds), 120);
            assert.match(c.url, /\/v\/9002\?t=120$/);
            const bad = await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_citations WHERE vod_id = 5709 OR clip_id = 483');
            assert.strictEqual(Number(bad), 0);
        });

        await check('repeated phrases remain absent and a repeated known reference does not duplicate citations', async () => {
            const list = await t.get('/api/v1/memes');
            assert.strictEqual(list.json().count, 1);
            const before = Number(await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM meme_citations WHERE source_type IN ('chat_message','rundown_segment','vod')"));
            const again = await t.ctx.importer.runOnce();
            assert.strictEqual(again.created, 0);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM meme_entries WHERE title_key = 'robot is offline'")), 1);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT COUNT(*)::int AS n FROM meme_citations WHERE source_type IN ('chat_message','rundown_segment','vod')")), before);
        });
    } finally {
        await t.close();
    }
    done();
})();
