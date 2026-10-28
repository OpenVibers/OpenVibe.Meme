'use strict';
/**
 * No looks in public AI text: a summary that names looks is replaced by the entry's title; a normal summary is
 * kept and repaired only where noLooks has something to repair. Verbatim quotes are never passed through.
 */
const assert = require('assert');
const { cleanSummary, hasLooks } = require('../server/text/no-looks');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    await check('a summary that names looks becomes the title', async () => {
        assert.strictEqual(cleanSummary('Cozmo is offline', 'A shirtless man in a kitchen laughs.'), 'Cozmo is offline');
        assert.strictEqual(cleanSummary('Cozmo is offline', 'A little robot is not online.'), 'Cozmo is offline');
        assert.ok(hasLooks('A shirtless man in a kitchen laughs.'));
    });

    await check('an ordinary summary survives', async () => {
        const s = cleanSummary('Cozmo is offline', 'The robot is not online; chat keeps asking about its Wi-Fi.');
        assert.strictEqual(s, 'The robot is not online; chat keeps asking about its Wi-Fi.');
    });

    const t = await boot();
    try {
        await check('createCandidate stores the title, never the looks summary', async () => {
            const out = await t.ctx.entries.createCandidate({
                slug: 'looks', title: 'Robot is offline', kind: 'meme', summary: 'A shirtless man reacts to the offline robot.',
                status: 'rising', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), visibility: 'hidden',
                citations: [{ role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: '1001', quote_text: 'the robot is offline again', url: `${t.upstreams.url}/`, observed_at: new Date().toISOString() }],
            });
            assert.strictEqual(out.entry.summary, 'Robot is offline');
            const quote = await t.ctx.s.db.value('SELECT quote_text FROM meme_citations WHERE entry_id = $1', [out.entry.id]);
            assert.strictEqual(quote, 'the robot is offline again', 'the verbatim quote is not rewritten');
        });
    } finally {
        await t.close();
    }
    done();
})();
