'use strict';
/**
 * Captions: text only, 1–4 lines of at most 120 characters, a small blocked-word list, an existing template, a
 * signed-in same-origin write. A public caption never returns its author's subject to an anonymous reader; a
 * hidden caption is 404 to anyone but its owner and staff. The table holds no image column at all.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('alice');
        const bob = t.network.addUser('bob');
        const templates = (await t.get('/api/v1/templates')).json().templates;
        const tpl = templates[0];

        await check('a signed-in caption is saved as lines and returned with its template', async () => {
            const r = await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['when the robot', 'is offline'] } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.headers.get('location'), `/api/v1/captions/${r.json().id}`);
            const c = r.json();
            assert.deepStrictEqual(c.lines, ['when the robot', 'is offline']);
            const got = await t.get(`/api/v1/captions/${c.id}`, { as: alice });
            assert.strictEqual(got.status, 200);
            assert.strictEqual(got.json().subject, alice.subject);
            assert.strictEqual(got.json().mine, true);
            assert.strictEqual(got.json().template.id, tpl.id);
            assert.strictEqual(got.headers.get('cache-control'), 'private, no-store');
        });

        await check('an anonymous read does not expose the subject', async () => {
            const c = (await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['public'] } })).json();
            const r = await t.get(`/api/v1/captions/${c.id}`);
            assert.strictEqual(r.status, 200);
            assert.ok(!('subject' in r.json()));
            assert.strictEqual(r.json().mine, false);
        });

        await check('line count, line length, empty lines, blocked words and the template are enforced', async () => {
            const tooMany = await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['1', '2', '3', '4', '5'] } });
            assert.strictEqual(tooMany.status, 400);
            assert.strictEqual(tooMany.json().code, 'meme.invalid');
            const long = await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['x'.repeat(121)] } });
            assert.strictEqual(long.status, 400);
            const empty = await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['ok', '   '] } });
            assert.strictEqual(empty.status, 400);
            const blocked = await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['this is kys'] } });
            assert.strictEqual(blocked.status, 400);
            assert.strictEqual(blocked.json().code, 'meme.blocked_words');
            const noTpl = await t.get('/api/v1/captions', { as: alice, json: { template_id: 'tpl_missing', lines: ['ok'] } });
            assert.strictEqual(noTpl.status, 404);
        });

        await check('a signed-out, cross-site or non-array caption is refused', async () => {
            assert.strictEqual((await t.get('/api/v1/captions', { json: { template_id: tpl.id, lines: ['ok'] } })).status, 401);
            const cross = await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['ok'] }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403);
            assert.strictEqual(cross.json().code, 'meme.cross_site');
            const notArray = await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: 'one line' } });
            assert.strictEqual(notArray.status, 400);
        });

        await check('a hidden caption is readable only by its owner and staff', async () => {
            const c = (await t.get('/api/v1/captions', { as: alice, json: { template_id: tpl.id, lines: ['secret'], visibility: 'hidden' } })).json();
            assert.strictEqual((await t.get(`/api/v1/captions/${c.id}`)).status, 404);
            assert.strictEqual((await t.get(`/api/v1/captions/${c.id}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/captions/${c.id}`, { as: alice })).status, 200);
            const mod = t.network.addUser('mod', { role: 'global_mod' });
            assert.strictEqual((await t.get(`/api/v1/captions/${c.id}`, { as: mod })).status, 200);
        });

        await check('meme_captions stores no image and no rendered bytes', async () => {
            const cols = (await t.ctx.s.db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'meme_captions'")).map((r) => r.column_name);
            assert.ok(!cols.some((c) => /image|blob|bytes|photo/i.test(c)), cols.join(','));
            const row = await t.ctx.s.db.maybe('SELECT lines FROM meme_captions LIMIT 1');
            assert.ok(Array.isArray(row.lines));
        });
    } finally {
        await t.close();
    }
    done();
})();
