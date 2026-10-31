'use strict';
/**
 * M3: Reddit trends through the official API only.
 *
 *   - the importer needs MEME_REDDIT_CLIENT_ID/SECRET; without them it is off and runOnce() says so;
 *   - a run records posts and one score sample each, dHashes the pictures, and a hash repeated in three posts
 *     becomes a new template (with its picture in Media when configured);
 *   - `/trends?window=day|week` ranks by upvote velocity computed from samples, lists templates and entries;
 *   - the Reddit source is registered disabled with OpenVibe.Sources when asked, idempotently.
 */
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { dHash, hamming } = require('../server/phash');
const { imageUrlOf } = require('../server/reddit');

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

/** A 32×32 gradient; `invert` makes a clearly different dHash. */
async function gradient(invert = false) {
    const w = 32;
    const h = 32;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 3;
            raw[i] = invert ? 255 - x * 8 : x * 8;
            raw[i + 1] = invert ? 255 - y * 8 : y * 8;
            raw[i + 2] = invert ? x * 4 : y * 4;
        }
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function post(id, { subreddit = 'memes', title = 'A meme', score = 100, comments = 5, hoursAgo = 6, image = 'a', over18 = false } = {}) {
    const created = Math.floor(Date.now() / 1000) - hoursAgo * 3600;
    return {
        id, subreddit, title, score, num_comments: comments, over_18: over18, author: `u_${id}`,
        permalink: `/r/${subreddit}/comments/${id}/a_meme/`, url: `https://i.redd.it/${image}.png`,
        url_overridden_by_dest: `https://i.redd.it/${image}.png`, created_utc: created,
        preview: { images: [{ source: { url: `https://i.redd.it/${image}.png?width=640&amp;auto=webp` } }] },
    };
}

