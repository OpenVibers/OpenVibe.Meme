'use strict';
/**
 * M4: analyse one meme through OpenVibe.AI's vision and structured calls.
 *
 * The test runs a local AI (the run API) and a local Reddit (official API), so the real runner, budget and
 * Reddit reader are exercised. An image URL, a Media id and a Reddit post all return the template, the matched
 * entries, origin guesses with confidence, meaning/usage, L1 labels, and — for Reddit — the spread and comments tone.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                Promise.resolve(handler(req, raw, json)).catch((err) => json(500, { error: String(err && err.message) }));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({
            server, url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}

const EXTRACT = {
    template: { name: 'Classic two-line', known: true, closest_entry: 'classic-two-line' },
    meaning: 'A caption over a familiar picture that makes a small everyday absurdity explicit.',
    usage: 'Two short lines, the setup above and the punchline below.',
    labels: ['language', '18+'],
    origins: [{ title: 'The first known post', url: 'https://example.com/origin', year: 2013, confidence: 0.72, why: 'The earliest post the sources name.' }],
    similar: ['A similar format'],
    comments_tone: { tone: 'ironic', summary: 'People are quoting the caption back at each other.' },
};

(async () => {
    const aiState = { requests: [], fail: null, cost: 0.01 };
    const ai = await listen(async (req, raw, json) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/runs' && req.method === 'POST') {
            assert.match(String(req.headers.authorization), /^Bearer /);
            const body = JSON.parse(raw || '{}');
            aiState.requests.push(body);
            if (aiState.fail) return json(201, { run: { id: 'run_fail', status: 'failed', workflow: body.workflow, output: null, cost_usd: 0 } });
            if (body.workflow === 'pics.describe_image') {
                return json(201, { run: { id: 'run_vision', status: 'succeeded', workflow: body.workflow, output: { alt: 'A cat looking at a plate', caption: 'A cat stares at a plate of food.', tags: ['cat', 'food'], gaps: [] }, cost_usd: aiState.cost } });
            }
            return json(201, { run: { id: 'run_extract', status: 'succeeded', workflow: body.workflow, output: { data: EXTRACT }, cost_usd: aiState.cost } });
        }
        return json(404, { error: 'not found' });
    });

    const reddit = await listen(async (req, raw, json) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/access_token' && req.method === 'POST') return json(200, { access_token: 'reddit-token', expires_in: 3600 });
        if (u.pathname.startsWith('/comments/abc123')) {
            assert.strictEqual(req.headers.authorization, 'Bearer reddit-token');
            return json(200, [
                { data: { children: [{ data: { id: 'abc123', title: 'Classic two-line but at dinner', subreddit: 'memes', score: 4200, upvote_ratio: 0.94, num_comments: 212, num_crossposts: 9, over_18: false, created_utc: 1760000000, permalink: '/r/memes/comments/abc123/classic/', url_overridden_by_dest: 'https://i.redd.it/abc.png' } }] } },
                { data: { children: [
                    { kind: 't1', data: { id: 'c1', author: 'one', score: 120, body: 'the plate is the meme' } },
                    { kind: 't1', data: { id: 'c2', author: 'two', score: 80, body: 'I say this every dinner' } },
                    { kind: 'more', data: { count: 5 } },
                ] } },
            ]);
        }
        return json(404, { error: 'not found' });
    });

    const baseEnv = {
        OV_AI_INTERNAL_URL: ai.url,
        MEME_REDDIT_CLIENT_ID: 'reddit-id', MEME_REDDIT_CLIENT_SECRET: 'reddit-secret',
        MEME_REDDIT_USER_AGENT: 'web:openvibe.meme:test (by /u/OpenVibe)',
    };
    const t = await boot({ env: baseEnv, redditRead: { tokenUrl: `${reddit.url}/api/v1/access_token`, apiBase: reddit.url } });
    const mediaId = `med_${ids.ulid()}`;
    const ana = t.network.addUser('ana');   // analysing is for a person: it spends OpenVibe.AI calls
    try {
        const now = new Date().toISOString();
        await t.ctx.entries.createCandidate({
            slug: 'classic-two-line', title: 'Classic two-line', kind: 'meme', status: 'classic', summary: 'The two-line caption format.',
            first_seen_at: now, last_seen_at: now, visibility: 'public', citations: [],
        });

        await check('an image URL returns the template, matched entries, origins, meaning, labels and vision', async () => {
            const r = await t.get('/api/v1/analyze', { as: ana, json: { url: 'https://example.com/picture.png' } });
            assert.strictEqual(r.status, 200, r.text);
            const a = r.json();
            assert.strictEqual(a.template.name, 'Classic two-line');
            assert.strictEqual(a.template.known, true);
            assert.strictEqual(a.template.template_id, 'tpl_classic');
            assert.ok(a.template.closest_entry, 'the closest entry is resolved');
            assert.strictEqual(a.template.closest_entry.slug, 'classic-two-line');
            assert.strictEqual(a.matched_entries[0].slug, 'classic-two-line');
            assert.strictEqual(a.origins[0].confidence, 0.72);
            assert.strictEqual(a.origins[0].url, 'https://example.com/origin');
            assert.strictEqual(a.meaning, EXTRACT.meaning);
            assert.strictEqual(a.usage, EXTRACT.usage);
            assert.deepStrictEqual(a.labels.sort(), ['18+', 'language']);
            assert.strictEqual(a.vision.alt, 'A cat looking at a plate');
            assert.strictEqual(a.reddit, null);
            assert.strictEqual(aiState.requests[0].workflow, 'pics.describe_image');
            assert.strictEqual(aiState.requests[0].input.image.url, 'https://example.com/picture.png');
            assert.strictEqual(aiState.requests[1].workflow, 'ai.extract');
            assert.ok(aiState.requests[1].input.text.includes('A cat stares'));
            const saved = await t.ctx.s.db.maybe('SELECT * FROM meme_analyses WHERE id = $1', [a.id]);
            assert.ok(saved);
            assert.strictEqual(saved.status, 'succeeded');
            const usage = await t.ctx.s.db.maybe("SELECT * FROM meme_ai_usage WHERE kind = 'analyze'");
            assert.strictEqual(Number(usage.calls), 2);
            assert.ok(Math.abs(Number(usage.cost_usd) - 0.02) < 0.0001);
        });

        await check('a Reddit URL adds the spread and the comments tone', async () => {
            aiState.requests.length = 0;
            const r = await t.get('/api/v1/analyze', { as: ana, json: { url: 'https://www.reddit.com/r/memes/comments/abc123/classic/' } });
            assert.strictEqual(r.status, 200, r.text);
            const a = r.json();
            assert.strictEqual(a.reddit.spread.score, 4200);
            assert.strictEqual(a.reddit.spread.comments, 212);
            assert.strictEqual(a.reddit.spread.subreddit, 'memes');
            assert.strictEqual(a.reddit.comments_tone.tone, 'ironic');
            assert.strictEqual(a.reddit.comments_sampled, 2);
            assert.ok(a.reddit.spread.permalink.endsWith('/classic/'));
            assert.ok(aiState.requests[1].input.text.includes('the plate is the meme'));
        });

        await check('a Media object id is accepted and analysed by its Media URL', async () => {
            aiState.requests.length = 0;
            const r = await t.get('/api/v1/analyze', { as: ana, json: { media_id: mediaId } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().input.media_id, mediaId);
            assert.ok(aiState.requests[0].input.image.url.endsWith(`/o/${mediaId}`));
        });

        await check('validation refuses both/neither/bad ids and a missing Reddit credential', async () => {
            assert.strictEqual((await t.get('/api/v1/analyze', { as: ana, json: {} })).status, 400);
            assert.strictEqual((await t.get('/api/v1/analyze', { as: ana, json: { url: 'https://example.com/a.png', media_id: mediaId } })).status, 400);
            assert.strictEqual((await t.get('/api/v1/analyze', { as: ana, json: { url: 'ftp://example.com/a.png' } })).status, 400);
            assert.strictEqual((await t.get('/api/v1/analyze', { as: ana, json: { media_id: 'nope' } })).status, 400);
            const t2 = await boot({ env: { ...baseEnv, MEME_REDDIT_CLIENT_ID: null, MEME_REDDIT_CLIENT_SECRET: null }, redditRead: { tokenUrl: `${reddit.url}/api/v1/access_token`, apiBase: reddit.url } });
            try {
                const no = await t2.get('/api/v1/analyze', { as: t2.network.addUser('ann'), json: { url: 'https://www.reddit.com/r/memes/comments/abc123/classic/' } });
                assert.strictEqual(no.status, 503, no.text);
                assert.strictEqual(no.json().code, 'meme.reddit_unavailable');
            } finally { await t2.close(); }
        });

        await check('signed out, or as an app, nobody analyses (it spends the day\'s AI budget)', async () => {
            const r = await t.get('/api/v1/analyze', { json: { url: 'https://example.com/a.png' } });
            assert.strictEqual(r.status, 401, r.text);
            assert.strictEqual(r.json().code, 'meme.sign_in_required');
        });

        await check('a failed AI run is a 502, not a made-up answer', async () => {
            aiState.fail = true;
            const r = await t.get('/api/v1/analyze', { as: ana, json: { url: 'https://example.com/fail.png' } });
            assert.strictEqual(r.status, 502, r.text);
            assert.strictEqual(r.json().code, 'meme.ai_failed');
            aiState.fail = null;
        });
    } finally {
        await t.close();
    }

    await check('without OpenVibe.AI the analyzer says so (503)', async () => {
        const t2 = await boot({ env: { OV_AI_INTERNAL_URL: null } });
        try {
            assert.strictEqual(t2.ctx.ai.enabled, false);
            const r = await t2.get('/api/v1/analyze', { as: t2.network.addUser('ann'), json: { url: 'https://example.com/a.png' } });
            assert.strictEqual(r.status, 503, r.text);
            assert.strictEqual(r.json().code, 'meme.ai_unavailable');
        } finally { await t2.close(); }
    });

    await check('each person has a share a day: past it, 429 before any AI call, and someone else still can', async () => {
        const t2 = await boot({ env: { ...baseEnv, MEME_ANALYZE_PER_PERSON_DAY: '1' }, redditRead: { tokenUrl: `${reddit.url}/api/v1/access_token`, apiBase: reddit.url } });
        try {
            const pat = t2.network.addUser('pat');
            const bad = await t2.get('/api/v1/analyze', { as: pat, json: {} });
            assert.strictEqual(bad.status, 400, 'a refused try is free');
            const first = await t2.get('/api/v1/analyze', { as: pat, json: { url: 'https://example.com/a.png' } });
            assert.strictEqual(first.status, 200, first.text);
            const before = aiState.requests.length;
            const second = await t2.get('/api/v1/analyze', { as: pat, json: { url: 'https://example.com/b.png' } });
            assert.strictEqual(second.status, 429, second.text);
            assert.strictEqual(second.json().code, 'meme.person_cap');
            assert.strictEqual(aiState.requests.length, before, 'no call was made');
            const other = await t2.get('/api/v1/analyze', { as: t2.network.addUser('lee'), json: { url: 'https://example.com/c.png' } });
            assert.strictEqual(other.status, 200, other.text);
        } finally { await t2.close(); }
    });

    await check('the daily call budget refuses the request before any AI call', async () => {
        const t2 = await boot({ env: { ...baseEnv, MEME_AI_DAILY_CALLS: '2' }, redditRead: { tokenUrl: `${reddit.url}/api/v1/access_token`, apiBase: reddit.url } });
        try {
            const first = await t2.get('/api/v1/analyze', { as: t2.network.addUser('ann'), json: { url: 'https://example.com/a.png' } });
            assert.strictEqual(first.status, 200, first.text);
            const before = aiState.requests.length;
            const second = await t2.get('/api/v1/analyze', { as: t2.network.addUser('ann'), json: { url: 'https://example.com/b.png' } });
            assert.strictEqual(second.status, 429, second.text);
            assert.strictEqual(second.json().code, 'meme.ai_budget');
            assert.strictEqual(aiState.requests.length, before, 'no call was made');
        } finally { await t2.close(); }
    });

    await ai.close();
    await reddit.close();
    done();
})();
