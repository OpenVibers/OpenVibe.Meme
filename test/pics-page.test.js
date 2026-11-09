'use strict';
/**
 * A Pics picture opened in the Meme maker: the page, the preview and the rendered PNG. Meme reads the picture
 * from the configured Pics origin with the visitor's own token, so a stand-in server on loopback plays Pics.
 */
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#357' } }).png().toBuffer();
    const calls = [];
    const pics = await new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            calls.push({ url: req.url, authorization: req.headers.authorization || '' });
            if (req.url === '/api/v1/images/Abcdef23') {
                res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify({ id: 'pic_01ARZ3NDEKTSV4RRFFQ69G5FAV', slug: 'Abcdef23', width: 200, height: 100, bytes: png.length, mime_type: 'image/png', listed: true, state: 'active' }));
            }
            if (req.url === '/api/v1/images/Abcdef23/bytes') {
                res.setHeader('content-type', 'image/png');
                return res.end(png);
            }
            res.statusCode = 404;
            return res.end('{}');
        });
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const t = await boot({ env: { OV_PICS_URL: `http://127.0.0.1:${pics.address().port}` } });
    const alice = t.network.addUser('alice');

    try {
        await check('the maker opens only for a signed-in person', async () => {
            const anon = await t.get('/make?picture=Abcdef23');
            assert.strictEqual(anon.status, 401);
            assert.ok(anon.text.includes('/auth/login?next='), 'the page offers the sign-in');
            const page = await t.get('/make?picture=Abcdef23', { as: alice });
            assert.strictEqual(page.status, 200, page.text.slice(0, 300));
            assert.ok(page.text.includes('src="/api/v1/pics/Abcdef23/preview"'), 'the picture is shown');
            assert.ok(page.text.includes('action="/api/v1/pics/Abcdef23/render"'), 'the form posts to the renderer');
        });

        await check('an id that is not a picture is a plain 404', async () => {
            assert.strictEqual((await t.get('/make?picture=https://evil.test', { as: alice })).status, 404);
            assert.strictEqual((await t.get('/api/v1/pics/not-a-picture/preview', { as: alice })).status, 404);
        });

        await check('the preview is the picture, read with the visitor\'s token', async () => {
            const r = await t.get('/api/v1/pics/Abcdef23/preview', { as: alice });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.strictEqual(r.headers.get('content-type'), 'image/png');
            assert.deepStrictEqual([...r.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
            const metadata = calls.find((c) => c.url === '/api/v1/images/Abcdef23');
            assert.ok(metadata.authorization.startsWith('Bearer '), 'Pics is asked with a person token');
        });

        await check('the renderer answers a PNG download and refuses an empty caption', async () => {
            const made = await t.get('/api/v1/pics/Abcdef23/render', { as: alice, form: { top: 'Hello', bottom: 'World' } });
            assert.strictEqual(made.status, 200, made.text.slice(0, 300));
            assert.strictEqual(made.headers.get('content-type'), 'image/png');
            assert.match(made.headers.get('content-disposition') || '', /attachment; filename="openvibe-meme.png"/);
            assert.deepStrictEqual([...made.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
            const empty = await t.get('/api/v1/pics/Abcdef23/render', { as: alice, form: { top: '', bottom: '' } });
            assert.strictEqual(empty.status, 400);
        });
    } finally {
        await t.close();
        await new Promise((resolve) => pics.close(resolve));
    }
    done();
})();
