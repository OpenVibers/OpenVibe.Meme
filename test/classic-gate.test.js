'use strict';
// The classics' rule (10-31): a classic Wikipedia documents is published on its score, its written text and a clean
// deny list. It needs no example uses (that is how a chat catchphrase proves itself) and is not held for describing
// people (the owner lifted the looks rule that day). A low score, a denied source or missing text still keep it hidden.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { evaluateClassic } = require('../server/ai/gate');

const ok = { score: 0.9, title: 'Flex Tape', summary: 'An infomercial that became a meme.', origin: '2017 infomercial', spread: 'Reaction videos', examples: [], denied: false, looks: false };
assert.strictEqual(evaluateClassic({ judgement: ok }).publish, true, 'no examples needed for a classic');
assert.strictEqual(evaluateClassic({ judgement: { ...ok, looks: true }, entry: { title: 'The man in the hat' } }).publish, true, 'describing people no longer holds a classic back');
assert.strictEqual(evaluateClassic({ judgement: { ...ok, score: 0.5 } }).publish, false, 'a low score still does');
assert.strictEqual(evaluateClassic({ judgement: { ...ok, denied: true } }).publish, false, 'a denied source still does');
assert.strictEqual(evaluateClassic({ judgement: { ...ok, summary: '' } }).publish, false, 'missing text still does');

const script = fs.readFileSync(path.join(__dirname, '..', 'scripts/regate-classics.js'), 'utf8');
assert.ok(!/createMemeAi|judge\.judge\(/.test(script), 'the re-gate calls no AI');
assert.match(script, /entries\.publish\(r\.slug/, 'and publishes through the store (origin check, Search document)');
console.log('classic gate: score, text and deny list; no examples or looks bar');
