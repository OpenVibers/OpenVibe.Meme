'use strict';
/**
 * The JSON API's read shapes: cursor paging, trending order, one entry with its citations and timeline, an
 * unlisted entry reachable by slug but absent from the public list, and the problem+json validation refusals.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const now = new Date().toISOString();
        const mk = (slug, title, status, visibility = 'public', first = now) => t.ctx.entries.createCandidate({
            slug, title, kind: 'joke', summary: 'A test entry.', status, first_seen_at: first, last_seen_at: now, visibility,
            citations: [{ role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: String(Math.floor(Math.random() * 1e9)), chat_message_id: 1, quote_text: 'a repeated phrase here', url: `${t.upstreams.url}/`, observed_at: now }],
        });
        await mk('m-one', 'One', 'classic', 'public', new Date(Date.now() - 5 * 86_400_000).toISOString());
        await mk('m-two', 'Two', 'rising', 'public', new Date(Date.now() - 4 * 86_400_000).toISOString());
        await mk('m-three', 'Three', 'peaked', 'public', new Date(Date.now() - 3 * 86_400_000).toISOString());
        const unlisted = await mk('m-unlisted', 'Unlisted', 'rising', 'unlisted', new Date(Date.now() - 2 * 86_400_000).toISOString());

        await check('GET /entries pages with an opaque cursor and refuses a garbage one', async () => {
            const one = await t.get('/api/v1/entries?limit=2');
            assert.strictEqual(one.status, 200);
            assert.strictEqual(one.json().count, 2);
            assert.ok(one.json().entries.every((e) => e.visibility === 'public'));
            assert.ok(one.json().next_cursor);
            const two = await t.get(`/api/v1/entries?limit=2&cursor=${encodeURIComponent(one.json().next_cursor)}`);
            assert.strictEqual(two.status, 200);
            assert.strictEqual(two.json().count, 1);
            assert.strictEqual(two.json().next_cursor, null);
            assert.strictEqual((await t.get('/api/v1/entries?cursor=garbage')).status, 400);
            assert.strictEqual((await t.get('/api/v1/entries?kind=nope')).status, 400);
        });

        await check('GET /trending puts rising first', async () => {
            const r = await t.get('/api/v1/trending');
            assert.strictEqual(r.status, 200);
            assert.ok(r.json().count >= 1);
            assert.strictEqual(r.json().entries[0].status, 'rising');
        });

        await check('one entry has its origin and the timeline; an unlisted entry is direct-only', async () => {
            const r = await t.get('/api/v1/entries/m-two');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.json().slug, 'm-two');
            assert.ok(r.json().origin);
            assert.strictEqual(r.json().origin.role, 'origin');
            assert.strictEqual(r.json().timeline.length, 1);
            assert.ok(Array.isArray(r.json().citations));
            const ul = await t.get('/api/v1/entries/m-unlisted');
            assert.strictEqual(ul.status, 200);
            assert.strictEqual(ul.headers.get('cache-control'), 'private, max-age=60');
            const listed = await t.get('/api/v1/entries?limit=50');
            assert.ok(!listed.json().entries.some((e) => e.slug === 'm-unlisted'));
            assert.strictEqual((await t.get('/api/v1/entries/m-missing')).status, 404);
        });

        await check('problem+json is used for a malformed body and an unknown route', async () => {
            const bad = await t.get('/api/v1/week/vote', { as: t.network.addUser('voter'), body: '{', headers: { 'content-type': 'application/json' } });
            assert.strictEqual(bad.status, 400);
            assert.match(bad.headers.get('content-type'), /application\/problem\+json/);
            assert.strictEqual(bad.json().code, 'request.malformed_json');
            const nope = await t.get('/api/v1/nope');
            assert.strictEqual(nope.status, 404);
            assert.strictEqual(nope.json().code, 'route.not_found');
        });
    } finally {
        await t.close();
    }
    done();
})();
