'use strict';
/**
 * The first proof: scripts/seed-proof.js reads the fixture public APIs, creates "Cozmo is offline" hidden with
 * exactly two citations (chat message 86957 and VOD 6025 @ 1541 s, the canonical target of /v/6026?t=864), never
 * publishes it, and is idempotent on a second run.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { runSeed } = require('../scripts/seed-proof');

(async () => {
    const t = await boot();
    try {
        let out = null;
        await check('the seed creates the hidden proof with its two canonical citations', async () => {
            out = await runSeed({ config: t.config, s: t.ctx.s, upstreams: t.ctx.upstreams, log: { log() {} } });
            assert.strictEqual(out.created, true);
            assert.strictEqual(out.entry.slug, 'cozmo-offline');
            assert.strictEqual(out.entry.title, 'Cozmo is offline');
            assert.strictEqual(out.entry.visibility, 'hidden');
            assert.strictEqual(out.entry.status, 'classic');
            const cites = await t.ctx.s.db.many('SELECT * FROM meme_citations WHERE entry_id = $1 ORDER BY role', [out.entry.id]);
            assert.strictEqual(cites.length, 2);
            const origin = cites.find((c) => c.role === 'origin');
            assert.strictEqual(origin.source_type, 'chat_message');
            assert.strictEqual(Number(origin.chat_message_id), 86957);
            const use = cites.find((c) => c.role === 'use');
            assert.strictEqual(use.source_type, 'vod');
            assert.strictEqual(Number(use.vod_id), 6025);
            assert.strictEqual(Number(use.offset_seconds), 1541);
            assert.match(use.url, /\/v\/6025\?t=1541$/);
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_citations WHERE vod_id = 5709 OR clip_id = 483')), 0);
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_outbox')), 0);
            assert.strictEqual((await t.get('/api/v1/entries/cozmo-offline')).status, 404);
        });

        await check('a second run adds nothing and leaves the entry hidden', async () => {
            const again = await runSeed({ config: t.config, s: t.ctx.s, upstreams: t.ctx.upstreams, log: { log() {} } });
            assert.strictEqual(again.created, false);
            assert.strictEqual(again.added, 0);
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_citations')), 2);
            const e = await t.ctx.s.db.maybe("SELECT * FROM meme_entries WHERE slug = 'cozmo-offline'");
            assert.strictEqual(e.visibility, 'hidden');
        });
    } finally {
        await t.close();
    }
    done();
})();
