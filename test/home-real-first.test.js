'use strict';
// Meme's home leads with what is real (the owner, 10-31: empty sections made the rooms look unfinished). With no public
// entry and no candidate this week, there is no empty Trending or Meme of the week up top: one short "be the first" row
// sits after the scenes and says how each starts. Once there are entries, they lead above the scenes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const views = require('../server/views');

const src = fs.readFileSync(path.join(__dirname, '..', 'server/views/index.js'), 'utf8');
assert.match(src, /room\.slice\(0, at\) \+ live \+ room\.slice\(at, end\) \+ beFirst \+ room\.slice\(end\)/, 'the real above the scenes, the missing after them');

const empty = views.home({ trending: [], week: null, counts: {} });
assert.ok(!empty.includes('id="mm-trending"') && !empty.includes('id="mm-week-teaser"'), 'no empty section');
assert.ok(!empty.includes('href="#mm-trending"'), 'no chip to a section that is not there');
const scenes = empty.indexOf('class="sc-room-scenes"');
assert.ok(scenes > 0 && empty.indexOf('Be the first') > scenes, 'the row follows the scenes');
assert.ok(empty.includes('href="/make">Open the generator</a>') && empty.includes('href="/developers">How entries are built</a>'), 'each says how it starts');

const entry = { slug: 'robot-offline', title: 'Robot is offline', kind: 'joke', summary: 'When the robot drops.', status: 'rising', uses: 4, citations: [] };
const some = views.home({ trending: [entry], week: { candidates: [entry] }, counts: { entries: 1 } });
assert.ok(some.indexOf('id="mm-trending"') > 0 && some.indexOf('id="mm-trending"') < some.indexOf('class="sc-room-scenes"'), 'entries lead above the scenes');
assert.ok(!some.includes('Be the first'), 'nothing missing, no row');
console.log('meme home: real first, one "be the first" row after the scenes while nothing is public');
