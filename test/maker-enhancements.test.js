'use strict';

const assert = require('assert');
const sharp = require('sharp');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const mediaId = 'med_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const calls = [];
    const t = await boot({
        media: { async upload(bytes, options) { calls.push({ bytes, options }); return { media_id: mediaId, url: `https://openvibe.media/o/${mediaId}` }; } },
        generateAi: { async run(workflow, input) { assert.strictEqual(workflow, 'meme.caption'); assert.ok(input.format); assert.ok(input.topic); return { ok: true, output: { ideas: ['when tests pass\nship it', 'when the fixture finally loads'] }, costUsd: 0 }; } },
    });
    const alice = t.network.addUser('alice');
    const mod = t.network.addUser('mod', { role: 'global_mod' });
    const png = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#39445a' } }).png().toBuffer();
    const data = `data:image/png;base64,${png.toString('base64')}`;
    try {
        await check('member template upload is sent to Media and remains hidden until staff approval', async () => {
            const sent = await t.get('/api/v1/templates/uploads', { as: alice, json: { name: 'My panel', image: data } });
            assert.strictEqual(sent.status, 202, sent.text);
            const id = sent.json().template.id;
            assert.strictEqual(sent.json().review_status, 'pending');
            const pendingContract = contracts.validate('meme.template@1', sent.json().template);
            assert.strictEqual(pendingContract.valid, true, JSON.stringify(pendingContract.errors));
            assert.strictEqual(calls.length, 1);
            assert.ok(calls[0].bytes.length > 0);
            assert.ok(!(await t.get('/api/v1/templates')).json().templates.some((x) => x.id === id));
            const pending = await t.get('/api/v1/staff/templates/uploads', { as: mod });
            assert.ok(pending.json().templates.some((x) => x.id === id));
            assert.strictEqual((await t.get(`/api/v1/staff/templates/${id}/review`, { as: mod, method: 'POST', json: { decision: 'approved' } })).status, 200);
            const listed = (await t.get('/api/v1/templates')).json().templates;
            assert.ok(listed.some((x) => x.id === id));
            for (const template of listed) {
                const checked = contracts.validate('meme.template@1', template);
                assert.strictEqual(checked.valid, true, `${template.id}: ${JSON.stringify(checked.errors)}`);
            }
        });
        await check('invalid and oversized member image uploads are rejected before Media', async () => {
            assert.strictEqual((await t.get('/api/v1/templates/uploads', { as: alice, json: { name: 'Nope', image: 'data:image/svg+xml;base64,PHN2Zy8+' } })).status, 400);
            assert.strictEqual((await t.get('/api/v1/templates/uploads', { as: alice, json: { name: 'Nope', image: `data:image/png;base64,${Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64')}` } })).status, 400);
            assert.strictEqual(calls.length, 1);
        });
        await check('signed-out AI idea requests select the cheapest task and return short options', async () => {
            const response = await t.get('/api/v1/caption-ideas', { json: { template_id: 'tpl_classic', topic: 'shipping a fix' } });
            assert.strictEqual(response.status, 200, response.text);
            assert.deepStrictEqual(response.json().ideas[0], ['when tests pass', 'ship it']);
            assert.strictEqual(response.json().objective, 'cheapest');
        });
        await check('maker page renders the touch canvas, uploads, editor controls, and signed-out AI helper', async () => {
            const page = await t.get('/make');
            assert.strictEqual(page.status, 200);
            for (const text of ['data-stage', 'data-template-upload', 'font_style', 'data-add-sticker', 'data-caption-ideas']) assert.ok(page.text.includes(text), text);
            assert.ok(page.text.includes('/shared/ov-upload.js') && page.text.includes('/shared/ov-upload.css'), 'the maker loads the shared upload kit');
            assert.ok(!page.text.includes('type="file"'), 'no hand-rolled file input remains');
        });
        await check('custom editor geometry and stickers render, and saved captions retain editable state', async () => {
            const editor = { boxes: [{ x: 5, y: 7, w: 90, h: 24 }, { x: 5, y: 68, w: 90, h: 24 }, { x: 5, y: 38, w: 90, h: 18 }, { x: 5, y: 44, w: 90, h: 18 }], stickers: [{ emoji: '🔥', x: 52, y: 54 }], font_style: 'impact', font_size: 30, color: '#ffffff', outline: '#000000', outline_width: 3 };
            const request = { template_id: 'tpl_classic', lines: ['first caption', 'second caption'], editor };
            assert.strictEqual(contracts.validate('meme.render@1', request).valid, true);
            assert.strictEqual(contracts.validate('meme.render@1', { ...request, lines: ['1', '2', '3', '4', '5'] }).valid, false);
            assert.strictEqual(contracts.validate('meme.render@1', { ...request, format: 'webp' }).valid, false);
            const rendered = await t.get('/api/v1/render', { as: alice, json: request });
            assert.strictEqual(rendered.status, 200, rendered.text);
            assert.strictEqual(rendered.headers.get('content-type'), 'image/png');
            const styleOnly = await t.get('/api/v1/render', { as: alice, json: { template_id: 'tpl_classic', lines: ['style only'], editor: { font_style: 'modern', crop_x: 40, crop_y: 60 } } });
            assert.strictEqual(styleOnly.status, 200, styleOnly.text);
            const saved = await t.get('/api/v1/captions', { as: alice, json: { template_id: 'tpl_classic', lines: ['editable', 'later'], editor } });
            assert.strictEqual(saved.status, 201, saved.text);
            assert.deepStrictEqual(saved.json().editor, editor);
            const savedRender = await t.get(`/api/v1/captions/${saved.json().id}/render?format=png`);
            assert.strictEqual(savedRender.status, 200);
            const plain = await t.get('/api/v1/captions', { as: alice, json: { template_id: 'tpl_classic', lines: ['no editor'] } });
            assert.strictEqual(plain.status, 201, plain.text);
            const plainRender = await t.get(`/api/v1/captions/${plain.json().id}/render`);
            assert.strictEqual(plainRender.status, 200, plainRender.text);
            assert.strictEqual(savedRender.headers.get('content-type'), 'image/png');
            for (const [format, type] of [['gif', 'image/gif'], ['mp4', 'video/mp4']]) {
                const animation = await t.get(`/api/v1/captions/${saved.json().id}/render?format=${format}`);
                assert.strictEqual(animation.status, 200, animation.text);
                assert.strictEqual(animation.headers.get('content-type'), type);
                assert.ok(animation.buffer.length > 100);
            }
        });
        await check('home highlights the maker and daily template signals', async () => {
            const home = await t.get('/');
            assert.strictEqual(home.status, 200);
            assert.ok(home.text.includes('Templates to try today'));
            assert.ok(home.text.includes('Make a meme'));
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
