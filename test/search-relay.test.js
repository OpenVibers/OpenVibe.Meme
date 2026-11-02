'use strict';
/**
 * The queued Search documents reach OpenVibe.Search (server/app.js, openvibe-publishing/search-relay): with
 * MEME_SEARCH_URL set, publishing an entry PUTs its document to Search's owner API with a service token for
 * openvibe.search, and hiding it DELETEs it at the next revision; a delivered row leaves the queue. Without the URL
 * the relay is off and the rows wait.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

function fakeSearch() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: body ? JSON.parse(body) : null });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ outcome: 'applied' }));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) })));
}

async function makeEntry(t, slug) {
    return t.ctx.entries.createCandidate({
        slug, title: 'Robot is offline', kind: 'catchphrase', summary: 'The robot is offline, again.', status: 'rising',
        first_seen_at: '2026-10-20T10:00:00Z', last_seen_at: new Date().toISOString(), visibility: 'hidden',
        citations: [{ role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: '1001', chat_message_id: 1001, quote_text: 'the robot is offline again', url: `${t.upstreams.url}/`, observed_at: '2026-10-20T10:00:00Z' }],
    });
}

(async () => {
    const search = await fakeSearch();
    const t = await boot({ env: { MEME_SEARCH_URL: search.url } });
    try {
        const mod = t.network.addUser('mod', { role: 'global_mod' });
        await makeEntry(t, 'relay-proof');
        const e = await t.ctx.s.db.maybe("SELECT id FROM meme_entries WHERE slug = 'relay-proof'");

        await check('publishing an entry PUTs its document to Search with a service token, and the row leaves the queue', async () => {
            assert.strictEqual(t.ctx.searchRelay.enabled, true);
            assert.strictEqual((await t.get('/api/v1/entries/relay-proof/publish', { as: mod, method: 'POST' })).status, 200);
            const out = await t.ctx.searchRelay.drain();
            assert.ok(out.sent >= 1, JSON.stringify(out));
            const put = search.calls.find((c) => c.method === 'PUT');
            assert.ok(put, 'a PUT');
            assert.strictEqual(put.url, `/api/v1/documents/meme/entry/${e.id}`);
            assert.match(put.auth, /^Bearer \S+/);
            assert.strictEqual(put.body.canonical_url, 'https://openvibe.meme/m/relay-proof');
            assert.strictEqual(put.body.title, 'Robot is offline');
            assert.strictEqual((await t.ctx.searchRelay.status()).pending, 0);
        });

        await check('hiding it DELETEs the document at the next revision', async () => {
            const before = search.calls.length;
            assert.strictEqual((await t.get('/api/v1/entries/relay-proof/hide', { as: mod, method: 'POST' })).status, 200);
            await t.ctx.searchRelay.drain();
            const del = search.calls.slice(before).find((c) => c.method === 'DELETE');
            assert.ok(del, 'a DELETE');
            assert.match(del.url, new RegExp(`^/api/v1/documents/meme/entry/${e.id}\\?revision=\\d+$`));
        });
    } finally {
        await t.close();
        await search.close();
    }

    const off = await boot();
    try {
        await check('without MEME_SEARCH_URL the relay is off', async () => {
            assert.strictEqual(off.ctx.searchRelay.enabled, false);
            assert.strictEqual(await off.ctx.searchRelay.drain(), null);
        });
    } finally {
        await off.close();
        done();
    }
})();
