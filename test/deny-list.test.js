'use strict';
/**
 * The fixed deny list: VOD 5709 and clip 483 are never cited. Both the unit helper and an importer run over a
 * fixture take that names VOD 5709 are checked, and no row may carry either id.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const deny = require('../server/deny-list');

(async () => {
    await check('isDenied knows both ids, in wire and database shapes', async () => {
        assert.strictEqual(deny.isDenied({ vod_id: 5709 }), true);
        assert.strictEqual(deny.isDenied({ vodId: '5709' }), true);
        assert.strictEqual(deny.isDenied({ clip_id: 483 }), true);
        assert.strictEqual(deny.isDenied({ clipId: '483' }), true);
        assert.strictEqual(deny.isDenied({ vod_id: 6026, clip_id: 518 }), false);
        assert.strictEqual(deny.allowed([{ vod_id: 5709 }, { vod_id: 6026 }, { clip_id: 483 }]).length, 1);
    });

    const t = await boot();
    try {
        await check('the importer never writes a citation for VOD 5709, even from a Rundown take', async () => {
            const r = await t.ctx.importer.runOnce();
            assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
            const n = await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_citations WHERE vod_id = 5709 OR clip_id = 483');
            assert.strictEqual(Number(n), 0);
            const all = await t.ctx.s.db.many('SELECT source_id, vod_id, quote_text FROM meme_citations');
            assert.ok(!all.some((c) => c.quote_text.includes('must never become a citation')));
        });
    } finally {
        await t.close();
    }
    done();
})();
