'use strict';
// The home's citation and use scenes show the first real trending entry: the quote, source, second and date of its
// cited moment, and its own cited uses per day. Without one they say so; the caption stays a generator preview and is
// labelled Example. No written-in quote, use series or cast.
const assert = require('assert');
const views = require('../server/views');

const feature = {
    entry: { slug: 'cosmo', title: 'Cozmo is offline', status: 'rising' },
    citations: [{ role: 'origin', source_type: 'vod', offset_seconds: 1541, quote_text: 'a real quoted line', observed_at: '2026-11-01T10:00:00Z', url: 'https://openvibe.live/v/1' }],
    series: { series: [{ day: '2026-10-29', uses: 0 }, { day: '2026-10-30', uses: 2 }, { day: '2026-10-31', uses: 1 }] },
};
const page = views.home({ feature });
assert.ok(page.includes('a real quoted line'), 'the real quote');
assert.ok(page.includes('VOD') && page.includes('at 25:41') && page.includes('2026-11-01'), 'its real source, second and date');
assert.ok(page.includes('href="https://openvibe.live/v/1"'), 'the citation links its moment');
assert.ok(page.includes('uses per day, last 3 days') && page.includes('Cozmo is offline'), 'the real use series');
assert.ok(page.includes('href="/m/cosmo"'), 'the entry is linked');
assert.ok(page.includes('Example caption'), 'the caption preview says Example');
assert.ok(!/but yeah and Cosmo is broken now/.test(page), 'no written-in quote');
assert.ok(page.includes('Cozmo is offline') && page.includes('VOD · 25:41'), 'the hero tree also uses the real entry');

const empty = views.home({});
assert.ok(empty.includes('No cited moment yet'), 'no citation: says so');
assert.ok(empty.includes('No uses cited in the last 10 days'), 'no uses: says so');
assert.ok(!/but yeah and Cosmo is broken now|\[2, 3, 2, 4, 6, 5, 8, 11, 9, 14\]|Cozmo is offline|25:41/.test(empty), 'no written-in quote, series, entry or timestamp');
assert.ok(empty.includes('Example caption'), 'the caption preview still says Example');

console.log('meme home: the citation and rise scenes read the first real entry, or say there is none');
