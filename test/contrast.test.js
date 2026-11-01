'use strict';
// WCAG 2.1 AA: white sticker text was 4.4:1 on a 70% room-accent fill, and the root node's small line was 4.1:1
// at .75 opacity. The sticker fill is now 58% accent and the root line sits at .92.
//   node test/contrast.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'meme.css'), 'utf8');
assert.ok(
    css.includes('background: color-mix(in srgb, var(--room-accent) 58%, #000); rotate: -8deg;'),
    'the sticker fill darkens the room accent under white text'
);
assert.ok(!css.includes('var(--room-accent) 70%, #000'), 'the 70% sticker fill is gone');
assert.ok(css.includes('.mm-node-root small { color: inherit; opacity: .92; }'), 'the root node small line is .92, not .75');
console.log('contrast: stickers and the root line read');
