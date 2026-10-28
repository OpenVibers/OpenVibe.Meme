'use strict';
/**
 * Citation re-verification: a URL that now answers 404 marks the citation gone and, when it is the origin, hides
 * the entry (revision +1, Search tombstone). A transient 500 must leave the citation alone. A Chat line is checked
 * against the public history page, because v1 has no per-message permalink.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const now = new Date().toISOString();
        const entry = await t.ctx.entries.createCandidate({
            slug: 'vod-origin', title: 'VOD origin', kind: 'meme', summary: 'A proof.', status: 'rising',
            first_seen_at: '2026-10-21T12:00:00Z', last_seen_at: now, visibility: 'public',
            citations: [{ role: 'origin', source_service: 'live', source_type: 'vod', source_id: '9002', vod_id: 9002, offset_seconds: 120, quote_text: 'the robot is offline for good', url: `${t.upstreams.url}/v/9002?t=120`, observed_at: '2026-10-21T12:00:00Z' }],
        });

        await check('a 404 marks the citation gone and hides the entry whose origin it is', async () => {
            t.upstreams.setVideo(9002, { status: 404 });
            const r = await t.ctx.reverifier.runOnce();
            assert.strictEqual(r.checked, 1);
            assert.strictEqual(r.gone, 1);
            assert.strictEqual(r.entries_hidden, 1);
            const c = await t.ctx.s.db.maybe('SELECT * FROM meme_citations WHERE entry_id = $1', [entry.entry.id]);
            assert.strictEqual(c.source_status, 'gone');
            const e = await t.ctx.s.db.maybe('SELECT * FROM meme_entries WHERE id = $1', [entry.entry.id]);
            assert.strictEqual(e.visibility, 'hidden');
            assert.strictEqual(Number(e.revision), 2);
            const doc = await t.ctx.s.db.maybe('SELECT payload FROM meme_outbox ORDER BY created_at DESC LIMIT 1');
            assert.strictEqual(doc.payload.deleted, true);
            assert.strictEqual((await t.get('/api/v1/entries/vod-origin')).status, 404);
        });

        await check('a gone use (not the origin) keeps the entry public and re-indexes it', async () => {
            const e4 = await t.ctx.entries.createCandidate({
                slug: 'use-gone', title: 'Use gone', kind: 'meme', summary: 'A proof.', status: 'rising',
                first_seen_at: '2026-10-20T10:00:00Z', last_seen_at: now, visibility: 'public',
                citations: [
                    { role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: '1001', chat_message_id: 1001, quote_text: 'the robot is offline again', url: `${t.upstreams.url}/`, observed_at: '2026-10-20T10:00:00Z' },
                    { role: 'use', source_service: 'live', source_type: 'vod', source_id: '9002', vod_id: 9002, offset_seconds: 120, quote_text: 'the robot is offline for good', url: `${t.upstreams.url}/v/9002?t=120`, observed_at: now },
                ],
            });
            const r = await t.ctx.reverifier.runOnce();
            assert.strictEqual(r.entries_hidden, 0);
            const e = await t.ctx.s.db.maybe('SELECT * FROM meme_entries WHERE id = $1', [e4.entry.id]);
            assert.strictEqual(e.visibility, 'public');
            assert.strictEqual(Number(e.revision), 2);
            const ups = await t.ctx.s.db.many("SELECT payload FROM meme_outbox WHERE topic = 'meme.index_document.upserted' ORDER BY created_at DESC LIMIT 1");
            assert.ok(ups.length);
            assert.strictEqual(ups[0].payload.revision, 2);
            assert.strictEqual(ups[0].payload.deleted, false);
        });

        await check('a transient 500 leaves the citation and the entry as they were', async () => {
            const e2 = await t.ctx.entries.createCandidate({
                slug: 'transient', title: 'Transient', kind: 'meme', summary: 'A proof.', status: 'rising',
                first_seen_at: now, last_seen_at: now, visibility: 'public',
                citations: [{ role: 'origin', source_service: 'live', source_type: 'vod', source_id: '6025', vod_id: 6025, offset_seconds: 1541, quote_text: 'Cosmo requires Wi-Fi.', url: `${t.upstreams.url}/v/6025?t=1541`, observed_at: now }],
            });
            t.upstreams.setVideo(6025, { status: 500 });
            const r = await t.ctx.reverifier.runOnce();
            assert.ok(r.errors.length >= 1);
            const c = await t.ctx.s.db.maybe('SELECT * FROM meme_citations WHERE entry_id = $1', [e2.entry.id]);
            assert.strictEqual(c.source_status, 'live');
            const row = await t.ctx.s.db.maybe('SELECT * FROM meme_entries WHERE id = $1', [e2.entry.id]);
            assert.strictEqual(row.visibility, 'public');
        });

        await check('a Chat line that is no longer in public history is marked gone', async () => {
            const e3 = await t.ctx.entries.createCandidate({
                slug: 'chat-origin', title: 'Chat origin', kind: 'joke', summary: 'A proof.', status: 'rising',
                first_seen_at: now, last_seen_at: now, visibility: 'public',
                citations: [{ role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: '999999', chat_message_id: 999999, quote_text: 'a line that never existed', url: `${t.upstreams.url}/`, observed_at: now }],
            });
            const r = await t.ctx.reverifier.runOnce();
            assert.ok(r.errors.length >= 0);
            const c = await t.ctx.s.db.maybe('SELECT * FROM meme_citations WHERE entry_id = $1', [e3.entry.id]);
            assert.strictEqual(c.source_status, 'gone');
            assert.strictEqual((await t.ctx.s.db.maybe('SELECT visibility FROM meme_entries WHERE id = $1', [e3.entry.id])).visibility, 'hidden');
        });
    } finally {
        await t.close();
    }
    done();
})();
