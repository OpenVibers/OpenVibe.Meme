'use strict';
/**
 * The Search Fabric document: owner meme, type entry, id mem_…, canonical page /m/<slug>, title/summary/body,
 * facets kind/status/source, authorship ai_assisted, one provenance reference per citation, the entry's revision.
 * A hidden entry has no document; publish upserts; a PATCH bumps the revision; hide writes a valid tombstone.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const mod = t.network.addUser('mod', { role: 'global_mod' });
        const now = new Date().toISOString();
        const e = await t.ctx.entries.createCandidate({
            slug: 'search-proof', title: 'Robot is offline', kind: 'catchphrase', summary: 'The robot is offline, again.', status: 'rising',
            first_seen_at: '2026-10-20T10:00:00Z', last_seen_at: now, visibility: 'hidden',
            citations: [
                { role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: '1001', chat_message_id: 1001, quote_text: 'the robot is offline again', url: `${t.upstreams.url}/`, observed_at: '2026-10-20T10:00:00Z' },
                { role: 'use', source_service: 'live', source_type: 'vod', source_id: '9002', vod_id: 9002, offset_seconds: 120, quote_text: 'the robot is offline for good', url: `${t.upstreams.url}/v/9002?t=120`, observed_at: now },
            ],
        });

        await check('a hidden entry queues no Search document', async () => {
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_outbox')), 0);
        });

        await check('publish writes a valid search.index-document@1', async () => {
            assert.strictEqual((await t.get('/api/v1/entries/search-proof/publish', { as: mod, method: 'POST' })).status, 200);
            const row = await t.ctx.s.db.maybe("SELECT topic, payload FROM meme_outbox WHERE topic = 'meme.index_document.upserted' ORDER BY created_at DESC LIMIT 1");
            assert.ok(row, 'an upsert row exists');
            const doc = row.payload;
            const v = contracts.validate('search.index-document@1', doc);
            assert.strictEqual(v.valid, true, JSON.stringify(v.errors));
            assert.strictEqual(doc.owner, 'meme');
            assert.strictEqual(doc.type, 'entry');
            assert.strictEqual(doc.id, e.entry.id);
            assert.strictEqual(doc.deleted, false);
            assert.strictEqual(doc.visibility, 'public');
            assert.strictEqual(doc.publication_state, 'published');
            assert.strictEqual(doc.canonical_url, 'https://openvibe.meme/m/search-proof');
            assert.strictEqual(doc.title, 'Robot is offline');
            assert.strictEqual(doc.revision, 2);
            assert.strictEqual(doc.facets.kind, 'catchphrase');
            assert.strictEqual(doc.facets.status, 'rising');
            assert.deepStrictEqual(doc.facets.source.sort(), ['chat', 'live']);
            assert.strictEqual(doc.authorship, 'ai_assisted');
            assert.strictEqual(doc.provenance.length, 2);
            assert.strictEqual(doc.provenance[0].service, 'chat');
            assert.ok(doc.body.includes('the robot is offline again'));
        });

        await check('an edit sends the next revision; hide sends a valid tombstone', async () => {
            assert.strictEqual((await t.get('/api/v1/entries/search-proof', { as: mod, method: 'PATCH', json: { title: 'Robot is really offline' } })).status, 200);
            const ups = await t.ctx.s.db.many("SELECT payload FROM meme_outbox WHERE topic = 'meme.index_document.upserted' ORDER BY created_at");
            assert.strictEqual(ups.length, 2);
            assert.strictEqual(ups[1].payload.revision, 3);
            assert.strictEqual(ups[1].payload.title, 'Robot is really offline');
            assert.strictEqual(contracts.validate('search.index-document@1', ups[1].payload).valid, true);
            assert.strictEqual((await t.get('/api/v1/entries/search-proof/hide', { as: mod, method: 'POST' })).status, 200);
            const tomb = await t.ctx.s.db.maybe("SELECT payload FROM meme_outbox WHERE topic = 'meme.index_document.deleted' ORDER BY created_at DESC LIMIT 1");
            assert.strictEqual(contracts.validate('search.index-document@1', tomb.payload).valid, true, JSON.stringify(contracts.validate('search.index-document@1', tomb.payload).errors));
            assert.strictEqual(tomb.payload.deleted, true);
            assert.strictEqual(tomb.payload.revision, 4);
        });

        await check('the public list carries only public entries', async () => {
            const r = await t.get('/api/v1/entries');
            assert.strictEqual(r.json().count, 0);
        });
    } finally {
        await t.close();
    }
    done();
})();
