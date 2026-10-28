'use strict';
/**
 * ADR-033: Meme's part of an account export (votes, captions, reports) and of a deletion, applied through
 * /internal/events with a stand-in Network. A deletion erases the person's rows and leaves other people's, the
 * entries themselves and the Search outbox alone. A redelivery changes nothing; a bad signature and a proxied
 * request are refused.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');

const A = ids.newId('user');
const B = ids.newId('user');
const EXP = `exp_${ids.ulid()}`;
const DEL = `del_${ids.ulid()}`;
const SECRET = `fixture_${'account'.repeat(6)}`;
const WRONG = `fixture_${'mismatch'.repeat(6)}`;

const exportEvent = { event_id: `evt_${ids.ulid()}`, event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: `evt_${ids.ulid()}`, event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [] } };
const bodyOf = (ev) => JSON.stringify({ event: ev, seq: 1 });

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_meme', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw.toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const stub = await startNetworkStub();
    const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'meme', clientSecret: 'meme-secret' });
    const t = await boot({ env: { MEME_EVENTS_SECRET: SECRET }, accountSend: sender });
    try {
        const db = t.ctx.s.db;
        const at = new Date().toISOString();
        const eid = `mem_${ids.ulid()}`;
        await db.exec(`INSERT INTO meme_entries (id, slug, title, kind, visibility, first_seen_at, last_seen_at) VALUES ($1, 'account-entry', 'Account entry', 'joke', 'public', $2, $2)`, [eid, at]);
        const capA = `mcp_${ids.ulid()}`;
        const capB = `mcp_${ids.ulid()}`;
        await db.exec(`INSERT INTO meme_captions (id, subject, template_id, lines) VALUES ($1, $2, 'tpl_classic', '["A caption"]'::jsonb), ($3, $4, 'tpl_classic', '["B caption"]'::jsonb)`, [capA, A, capB, B]);
        await db.exec("INSERT INTO meme_votes (week, entry_id, subject) VALUES ('2026-W44', $1, $2), ('2026-W44', $1, $3)", [eid, A, B]);
        const repA = `mrp_${ids.ulid()}`;
        const repB = `mrp_${ids.ulid()}`;
        await db.exec(`INSERT INTO meme_reports (id, entry_id, subject, kind, reason) VALUES ($1, $2, $3, 'correction', 'A report'), ($4, $2, $5, 'takedown', 'B report')`, [repA, eid, A, repB, B]);

        await check('an export carries only A\'s votes, captions and reports', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'exported');
            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.ok(part, 'the part was pushed to Network');
            assert.strictEqual(part.auth, 'Bearer tok_meme');
            assert.strictEqual(part.body.subject, A);
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['captions.json', 'reports.json', 'votes.json']);
            const all = JSON.stringify(part.body);
            assert.ok(all.includes('A caption'));
            assert.ok(!all.includes('B caption'), 'nobody else\'s caption');
            assert.ok(all.includes('A report'));
            assert.ok(!all.includes('B report'));
            assert.ok(!all.includes('Account entry'), 'an entry is not the person\'s row');
            const votes = part.body.files.find((f) => f.name === 'votes.json').content;
            assert.deepStrictEqual(votes.map((v) => v.subject), [A]);
            const captions = part.body.files.find((f) => f.name === 'captions.json').content;
            assert.deepStrictEqual(captions.map((c) => c.id), [capA]);
        });

        await check('a deletion erases A\'s rows and confirms with counts; B and the entry stay', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().outcome, 'erased');
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_votes WHERE subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_captions WHERE subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_reports WHERE subject = $1', [A])), 0);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_votes WHERE subject = $1', [B])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_captions WHERE subject = $1', [B])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_reports WHERE subject = $1', [B])), 1);
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_entries WHERE id = $1', [eid])), 1);
            const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.ok(confirmation, 'the confirmation was sent');
            assert.ok(confirmation.body.erased.meme_votes >= 1);
            assert.ok(confirmation.body.erased.meme_captions >= 1);
            assert.ok(confirmation.body.erased.meme_reports >= 1);
            assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));
        });

        await check('a redelivery changes nothing', async () => {
            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'unchanged');
            assert.strictEqual(Number(await db.value('SELECT COUNT(*)::int AS n FROM meme_captions WHERE subject = $1', [A])), 0);
        });

        await check('the internal route refuses a bad signature (401) and a forwarded request (403)', async () => {
            const bad = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), WRONG) } });
            assert.strictEqual(bad.status, 401);
            const forwarded = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(forwarded.status, 403);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
