'use strict';
// The public homepage is about the internet meme encyclopedia and must not turn OpenVibe stream catchphrases into memes.
const assert = require('assert');
const views = require('../server/views');

const feature = {
    entry: { slug: 'cosmo', title: 'Cozmo is offline', status: 'rising' },
    citations: [{ role: 'origin', source_type: 'vod', offset_seconds: 1541, quote_text: 'a real quoted line', observed_at: '2026-11-01T10:00:00Z', url: 'https://openvibe.live/v/1' }],
    series: { series: [{ day: '2026-10-29', uses: 0 }, { day: '2026-10-30', uses: 2 }, { day: '2026-10-31', uses: 1 }] },
};
const page = views.home({ feature });
assert.ok(page.includes('Know the meme. Make it yours.'), 'library-first positioning');
assert.ok(page.includes('Search memes and formats'), 'server-rendered library search');
assert.ok(page.includes('href="/browse?scope=internet"'), 'internet meme collection link');
assert.ok(!page.includes('a real quoted line'), 'does not feature stream catchphrases');
assert.ok(!page.includes('https://openvibe.live/v/1'), 'does not link a stream moment');
assert.ok(page.includes('Example caption'), 'the caption preview says Example');
assert.ok(page.includes('A meme\'s origin') && page.includes('new variations'), 'the hero illustrates an internet meme lifecycle');

const empty = views.home({});
assert.ok(!/but yeah and Cosmo is broken now|\[2, 3, 2, 4, 6, 5, 8, 11, 9, 14\]|Cozmo is offline|25:41|VOD/.test(empty), 'no stream quote, series, entry or timestamp');
assert.ok(empty.includes('Example caption'), 'the caption preview still says Example');

console.log('meme home: the citation and rise scenes read the first real entry, or say there is none');
