'use strict';
/**
 * The owner, 2026-10-31: AI text may describe people. openvibe-sdk 0.78.0 turns its looks filter off, so a summary that
 * describes a person is kept as written and nothing is held back over it. The explicit gate (sex acts and porn) is a
 * different rule and stays.
 */
const assert = require('assert');
const { cleanSummary, hasLooks } = require('../server/text/no-looks');
const { check, done } = require('./helpers/boot');

(async () => {
    await check('a summary that describes a person is kept as written', async () => {
        assert.strictEqual(cleanSummary('Cozmo is offline', 'A shirtless man in a kitchen laughs.'), 'A shirtless man in a kitchen laughs.');
        assert.strictEqual(hasLooks('A man in a blue shirt'), false);
    });
    await check('an ordinary summary survives too', async () => {
        assert.strictEqual(cleanSummary('Cozmo is offline', 'The robot is not online; chat keeps asking about its Wi-Fi.'), 'The robot is not online; chat keeps asking about its Wi-Fi.');
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
