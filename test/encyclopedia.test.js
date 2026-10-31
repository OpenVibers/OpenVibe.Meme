'use strict';
/**
 * M2: the encyclopedia's entries and their wiki-style revisions, plus M1's Live filters.
 *
 *   - an internet entry carries its origin, spread, variations, Media examples, labels, related memes and an
 *     approved revision history; a public entry is one Search Fabric document with scope/labels;
 *   - a person's proposal is hidden and pending; staff review approves or rejects a revision, and only then does
 *     the entry change;
 *   - `GET /entries` filters by scope/q/status/label and sorts newest or top-this-week per channel for Live.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const MEDIA = (n) => `med_01JAB2C3D4E5F6G7H8J9K0MNP${n}`;

(async () => {
    const clock = Date.parse('2026-10-31T06:00:00Z');
    const t = await boot({ now: () => clock });
    try {
        const kim = t.network.addUser('kim');
        const mod = t.network.addUser('mod', { role: 'global_mod' });
        const iso = (ms) => new Date(ms).toISOString();

        const origin = { source: 'web', url: 'https://knowyourmeme.example/doge', title: 'Doge', publisher: 'Example', author: 'A person', published_at: '2013-02-01T00:00:00Z', quote: 'such meme' };
        const entryBody = (title, extra = {}) => ({
            title, kind: 'format', scope: 'internet', status: 'classic', summary: 'A dog and a caption.', meaning: 'A template for ironic praise.', usage: 'Caption it in broken English.',
            labels: ['language'], origin: { ...origin, title: `${title} origin` },
            spread: [{ observed_at: '2013-02-02T00:00:00Z', place: 'reddit/r/memes', url: 'https://reddit.example/1', count: 420 }],
            variations: [{ name: 'Cat doge', description: 'A cat instead', media_id: MEDIA('A') }],
            examples: [{ media_id: MEDIA('B'), caption: 'such example', source_url: 'https://reddit.example/2' }],
            ...extra,
        });

        let doge;
        await check('staff create an internet entry with origin, spread, variations, examples, labels and a revision', async () => {
            const r = await t.get('/api/v1/entries', { as: mod, json: entryBody('Doge') });
            assert.strictEqual(r.status, 201, r.text);
            doge = r.json();
            assert.strictEqual(doge.entry.scope, 'internet');
            assert.strictEqual(doge.entry.visibility, 'public');
            assert.strictEqual(doge.review, 'approved');
            assert.deepStrictEqual(doge.entry.labels, ['language']);
            const d = await t.get('/api/v1/entries/doge');
            assert.strictEqual(d.status, 200, d.text);
            const e = d.json();
            assert.strictEqual(e.web_origin.url, origin.url);
            assert.strictEqual(e.spread.length, 1);
            assert.strictEqual(e.spread[0].count, 420);
            assert.strictEqual(e.variations[0].name, 'Cat doge');
            assert.ok(e.examples.some((x) => x.media_id === MEDIA('B')));
            assert.strictEqual(e.revisions.length, 1);
            assert.strictEqual(e.revisions[0].moderation_state, 'approved');
            const doc = await t.ctx.s.db.maybe("SELECT payload FROM meme_outbox WHERE topic = 'meme.index_document.upserted' ORDER BY created_at DESC LIMIT 1");
            assert.strictEqual(contracts.validate('search.index-document@1', doc.payload).valid, true, JSON.stringify(contracts.validate('search.index-document@1', doc.payload).errors));
            assert.strictEqual(doc.payload.facets.scope, 'internet');
            assert.deepStrictEqual(doc.payload.facets.labels, ['language']);
            assert.strictEqual(doc.payload.authorship, 'human');
        });

        await check('a person proposes a second entry: hidden, pending, visible to its author and staff only', async () => {
            const r = await t.get('/api/v1/entries', { as: kim, json: entryBody('Cheems', { labels: ['nudity', '18+'] }) });
            assert.strictEqual(r.status, 202, r.text);
            assert.strictEqual(r.json().entry.visibility, 'hidden');
            assert.strictEqual(r.json().review, 'pending');
            assert.strictEqual(r.json().entry.submitted_by, kim.subject);
            assert.strictEqual((await t.get('/api/v1/entries/cheems')).status, 404);
            assert.strictEqual((await t.get('/api/v1/entries/cheems', { as: kim })).status, 200);
            assert.strictEqual((await t.get('/api/v1/entries/cheems', { as: mod })).status, 200);
            assert.strictEqual((await t.get('/api/v1/entries?scope=internet')).json().count, 1);
        });

        await check('an edit is pending until a reviewer approves it, then the entry and Search document change', async () => {
            const before = (await t.get('/api/v1/entries/doge', { as: mod })).json();
            const p = await t.get('/api/v1/entries/doge/revisions', { as: kim, json: { title: 'Doge (classic)', meaning: 'The original ironic praise format.' } });
            assert.strictEqual(p.status, 202, p.text);
            const rev = p.json().revision;
            assert.strictEqual(rev.moderation_state, 'pending');
            assert.ok(rev.diff.some((d) => d.field === 'title'));
            assert.strictEqual((await t.get('/api/v1/entries/doge')).json().title, 'Doge');
            const queue = (await t.get('/api/v1/moderation/revisions', { as: mod })).json();
            assert.ok(queue.revisions.some((r) => r.entry_slug === 'doge' && r.revision === rev.revision));
            const ok = await t.get(`/api/v1/entries/doge/revisions/${rev.revision}/review`, { as: mod, json: { state: 'approved', note: 'fine' } });
            assert.strictEqual(ok.status, 200, ok.text);
            assert.strictEqual(ok.json().revision.moderation_state, 'approved');
            assert.strictEqual(ok.json().entry.title, 'Doge (classic)');
            assert.strictEqual(ok.json().entry.revision, before.revision + 1);
            assert.strictEqual((await t.get('/api/v1/entries/doge')).json().title, 'Doge (classic)');
            const pub = (await t.get('/api/v1/entries/doge/revisions')).json();
            assert.strictEqual(pub.revisions[0].revision, rev.revision);
            assert.strictEqual(pub.revisions[0].moderation_state, 'approved');
        });

        await check('a rejected revision leaves the entry alone', async () => {
            const p = await t.get('/api/v1/entries/doge/revisions', { as: kim, json: { status: 'dead' } });
            assert.strictEqual(p.status, 202);
            const rev = p.json().revision;
            const no = await t.get(`/api/v1/entries/doge/revisions/${rev.revision}/review`, { as: mod, json: { state: 'rejected', note: 'not dead' } });
            assert.strictEqual(no.status, 200, no.text);
            assert.strictEqual((await t.get('/api/v1/entries/doge')).json().status, 'classic');
            assert.strictEqual((await t.get(`/api/v1/entries/doge/revisions/${rev.revision}/review`, { as: mod, json: { state: 'approved' } })).status, 409);
        });

        await check('the list filters by scope, q, label and status; a bad label is a 400', async () => {
            const byScope = (await t.get('/api/v1/entries?scope=internet')).json();
            assert.strictEqual(byScope.count, 1);
            assert.strictEqual(byScope.entries[0].slug, 'doge');
            assert.strictEqual((await t.get('/api/v1/entries?scope=openvibe')).json().count, 0);
            assert.strictEqual((await t.get('/api/v1/entries?q=ironic')).json().count, 1);
            assert.strictEqual((await t.get('/api/v1/entries?q=nothing-here')).json().count, 0);
            assert.strictEqual((await t.get('/api/v1/entries?label=language')).json().count, 1);
            assert.strictEqual((await t.get('/api/v1/entries?label=nudity')).json().count, 0);
            assert.strictEqual((await t.get('/api/v1/entries?status=dead')).json().count, 0);
            assert.strictEqual((await t.get('/api/v1/entries?label=not-a-label')).status, 400);
            assert.strictEqual((await t.get('/api/v1/entries?scope=elsewhere')).status, 400);
        });

        await check('related memes come back by slug, and an unknown slug or Media id is refused', async () => {
            const second = await t.get('/api/v1/entries', { as: mod, json: entryBody('Chet', { related: ['doge'], scope: 'internet' }) });
            assert.strictEqual(second.status, 201, second.text);
            const d = (await t.get('/api/v1/entries/chet')).json();
            assert.strictEqual(d.related[0].slug, 'doge');
            assert.strictEqual((await t.get('/api/v1/entries', { as: mod, json: entryBody('Bad', { related: ['no-such'] }) })).status, 400);
            const bad = await t.get('/api/v1/entries', { as: mod, json: entryBody('Bad too', { examples: [{ media_id: 'nope' }] }) });
            assert.strictEqual(bad.status, 400);
            assert.strictEqual((await t.get('/api/v1/entries', { as: mod, json: entryBody('Bad label', { labels: ['looks'] }) })).status, 400);
            assert.strictEqual((await t.get('/api/v1/entries', { as: mod, json: entryBody('Bad cite', { citations: [{ role: 'origin' }] }) })).status, 400);
        });

        await check('M1: scope=openvibe with sort=top, window=week and channel= is Live’s page', async () => {
            const old = iso(clock - 10 * 86_400_000);
            const fresh = iso(clock - 86_400_000);
            const mk = (slug, first, stream, observed) => t.ctx.entries.createCandidate({
                slug, title: slug, kind: 'joke', status: 'rising', first_seen_at: first, last_seen_at: first, visibility: 'public',
                citations: [{ role: 'origin', source_service: 'live', source_type: 'vod', source_id: String(Math.random()), vod_id: 9002, stream_id: stream, offset_seconds: 1, quote_text: `quote ${slug}`, url: `${t.upstreams.url}/v/9002?t=1`, observed_at: observed }],
            });
            await mk('live-old', old, 7001, old);
            await mk('live-hot-a', fresh, 7001, iso(clock - 2 * 86_400_000));
            await mk('live-hot-b', fresh, 7002, iso(clock - 3 * 86_400_000));
            // A second live use this week makes live-hot-a the top of channel 7001.
            const hot = await t.ctx.entries.bySlug('live-hot-a');
            await t.ctx.entries.addCitations(hot.id, [{ role: 'use', source_service: 'live', source_type: 'rundown_segment', source_id: 'x1', stream_id: 7001, quote_text: 'again', url: `${t.upstreams.url}/v/9002?t=2`, observed_at: iso(clock - 86_400_000) }]);
            const allR = await t.get('/api/v1/entries?scope=openvibe&sort=top&window=week');
            const all = allR.json();
            assert.strictEqual(all.entries[0].slug, 'live-hot-a');
            assert.strictEqual(all.entries[0].uses, 2);
            const only = (await t.get('/api/v1/entries?scope=openvibe&sort=top&window=week&channel=7001')).json();
            assert.deepStrictEqual(only.entries.map((e) => e.slug).sort(), ['live-hot-a', 'live-old']);
            const newest = (await t.get('/api/v1/entries?scope=openvibe&sort=newest&limit=50')).json();
            assert.ok(newest.entries.some((e) => e.slug === 'live-hot-a'));
            assert.strictEqual((await t.get('/api/v1/entries?channel=nope')).status, 400);
            assert.strictEqual((await t.get('/api/v1/entries?sort=sideways')).status, 400);
        });
    } finally {
        await t.close();
    }
    done();
})();
