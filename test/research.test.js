'use strict';
/**
 * M5: deep dives. A local AI run API returns a source pack and a long read; the job must keep every claim cited,
 * fail a read that is not grounded, and let its author save the read as a public deep-dive entry.
 */
const assert = require('assert');
const http = require('http');
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

const SOURCES = [
    { url: 'https://en.wikipedia.org/wiki/Doge', title: 'Doge (meme)', content: 'Doge is an internet meme of a Shiba Inu dog with broken-English captions.', retrieved_at: '2026-10-30T00:00:00Z', provenance: { provider: 'wikipedia', site: 'en.wikipedia.org', license: 'CC BY-SA 4.0' } },
    { url: 'https://knowyourmeme.example/doge', title: 'Doge — Know Your Meme', content: 'The format spread from a 2010 blog post to Reddit and Tumblr.', retrieved_at: '2026-10-30T00:00:00Z', provenance: { provider: 'deepseek', site: 'knowyourmeme.example', license: null } },
];

(async () => {
    const aiState = { mode: 'good', requests: [] };
    const ai = await listen(async (req, raw, json) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/runs' && req.method === 'POST') {
            assert.match(String(req.headers.authorization), /^Bearer /);
            const body = JSON.parse(raw || '{}');
            aiState.requests.push(body);
            if (body.workflow === 'research.gather') {
                return json(201, { run: { id: 'run_gather', status: 'succeeded', workflow: body.workflow, output: { query: body.input.query, sources: SOURCES, images: [], facts: [{ label: 'First seen', value: '2010' }], providers: { wikipedia: { ok: true } }, usage: { requests: 2 } }, cost_usd: 0.01 } });
            }
            if (body.workflow === 'ai.generate') {
                const text = aiState.mode === 'ungrounded'
                    ? '# A deep dive\n\nThis paragraph makes a claim without naming a source at all.'
                    : '# Doge, ten years on\n\nDoge began as a Shiba Inu photograph with broken-English captions [1].\n\n## How it spread\n\nIt moved from a blog post to Reddit and Tumblr [2].\n\nIt remains a reusable format for affectionate mockery [1][2].';
                return json(201, { run: { id: 'run_write', status: 'succeeded', workflow: body.workflow, output: { text }, cost_usd: 0.01 } });
            }
            return json(400, { error: 'unknown workflow' });
        }
        return json(404, { error: 'not found' });
    });

    async function waitForJob(t, id, subject) {
        for (let i = 0; i < 100; i++) {
            const r = await t.get(`/api/v1/research/${id}`, subject ? { as: subject } : {});
            if (r.status === 200) {
                const b = r.json();
                if (b.status === 'succeeded' || b.status === 'failed') return b;
            }
            await new Promise((r2) => setTimeout(r2, 20));
        }
        throw new Error('research job did not finish');
    }

    const t = await boot({ env: { OV_AI_INTERNAL_URL: ai.url } });
    try {
        const kim = t.network.addUser('kim');
        const bo = t.network.addUser('bo');

        await check('POST /research starts a job, gathers sources and writes a cited long read', async () => {
            const r = await t.get('/api/v1/research', { as: kim, json: { topic: 'Doge' } });
            assert.strictEqual(r.status, 202, r.text);
            assert.strictEqual(r.json().status, 'queued');
            assert.strictEqual(r.headers.get('location'), `/api/v1/research/${r.json().id}`);
            const done = await waitForJob(t, r.json().id, kim);
            assert.strictEqual(done.status, 'succeeded', JSON.stringify(done));
            assert.strictEqual(done.title, 'Doge, ten years on');
            assert.ok(done.body_markdown.includes('[1]'));
            assert.strictEqual(done.sources.length, 2);
            assert.strictEqual(done.sources[0].n, 1);
            assert.strictEqual(done.sources[0].provider, 'wikipedia');
            assert.strictEqual(done.citations.length, 2);
            assert.deepStrictEqual(done.facts, [{ label: 'First seen', value: '2010' }]);
            assert.ok(done.summary.length > 0 && done.summary.length <= 300);
            assert.ok(Math.abs(done.cost_usd - 0.02) < 0.0001);
            assert.ok(aiState.requests[0].input.query === 'Doge');
            assert.strictEqual((await t.get(`/api/v1/research/${r.json().id}`)).status, 200, 'a succeeded read is public');
            const usage = await t.ctx.s.db.maybe('SELECT * FROM meme_research_usage');
            assert.strictEqual(Number(usage.calls), 2);
        });

        let savedId = null;
        await check('a succeeded read saves as a public deep-dive entry with its full text', async () => {
            const jobs = await t.ctx.s.db.many("SELECT id FROM meme_research WHERE status = 'succeeded' ORDER BY created_at DESC LIMIT 1");
            savedId = jobs[0].id;
            const r = await t.get(`/api/v1/research/${savedId}/entry`, { as: kim, method: 'POST' });
            assert.strictEqual(r.status, 201, r.text);
            const slug = r.json().entry.slug;
            assert.strictEqual(slug, 'doge-ten-years-on');
            assert.strictEqual(r.json().entry.visibility, 'public');
            const entry = await t.get(`/api/v1/entries/${slug}`);
            assert.strictEqual(entry.status, 200, entry.text);
            const dive = await t.get(`/api/v1/entries/${slug}/deep-dive`);
            assert.strictEqual(dive.status, 200, dive.text);
            assert.ok(dive.json().body_markdown.includes('## How it spread'));
            assert.strictEqual(dive.json().sources.length, 2);
            const row = await t.ctx.s.db.maybe('SELECT entry_slug FROM meme_research WHERE id = $1', [savedId]);
            assert.strictEqual(row.entry_slug, slug);
            const again = await t.get(`/api/v1/research/${savedId}/entry`, { as: kim, method: 'POST' });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(again.json().already, true);
            assert.strictEqual((await t.get(`/api/v1/research/${savedId}/entry`, { as: bo, method: 'POST' })).status, 403);
        });

        await check('a read that does not cite every paragraph is failed, not saved', async () => {
            aiState.mode = 'ungrounded';
            const r = await t.get('/api/v1/research', { as: kim, json: { topic: 'An ungrounded claim' } });
            assert.strictEqual(r.status, 202, r.text);
            const job = await waitForJob(t, r.json().id, kim);
            assert.strictEqual(job.status, 'failed');
            assert.strictEqual(job.error.code, 'meme.research_ungrounded');
            assert.ok(job.error.detail.includes('carries no citation'));
            assert.strictEqual((await t.get(`/api/v1/research/${r.json().id}`)).status, 404, 'a failed job is not public');
            assert.strictEqual((await t.get(`/api/v1/research/${r.json().id}/entry`, { as: kim, method: 'POST' })).status, 409);
            aiState.mode = 'good';
        });

        await check('validation, auth and unknown ids', async () => {
            assert.strictEqual((await t.get('/api/v1/research', { json: { topic: 'Doge' } })).status, 401);
            assert.strictEqual((await t.get('/api/v1/research', { as: kim, json: { topic: '' } })).status, 400);
            assert.strictEqual((await t.get('/api/v1/research', { as: kim, json: { topic: 'Doge'.repeat(100) } })).status, 400);
            assert.strictEqual((await t.get('/api/v1/research/rsc_nope')).status, 404);
            assert.strictEqual((await t.get('/api/v1/entries/not-a-dive/deep-dive')).status, 404);
        });
    } finally {
        await t.close();
    }

    await check('without AI the route says so; with a one-call budget it refuses before creating a job', async () => {
        const off = await boot({ env: { OV_AI_INTERNAL_URL: null } });
        try {
            const r = await off.get('/api/v1/research', { as: off.network.addUser('kim'), json: { topic: 'Doge' } });
            assert.strictEqual(r.status, 503, r.text);
            assert.strictEqual(r.json().code, 'meme.ai_unavailable');
        } finally { await off.close(); }

        const low = await boot({ env: { OV_AI_INTERNAL_URL: ai.url, MEME_RESEARCH_DAILY_CALLS: '1' } });
        try {
            const r = await low.get('/api/v1/research', { as: low.network.addUser('kim'), json: { topic: 'Doge' } });
            assert.strictEqual(r.status, 429, r.text);
            assert.strictEqual(r.json().code, 'meme.ai_budget');
            assert.strictEqual(Number(await low.ctx.s.db.value('SELECT COUNT(*)::int AS n FROM meme_research')), 0);
        } finally { await low.close(); }
    });

    await ai.close();
    done();
})();
