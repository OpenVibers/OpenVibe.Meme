'use strict';
/**
 * M6: generate a meme. A local AI run API supplies the current-uses pack and the captions; the real renderer
 * draws the template layout with the bundled fonts, and a Media stand-in captures the PNG.
 */
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
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

(async () => {
    const aiState = {
        requests: [], template: 'tpl_classic',
        lines: ['when the code compiles on the first try', 'and then the tests fail anyway'],
        labels: ['language'], cost: 0.01,
    };
    const ai = await listen(async (req, raw, json) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/api/v1/runs' && req.method === 'POST') {
            assert.match(String(req.headers.authorization), /^Bearer /);
            const body = JSON.parse(raw || '{}');
            aiState.requests.push(body);
            if (body.workflow === 'research.gather') {
                return json(201, { run: { id: 'run_gather', status: 'succeeded', workflow: body.workflow, output: { query: body.input.query, sources: [
                    { url: 'https://example.com/uses', title: 'The format today', content: 'People caption it with a two-line setup and punchline.', provenance: { provider: 'deepseek' } },
                ], images: [], facts: [], providers: {}, usage: {} }, cost_usd: aiState.cost } });
            }
            return json(201, { run: { id: 'run_captions', status: 'succeeded', workflow: body.workflow, output: { data: { template: aiState.template, lines: aiState.lines, labels: aiState.labels, rationale: 'in voice' } }, cost_usd: aiState.cost } });
        }
        return json(404, { error: 'not found' });
    });

    const mediaId = `med_${ids.ulid()}`;
    const media = {
        enabled: true, uploads: [],
        async uploadPng(png, opts) { this.uploads.push({ png, opts }); return { media_id: mediaId, url: `https://openvibe.media/o/${mediaId}` }; },
    };

    const t = await boot({ env: { OV_AI_INTERNAL_URL: ai.url }, generateMedia: media });
    try {
        const kim = t.network.addUser('kim');
        const bo = t.network.addUser('bo');

        await check('a template generates captions, renders a PNG with the layout and stores it in Media', async () => {
            const r = await t.get('/api/v1/generate', { as: kim, json: { template_slug: 'tpl_classic' } });
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            assert.deepStrictEqual(b.captions, aiState.lines);
            assert.strictEqual(b.template.id, 'tpl_classic');
            assert.strictEqual(b.template.layout.boxes.length, 2);
            assert.deepStrictEqual(b.labels, ['language']);
            assert.strictEqual(b.media_id, mediaId);
            assert.strictEqual(b.media_url, `https://openvibe.media/o/${mediaId}`);
            assert.ok(b.caption.id.startsWith('mcp_'));
            assert.strictEqual(aiState.requests[0].workflow, 'research.gather');
            assert.strictEqual(aiState.requests[1].workflow, 'ai.extract');
            assert.ok(aiState.requests[0].input.query.includes('Classic two-line'));
            assert.ok(aiState.requests[1].input.text.includes('People caption it'));
            assert.strictEqual(media.uploads.length, 1);
            const png = media.uploads[0].png;
            assert.deepStrictEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
            const meta = await sharp(png).metadata();
            assert.strictEqual(meta.width, 440);
            assert.strictEqual(meta.height, 280);
            const row = await t.ctx.s.db.maybe('SELECT labels, media_id FROM meme_captions WHERE id = $1', [b.caption.id]);
            assert.deepStrictEqual(row.labels, ['language']);
            assert.strictEqual(row.media_id, mediaId);
            const usage = await t.ctx.s.db.maybe('SELECT * FROM meme_generate_usage');
            assert.strictEqual(Number(usage.calls), 2);
            assert.ok(Math.abs(Number(usage.cost_usd) - 0.02) < 0.0001);
        });

        await check('a topic lets the model pick the template', async () => {
            aiState.template = 'tpl_reaction';
            aiState.lines = ['the face when it works first time'];
            aiState.labels = [];
            const r = await t.get('/api/v1/generate', { as: kim, json: { topic: 'a clean build' } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().template.id, 'tpl_reaction');
            assert.strictEqual(r.json().captions.length, 1);
        });

        await check('supplied lines are used verbatim; the AI still picks the labels', async () => {
            aiState.lines = ['ignored'];
            aiState.labels = ['graphic'];
            const r = await t.get('/api/v1/generate', { as: kim, json: { template_slug: 'tpl_triptych', lines: ['one', 'two', 'three'] } });
            assert.strictEqual(r.status, 201, r.text);
            assert.deepStrictEqual(r.json().captions, ['one', 'two', 'three']);
            assert.deepStrictEqual(r.json().labels, ['graphic']);
            assert.strictEqual(r.json().template.layout.boxes.length, 3);
            assert.ok(aiState.requests.at(-1).input.text.includes('["one","two","three"]'));
        });

        await check('validation, auth, missing templates and the budget', async () => {
            assert.strictEqual((await t.get('/api/v1/generate', { json: { topic: 'a' } })).status, 401);
            assert.strictEqual((await t.get('/api/v1/generate', { as: kim, json: {} })).status, 400);
            assert.strictEqual((await t.get('/api/v1/generate', { as: kim, json: { template_slug: 'not-a-template' } })).status, 404);
            assert.strictEqual((await t.get('/api/v1/generate', { as: kim, json: { template_slug: 'tpl_classic', lines: ['nigger'] } })).status, 400);
            assert.strictEqual((await t.get('/api/v1/generate', { as: kim, json: { template_slug: 'tpl_classic', lines: [] } })).status, 400);
            const before = aiState.requests.length;
            const low = await boot({ env: { OV_AI_INTERNAL_URL: ai.url, MEME_GENERATE_DAILY_CALLS: '1' }, generateMedia: media });
            try {
                const r = await low.get('/api/v1/generate', { as: low.network.addUser('kim'), json: { template_slug: 'tpl_classic' } });
                assert.strictEqual(r.status, 429, r.text);
                assert.strictEqual(r.json().code, 'meme.ai_budget');
            } finally { await low.close(); }
            assert.strictEqual(aiState.requests.length, before);
        });

        await check('the templates API exposes each layout', async () => {
            const r = await t.get('/api/v1/templates');
            assert.strictEqual(r.status, 200);
            for (const tpl of r.json().templates) {
                assert.ok(tpl.layout && Array.isArray(tpl.layout.boxes), `${tpl.id} has a layout`);
                assert.ok(tpl.layout.boxes.length >= 1);
                assert.strictEqual(tpl.layout.boxes.length, tpl.box_count);
            }
        });
    } finally {
        await t.close();
    }

    await check('without AI or Media the generator says which is missing', async () => {
        const noAi = await boot({ env: { OV_AI_INTERNAL_URL: null }, generateMedia: media });
        try {
            const r = await noAi.get('/api/v1/generate', { as: noAi.network.addUser('kim'), json: { template_slug: 'tpl_classic' } });
            assert.strictEqual(r.status, 503, r.text);
            assert.strictEqual(r.json().code, 'meme.ai_unavailable');
        } finally { await noAi.close(); }
        const noMedia = await boot({ env: { OV_AI_INTERNAL_URL: ai.url }, generateMedia: { enabled: false } });
        try {
            const r = await noMedia.get('/api/v1/generate', { as: noMedia.network.addUser('kim'), json: { template_slug: 'tpl_classic' } });
            assert.strictEqual(r.status, 503, r.text);
            assert.strictEqual(r.json().code, 'meme.media_unavailable');
        } finally { await noMedia.close(); }
    });

    await ai.close();
    done();
})();