(async () => {
    const clockRef = { now: Date.parse('2026-10-31T06:00:00Z') };
    const redditState = { tokenRequests: 0, api: [], posts: new Map(), token: 'reddit-token' };
    const reddit = await listen(async (req, raw, json) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/access_token' && req.method === 'POST') {
            redditState.tokenRequests++;
            assert.match(String(req.headers.authorization), /^Basic /);
            assert.ok(String(req.headers['user-agent']).includes('openvibe.meme'));
            return json(200, { access_token: redditState.token, expires_in: 3600 });
        }
        const m = u.pathname.match(/^\/r\/([^/]+)\/top$/);
        if (m) {
            redditState.api.push({ subreddit: m[1], t: u.searchParams.get('t'), auth: req.headers.authorization });
            assert.strictEqual(req.headers.authorization, `Bearer ${redditState.token}`);
            const list = redditState.posts.get(m[1]) || [];
            return json(200, { data: { children: list.map((p) => ({ data: p })) } });
        }
        return json(404, { error: 'not found' });
    });
    const sourcesState = { exists: false, creates: [], gets: 0 };
    const sources = await listen(async (req, raw, json) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/sources/meme-reddit' && req.method === 'GET') {
            sourcesState.gets++;
            // The service token is minted by the mock Network below; the route just needs one.
            assert.match(String(req.headers.authorization), /^Bearer /);
            return sourcesState.exists ? json(200, { source: { key: 'meme-reddit' } }) : json(404, { error: 'not found' });
        }
        if (u.pathname === '/api/v1/sources' && req.method === 'POST') {
            sourcesState.creates.push(JSON.parse(raw));
            sourcesState.exists = true;
            return json(201, { source: { key: 'meme-reddit' } });
        }
        return json(404, { error: 'not found' });
    });

    const mediaId = `med_${ids.ulid()}`;
    const media = {
        enabled: true,
        uploads: 0,
        async upload() { this.uploads++; return { media_id: mediaId, url: `https://openvibe.media/o/${mediaId}` }; },
        url: (id) => `https://openvibe.media/o/${id}`,
    };

    const t = await boot({
        now: () => clockRef.now,
        media,
        reddit: { tokenUrl: `${reddit.url}/api/v1/access_token`, apiBase: reddit.url, fetchImageImpl: async (url) => ({ bytes: await gradient(String(url).includes('/b.')), mime: 'image/png', url }) },
        env: {
            MEME_REDDIT_CLIENT_ID: 'reddit-id', MEME_REDDIT_CLIENT_SECRET: 'reddit-secret',
            OV_SOURCES_INTERNAL_URL: sources.url, MEME_SOURCES_REGISTER: '1',
        },
    });
    try {
        await check('dHash is stable and hamming tells pictures apart', async () => {
            const a = await dHash(await gradient(false));
            const b = await dHash(await gradient(true));
            assert.match(a, /^[0-9a-f]{16}$/);
            assert.strictEqual(await dHash(await gradient(false)), a);
            assert.ok(hamming(a, b) > 10, `distance ${hamming(a, b)}`);
            assert.strictEqual(hamming(a, a), 0);
            assert.strictEqual(hamming('nope', a), 64);
            assert.strictEqual(imageUrlOf({ preview: { images: [{ source: { url: 'https://i.redd.it/x.png?a=1&amp;b=2' } }] } }), 'https://i.redd.it/x.png?a=1&b=2');
        });

        await check('the importer records posts, samples, hashes and a new template; pictures go to Media', async () => {
            const start = Math.floor(clockRef.now / 1000) - 3600;
            redditState.posts.set('memes', [
                post('p1', { title: 'Surprised Pikachu again', score: 500, image: 'a' }),
                post('p2', { title: 'Surprised Pikachu at work', score: 300, image: 'a' }),
                post('p3', { title: 'Surprised Pikachu but a cat', score: 200, image: 'a' }),
                post('p4', { title: 'A different template', score: 100, image: 'b' }),
                post('p5', { title: 'Late night memes', score: 50, image: 'b', over18: true }),
            ]);
            for (const [id, p] of redditState.posts.get('memes').entries()) { p.created_utc = start - id * 60; }
            const out = await t.ctx.reddit.runOnce();
            assert.strictEqual(out.disabled, false, JSON.stringify(out));
            assert.strictEqual(out.posts, 5, JSON.stringify(out));
            assert.strictEqual(out.templates, 1, JSON.stringify(out));
            assert.ok(media.uploads >= 4, `uploads ${media.uploads}`);
            const posts = await t.ctx.s.db.many('SELECT * FROM meme_reddit_posts ORDER BY id');
            assert.strictEqual(posts.length, 5);
            assert.ok(posts.every((p) => p.phash));
            assert.ok(posts.every((p) => p.media_id === mediaId));
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_reddit_samples')), 5);
            const tpl = await t.ctx.s.db.maybe('SELECT * FROM meme_reddit_templates');
            assert.ok(tpl);
            assert.strictEqual(Number(tpl.post_count), 3);
            assert.strictEqual(tpl.media_id, mediaId);
            assert.strictEqual(await t.ctx.s.db.value('SELECT label FROM meme_reddit_templates'), 'Surprised Pikachu again');
            assert.ok(redditState.api.every((r) => r.t === 'day'));
            assert.ok(redditState.api.length >= 1);
        });

        await check('a second run adds samples and /trends ranks by upvote velocity', async () => {
            clockRef.now += 3_600_000;
            const list = redditState.posts.get('memes');
            for (const p of list) p.score += p.id === 'p1' ? 600 : p.id === 'p2' ? 300 : p.id === 'p3' ? 100 : 10;
            const out = await t.ctx.reddit.runOnce();
            assert.strictEqual(out.posts, 5, JSON.stringify(out));
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_reddit_samples')), 10);
            const r = await t.get('/api/v1/trends?window=day');
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.strictEqual(body.window, 'day');
            assert.ok(body.rising.length >= 5);
            const p1 = body.rising.find((p) => p.id === 't3_p1');
            assert.ok(p1, 'p1 is in the rising list');
            assert.strictEqual(p1.velocity_basis, 'samples');
            assert.strictEqual(p1.score_delta, 600);
            assert.ok(Math.abs(p1.velocity - 600) < 1, `velocity ${p1.velocity}`);
            assert.strictEqual(body.rising[0].id, 't3_p1');
            assert.strictEqual(body.templates.length, 1);
            assert.ok(body.templates[0].post_count >= 3);
            assert.ok(Array.isArray(body.entries));
            assert.ok(body.subreddits.some((x) => x.subreddit === 'memes' && x.posts === 5));
            assert.strictEqual((await t.get('/api/v1/trends?window=week')).status, 200);
            assert.strictEqual((await t.get('/api/v1/trends?window=year')).status, 400);
        });

        await check('the Reddit source is registered with Sources once, disabled, with its terms', async () => {
            const first = await t.ctx.sourceRegistration.ensure();
            assert.strictEqual(first.registered, true, JSON.stringify(first));
            assert.strictEqual(sourcesState.creates.length, 1);
            const rec = sourcesState.creates[0];
            assert.strictEqual(rec.key, 'meme-reddit');
            assert.strictEqual(rec.enabled, false);
            assert.ok(rec.terms_note.includes('official API'));
            assert.ok(rec.robots_note);
            assert.strictEqual((await t.ctx.sourceRegistration.ensure()).registered, true);
            assert.strictEqual(sourcesState.creates.length, 1);
            assert.ok(sourcesState.gets >= 2);
        });
    } finally {
        await t.close();
        await reddit.close();
        await sources.close();
    }

    await check('without Reddit credentials the importer is off and the trends read still answers', async () => {
        const t2 = await boot({ env: { MEME_REDDIT_CLIENT_ID: null, MEME_REDDIT_CLIENT_SECRET: null } });
        try {
            assert.strictEqual(t2.ctx.reddit.enabled, false);
            const out = await t2.ctx.reddit.runOnce();
            assert.strictEqual(out.disabled, true);
            assert.strictEqual(t2.ctx.reddit.start(), false);
            const r = await t2.get('/api/v1/trends?window=week');
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json().rising, []);
        } finally {
            await t2.close();
        }
    });

    done();
})();
