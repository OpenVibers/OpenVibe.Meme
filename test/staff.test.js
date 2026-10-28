'use strict';
/**
 * Staff: publishing a hidden candidate needs Network role global_mod or above; an entry whose origin is gone is
 * refused; PATCH changes title/kind/status and records the status event; hide tombstones the Search document.
 * Reports are stored for any signed-in person and read only by staff.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const kim = t.network.addUser('kim');
        const mod = t.network.addUser('mod', { role: 'global_mod' });
        const admin = t.network.addUser('admin', { role: 'admin' });
        const now = new Date().toISOString();
        const mk = (slug, opts = {}) => t.ctx.entries.createCandidate({
            slug, title: opts.title || 'A candidate', kind: 'joke', summary: 'A candidate.', status: 'rising',
            first_seen_at: now, last_seen_at: now, visibility: opts.visibility || 'hidden',
            citations: [{
                role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: String(opts.msg || Math.floor(Math.random() * 1e9)),
                chat_message_id: 1, quote_text: 'a repeated phrase here', url: `${t.upstreams.url}/`, observed_at: now,
                source_status: opts.source_status || 'live',
            }],
        });
        const a = await mk('staff-publish', { title: 'Staff publish' });
        const gone = await mk('gone-origin', { source_status: 'gone' });

        await check('publish is 403 for a person and 403 for a streamer, 200 for global_mod and admin', async () => {
            const streamer = t.network.addUser('streamer', { role: 'streamer' });
            const no = await t.get('/api/v1/entries/staff-publish/publish', { as: kim, method: 'POST' });
            assert.strictEqual(no.status, 403);
            assert.strictEqual(no.json().code, 'meme.staff_required');
            assert.strictEqual((await t.get('/api/v1/entries/staff-publish/publish', { as: streamer, method: 'POST' })).status, 403);
            const yes = await t.get('/api/v1/entries/staff-publish/publish', { as: mod, method: 'POST' });
            assert.strictEqual(yes.status, 200, yes.text);
            assert.strictEqual(yes.json().visibility, 'public');
            assert.strictEqual(yes.json().revision, 2);
            assert.strictEqual((await t.get('/api/v1/entries/staff-publish')).status, 200);
            assert.strictEqual((await t.get('/api/v1/entries/gone-origin/publish', { as: admin, method: 'POST' })).status, 409);
        });

        await check('PATCH changes the fields and records a status event', async () => {
            const r = await t.get('/api/v1/entries/staff-publish', { as: mod, method: 'PATCH', json: { title: 'Renamed', kind: 'bit', status: 'peaked', reason: 'people still say it' } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().title, 'Renamed');
            assert.strictEqual(r.json().kind, 'bit');
            assert.strictEqual(r.json().status, 'peaked');
            assert.strictEqual(r.json().revision, 3);
            const events = await t.ctx.s.db.many('SELECT from_status, to_status, reason, changed_by FROM meme_status_events WHERE entry_id = $1', [a.entry.id]);
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].from_status, 'rising');
            assert.strictEqual(events[0].to_status, 'peaked');
            assert.strictEqual(events[0].reason, 'people still say it');
            assert.strictEqual(events[0].changed_by, mod.subject);
        });

        await check('PATCH refuses an unknown field and a bad kind', async () => {
            const unknown = await t.get('/api/v1/entries/staff-publish', { as: mod, method: 'PATCH', json: { slug: 'other' } });
            assert.strictEqual(unknown.status, 400);
            assert.strictEqual(unknown.json().code, 'meme.invalid');
            assert.strictEqual((await t.get('/api/v1/entries/staff-publish', { as: mod, method: 'PATCH', json: { kind: 'not-a-kind' } })).status, 400);
        });

        await check('hide makes it private and queues a tombstone', async () => {
            const r = await t.get('/api/v1/entries/staff-publish/hide', { as: mod, method: 'POST' });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.json().visibility, 'hidden');
            assert.strictEqual((await t.get('/api/v1/entries/staff-publish')).status, 404);
            assert.strictEqual((await t.get('/api/v1/entries/staff-publish', { as: mod })).status, 200);
            const docs = await t.ctx.s.db.many('SELECT payload FROM meme_outbox ORDER BY created_at');
            assert.strictEqual(docs[docs.length - 1].payload.deleted, true);
        });

        await check('a report is stored for a signed-in person and listed only for staff', async () => {
            const rep = await mk('reportable', { title: 'Reportable' });
            assert.strictEqual((await t.get('/api/v1/entries/reportable/publish', { as: mod, method: 'POST' })).status, 200);
            const r = await t.get('/api/v1/entries/reportable/report', { as: kim, json: { kind: 'correction', reason: 'The quote is from another stream', note: 'please check 6025' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual((await t.get('/api/v1/reports', { as: kim })).status, 403);
            assert.strictEqual((await t.get('/api/v1/reports', { as: mod })).status, 200);
            const list = (await t.get('/api/v1/reports', { as: mod })).json();
            assert.strictEqual(list.count, 1);
            assert.strictEqual(list.reports[0].kind, 'correction');
            assert.strictEqual(list.reports[0].entry_slug, 'reportable');
        });
    } finally {
        await t.close();
    }
    done();
})();
