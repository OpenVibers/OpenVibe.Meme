'use strict';
/** The agent layer: the manifest and the Markdown twins of the public pages, rendered through the same views. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('manifest is JSON with only the endpoints Meme really serves', async () => {
            const r = await t.get('/.well-known/agent.json');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /application\/json/);
            const m = r.json();
            assert.strictEqual(m.id, 'meme');
            assert.strictEqual(m.home, 'https://openvibe.meme');
            assert.strictEqual(m.api, 'https://openvibe.meme/api/v1');
            assert.strictEqual(m.docs, 'https://openvibe.meme/developers');
            assert.deepStrictEqual(m.policy.auth, ['none', 'Network OIDC']);
            assert.strictEqual(m.openapi, undefined);
            assert.strictEqual(m.mcp, undefined);
        });

        await check('the home names its twin in the head and the Link header', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('<link rel="alternate" type="text/markdown" href="https://openvibe.meme/index.md">'));
            assert.match(r.headers.get('link'), /https:\/\/openvibe\.meme\/index\.md>; rel="alternate"; type="text\/markdown"/);
        });

        await check('/index.md and content twins are Markdown of the same pages; unknown twins are 404', async () => {
            const home = await t.get('/index.md');
            assert.strictEqual(home.status, 200);
            assert.match(home.headers.get('content-type'), /text\/markdown/);
            assert.ok(home.text.startsWith('---\ntitle:'));
            for (const [path, heading] of [['/developers.md', '# The OpenVibe.Meme API'], ['/week.md', '# Meme of the week'], ['/make.md', '# Make a caption']]) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, path);
                assert.ok(r.text.includes(heading), `${path} missing ${heading}`);
            }
            assert.strictEqual((await t.get('/no-such-page.md')).status, 404);
        });

        await check('/.well-known/security.txt is not swallowed by the layer, and robots names the manifest', async () => {
            const sec = await t.get('/.well-known/security.txt');
            assert.strictEqual(sec.status, 404);
            assert.doesNotMatch(sec.headers.get('content-type') || '', /application\/json/);
            const robots = await t.get('/robots.txt');
            assert.strictEqual(robots.status, 200);
            assert.ok(robots.text.includes('# Agent manifest: https://openvibe.meme/.well-known/agent.json'));
        });
    } finally {
        await t.close();
        done();
    }
})();
