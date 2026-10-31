'use strict';
/**
 * L24: there is no looks filter. A summary that describes what the AI saw is stored as written; only an empty
 * summary falls back to the title. Verbatim quotes are never rewritten.
 */
const assert = require('assert');
const { cleanSummary } = require('../server/text/no-looks');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    await check('a summary that describes a person is kept as written', async () => {
        assert.strictEqual(cleanSummary('Cozmo is offline', 'A shirtless man in a kitchen laughs.'), 'A shirtless man in a kitchen laughs.');
        assert.strictEqual(cleanSummary('Cozmo is offline', '  A little   robot is not online. '), 'A little robot is not online.');
        assert.strictEqual(cleanSummary('Cozmo is offline', ''), 'Cozmo is offline');
    });

    const t = await boot();
    try {
        await check('createCandidate stores the summary verbatim (no looks filter)', async () => {
            const out = await t.ctx.entries.createCandidate({
                slug: 'looks', title: 'Robot is offline', kind: 'meme', summary: 'A shirtless man reacts to the offline robot.',
                status: 'rising', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), visibility: 'hidden',
                citations: [{ role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: '1001', quote_text: 'the robot is offline again', url: `${t.upstreams.url}/`, observed_at: new Date().toISOString() }],
            });
            assert.strictEqual(out.entry.summary, 'A shirtless man reacts to the offline robot.');
            const quote = await t.ctx.s.db.value('SELECT quote_text FROM meme_citations WHERE entry_id = $1', [out.entry.id]);
            assert.strictEqual(quote, 'the robot is offline again', 'the verbatim quote is not rewritten');
        });
    } finally {
        await t.close();
    }
    done();
})();
