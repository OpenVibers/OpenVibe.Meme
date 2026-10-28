'use strict';
/**
 * Meme of the week: one vote a week per person (a second call changes the choice, never adds a ballot), a public
 * count, a signed-in same-origin rule, and only public entries with a live use this week on the ballot.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('alice');
        const bob = t.network.addUser('bob');
        const now = new Date().toISOString();
        const mk = (slug, title, visibility = 'public', observed = now) => t.ctx.entries.createCandidate({
            slug, title, kind: 'meme', summary: 'A candidate.', status: 'rising',
            first_seen_at: observed, last_seen_at: observed, visibility,
            citations: [{ role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: String(Math.floor(Math.random() * 1e9)), chat_message_id: 1, quote_text: 'a repeated phrase here', url: `${t.upstreams.url}/`, observed_at: observed }],
        });
        const one = await mk('first-meme', 'First meme');
        const two = await mk('second-meme', 'Second meme');
        const hidden = await mk('hidden-meme', 'Hidden meme', 'hidden');
        const old = await mk('old-meme', 'Old meme', 'public', '2026-01-01T00:00:00Z');

        await check('a signed-in vote is one ballot and the count is public', async () => {
            const r = await t.get('/api/v1/week/vote', { as: alice, json: { entry_id: one.entry.id } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().vote.changed, true);
            const wk = await t.get('/api/v1/week', { as: alice });
            assert.strictEqual(wk.status, 200);
            const c = wk.json().candidates.find((x) => x.id === one.entry.id);
            assert.ok(c, 'the entry is on this week’s ballot');
            assert.strictEqual(c.votes, 1);
            assert.strictEqual(c.mine, true);
            assert.ok(!wk.json().candidates.some((x) => x.id === hidden.entry.id), 'a hidden entry is not a candidate');
            assert.ok(!wk.json().candidates.some((x) => x.id === old.entry.id), 'an old use is not this week');
        });

        await check('two people are two votes; one person changing their vote is still one row', async () => {
            assert.strictEqual((await t.get('/api/v1/week/vote', { as: bob, json: { entry_id: one.entry.id } })).status, 200);
            const changed = await t.get('/api/v1/week/vote', { as: alice, json: { entry_id: two.entry.id } });
            assert.strictEqual(changed.status, 200);
            assert.strictEqual(changed.json().vote.changed, true);
            const rows = await t.ctx.s.db.many('SELECT week, subject, entry_id FROM meme_votes ORDER BY subject');
            assert.strictEqual(rows.length, 2, 'one row per person per week');
            assert.strictEqual(rows.filter((r) => r.subject === alice.subject).length, 1);
            const counts = await t.ctx.s.db.many('SELECT entry_id, COUNT(*)::int AS n FROM meme_votes GROUP BY entry_id');
            const byId = Object.fromEntries(counts.map((c) => [c.entry_id, Number(c.n)]));
            assert.strictEqual(byId[one.entry.id], 1);
            assert.strictEqual(byId[two.entry.id], 1);
        });

        await check('anonymous, cross-site and non-public votes are refused', async () => {
            const anon = await t.get('/api/v1/week/vote', { json: { entry_id: one.entry.id } });
            assert.strictEqual(anon.status, 401);
            assert.strictEqual(anon.json().code, 'meme.sign_in_required');
            const cross = await t.get('/api/v1/week/vote', { as: alice, json: { entry_id: one.entry.id }, origin: 'https://evil.example' });
            assert.strictEqual(cross.status, 403);
            assert.strictEqual(cross.json().code, 'meme.cross_site');
            const gone = await t.get('/api/v1/week/vote', { as: alice, json: { entry_id: hidden.entry.id } });
            assert.strictEqual(gone.status, 404);
            const missing = await t.get('/api/v1/week/vote', { as: alice, json: {} });
            assert.strictEqual(missing.status, 400);
        });

        await check('the /week page has the plain vote form and shows the count', async () => {
            const r = await t.get('/week', { as: alice });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('id="mm-week"'));
            assert.ok(r.text.includes('action="/week/vote"'));
            assert.ok(r.text.includes('name="entry_id"'));
            assert.ok(r.text.includes('Your vote'));
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        });
    } finally {
        await t.close();
    }
    done();
})();
