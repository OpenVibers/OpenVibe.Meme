'use strict';
/**
 * Server-rendered pages: the home (trending, the week teaser, the generator teaser), one entry with its origin
 * citation and timeline, the ballot, the generator's preview and save, one saved caption, developers, 404, the
 * cache headers, and the content-hashed assets. Public pages are public, max-age=60; a page for a signed-in person
 * is private, no-store.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { assetVersion } = require('../server/render/layout');

function jsonLd(html) {
    return [...String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

(async () => {
    const t = await boot();
    const alice = t.network.addUser('alice');
    const mod = t.network.addUser('mod', { role: 'global_mod' });
    const now = new Date().toISOString();
    const publicEntry = await t.ctx.entries.createCandidate({
        slug: 'robot-is-offline', title: 'Robot is offline', kind: 'catchphrase', summary: 'The robot is offline, again.', status: 'rising',
        first_seen_at: '2026-10-20T10:00:00Z', last_seen_at: now, visibility: 'public',
        citations: [
            { role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: '1001', chat_message_id: 1001, quote_text: 'the robot is offline again', url: `${t.upstreams.url}/`, observed_at: '2026-10-20T10:00:00Z' },
            { role: 'use', source_service: 'live', source_type: 'vod', source_id: '9002', vod_id: 9002, offset_seconds: 120, quote_text: 'the robot is offline for good', url: `${t.upstreams.url}/v/9002?t=120`, observed_at: now },
        ],
    });
    const describedEntry = await t.ctx.entries.createCandidate({
        slug: 'cat-typing', title: 'Cat typing', kind: 'meme', status: 'rising',
        summary: 'A cat at a keyboard, typed as though the cat is answering a work email one slow paw at a time.',
        first_seen_at: now, last_seen_at: now, visibility: 'public', citations: [],
    });
    const hiddenEntry = await t.ctx.entries.createCandidate({
        slug: 'not-yet', title: 'Not yet', kind: 'joke', summary: 'Hidden.', status: 'rising',
        first_seen_at: now, last_seen_at: now, visibility: 'hidden',
        citations: [{ role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: '1002', chat_message_id: 1002, quote_text: 'still the robot is offline, huh', url: `${t.upstreams.url}/`, observed_at: now }],
    });
    const tpl = (await t.get('/api/v1/templates')).json().templates[0];

    try {
        await check('home: semantic, the entry, the week teaser, public cache with Vary: Cookie', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
            assert.strictEqual(r.headers.get('vary'), 'Cookie');
            for (const marker of ['id="mm-home"', 'id="mm-trending"', 'id="mm-week-teaser"', 'class="sc-room-scenes"', '<noscript><nav', '<footer id="ov-footer"', '<main id="main"', 'Robot is offline', '/make']) assert.ok(r.text.includes(marker), marker);
            const types = jsonLd(r.text).map((x) => x['@type']);
            assert.ok(types.includes('WebSite'), types.join(','));
            assert.ok(types.includes('WebApplication'), types.join(','));
        });

        await check('a page drawn for a signed-in person is private, no-store', async () => {
            const r = await t.get('/', { as: alice });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
            assert.strictEqual(r.headers.get('vary'), 'Cookie');
        });

        await check('one entry page carries the origin link, the timeline and the examples section', async () => {
            const r = await t.get('/m/robot-is-offline');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=60');
            assert.ok(r.text.includes('id="mm-entry"'));
            assert.ok(r.text.includes('id="mm-origin"'));
            assert.ok(r.text.includes('id="mm-timeline"'));
            assert.ok(r.text.includes('id="mm-examples"'));
            assert.ok(r.text.includes('the robot is offline again'));
            assert.ok(r.text.includes('the robot is offline for good'));
            assert.ok(r.text.includes('/v/9002?t=120'));
        });

        await check('one entry page describes itself for search and share cards', async () => {
            const fallback = await t.get('/m/robot-is-offline');
            assert.ok(fallback.text.includes('<meta name="description" content="Robot is offline: where the joke started, how it spread, and every use on OpenVibe.">'), 'the fallback line');
            const own = await t.get('/m/cat-typing');
            assert.ok(own.text.includes('<meta name="description" content="A cat at a keyboard, typed as though the cat is answering a work email one slow paw at a time.">'), 'the entry\'s own summary');
        });

        await check('a hidden entry is 404 to the public and visible to staff', async () => {
            assert.strictEqual((await t.get('/m/not-yet')).status, 404);
            assert.strictEqual((await t.get('/m/not-yet', { as: alice })).status, 404);
            const r = await t.get('/m/not-yet', { as: mod });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('staff view'));
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        });

        await check('the series API returns one zero-filled bucket per day', async () => {
            const r = await t.get('/api/v1/entries/robot-is-offline/series?days=3');
            assert.strictEqual(r.status, 200);
            const b = r.json();
            assert.strictEqual(b.days, 3);
            assert.strictEqual(b.series.length, 3);
            assert.ok(b.series.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.day) && Number.isInteger(x.uses)));
            assert.strictEqual((await t.get('/api/v1/entries/robot-is-offline/series?days=0')).status, 400);
        });

        await check('/week has the ballot and the plain POST form', async () => {
            const r = await t.get('/week');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('id="mm-week"'));
            assert.ok(r.text.includes('Robot is offline'));
            const signed = await t.get('/week', { as: alice });
            assert.strictEqual(signed.status, 200);
            assert.strictEqual(signed.headers.get('cache-control'), 'private, no-store');
            assert.ok(signed.text.includes('action="/week/vote"'));
            assert.ok(signed.text.includes('name="entry_id"'));
            const vote = await t.get('/week/vote', { as: alice, form: { entry_id: publicEntry.entry.id } });
            assert.strictEqual(vote.status, 303);
            assert.strictEqual(vote.headers.get('location'), '/week?voted=1');
            const cross = await t.get('/week/vote', { as: alice, form: { entry_id: publicEntry.entry.id }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403);
        });

        await check('/make previews over the image and saves a caption, public cache', async () => {
            const form = await t.get('/make');
            assert.strictEqual(form.status, 200);
            assert.strictEqual(form.headers.get('cache-control'), 'public, max-age=60');
            assert.ok(form.text.includes('id="mm-make"'));
            assert.ok(form.text.includes('id="mm-caption-form"'));
            assert.ok(form.text.includes(`/img/template-`));
            const preview = await t.get(`/make?template_id=${tpl.id}&line1=when%20the%20robot&line2=is%20offline`);
            assert.strictEqual(preview.status, 200);
            assert.ok(preview.text.includes('id="mm-preview"'));
            assert.ok(preview.text.includes('mm-caption-card'));
            assert.ok(preview.text.includes('when the robot'));
            const saved = await t.get('/make', { as: alice, form: { template_id: tpl.id, line1: 'when the robot', line2: 'is offline', visibility: 'public' } });
            assert.strictEqual(saved.status, 303);
            assert.match(saved.headers.get('location'), /^\/c\/mcp_/);
            const cross = await t.get('/make', { as: alice, form: { template_id: tpl.id, line1: 'cross' }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403);
            const bad = await t.get('/make', { as: alice, form: { template_id: tpl.id, line1: '' } });
            assert.strictEqual(bad.status, 400);
            assert.ok(bad.text.includes('id="mm-caption-form"'));
        });

        await check('/c/:id shows text over the template and respects a hidden caption', async () => {
            const cap = (await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['the caption', 'on the page'] } })).json();
            const r = await t.get(`/c/${cap.id}`);
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('id="mm-caption"'));
            assert.ok(r.text.includes('mm-caption-card'));
            assert.ok(r.text.includes('the caption'));
            assert.ok(r.text.includes('on the page'));
            const hidden = (await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['hidden one'], visibility: 'hidden' } })).json();
            assert.strictEqual((await t.get(`/c/${hidden.id}`)).status, 404);
            assert.strictEqual((await t.get(`/c/${hidden.id}`, { as: alice })).status, 200);
        });

        await check('/developers, the 404 and the report form', async () => {
            const dev = await t.get('/developers');
            assert.strictEqual(dev.status, 200);
            assert.strictEqual(dev.headers.get('cache-control'), 'public, max-age=60');
            assert.ok(dev.text.includes('id="mm-developers"'));
            assert.ok(dev.text.includes('/api/v1/entries'));
            const nf = await t.get('/no/such/page');
            assert.strictEqual(nf.status, 404);
            assert.match(nf.headers.get('content-type'), /^text\/html/);
            assert.ok(nf.text.includes('id="mm-not-found"'));
            const report = await t.get('/m/robot-is-offline/report', { as: alice, form: { kind: 'takedown', reason: 'A source is gone' } });
            assert.strictEqual(report.status, 303);
            assert.strictEqual(report.headers.get('location'), '/m/robot-is-offline?reported=1');
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_reports')), 1);
        });

        await check('assets are content-hashed; robots and sitemap list the public pages', async () => {
            const v = assetVersion('css/meme.css');
            const hashed = await t.get(`/css/meme.css?v=${v}`);
            assert.strictEqual(hashed.status, 200);
            assert.strictEqual(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
            const wrong = await t.get('/css/meme.css?v=deadbeefdeadbeef');
            assert.strictEqual(wrong.status, 200);
            assert.strictEqual(wrong.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
            const js = await t.get('/js/meme.js');
            assert.strictEqual(js.status, 200);
            assert.match(js.headers.get('content-type'), /javascript/);
            const robots = await t.get('/robots.txt');
            assert.match(robots.text, /Disallow: \/api\//);
            const map = await t.get('/sitemap.xml');
            assert.strictEqual(map.status, 200);
            assert.ok(map.text.includes('https://openvibe.meme/m/robot-is-offline'));
            const llms = await t.get('/llms.txt');
            assert.strictEqual(llms.status, 200);
            assert.ok(llms.text.includes('OpenVibe.Meme'));
        });
    } finally {
        await t.close();
    }
    done();
})();
