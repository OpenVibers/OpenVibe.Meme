'use strict';
/**
 * The judge and the publish rule.
 *
 * A candidate is judged from its own citations by OpenVibe.AI (a stand-in here), and only what clears the bar is
 * published: 0.75 or more, used at least three times across at least two days or two channels, nothing denied,
 * nothing about anyone's looks. Everything else stays hidden for staff, with its score, and every decision is a
 * status event.
 */
const { boot, check, done } = require('./helpers/boot');

const at = (days) => new Date(Date.UTC(2026, 9, 20 + days, 12, 0, 0)).toISOString();
const CHAT_IDS = [1001, 1002, 86960];      // the lines the in-process Chat stand-in holds

/** A candidate with its uses: each use is a chat line (or a VOD second) on its own day. */
async function candidate(t, { slug, title, uses, channels = ['chat'] }) {
    const cites = uses.map((u, i) => {
        const channel = channels[Math.min(i, channels.length - 1)];
        const live = channel === 'live';
        return {
            role: i === 0 ? 'origin' : 'use',
            source_service: channel,
            source_type: live ? 'vod' : 'chat_message',
            source_id: `${slug}-${i}`,
            chat_message_id: live ? null : CHAT_IDS[i % CHAT_IDS.length],
            vod_id: live ? 9001 : null,
            offset_seconds: live ? 60 + i : null,
            quote_text: `${title} - line ${i + 1}`,
            url: live ? 'https://openvibe.video/v/9001?t=60' : 'https://openvibe.chat/',
            observed_at: u,
        };
    });
    const out = await t.ctx.entries.createCandidate({
        slug, title, kind: 'catchphrase', summary: 'a template summary', status: 'rising',
        first_seen_at: uses[0], last_seen_at: uses[uses.length - 1], visibility: 'hidden', citations: cites,
    });
    return out.entry;
}

const answer = (score, extra = {}) => (prompt) => JSON.stringify({
    score,
    reason: `the AI scored it ${score}`,
    title: 'Cozmo is alive',
    summary: 'A running joke about the robot being back.',
    origin: 'It starts in the first cited line.',
    spread: 'People say it when the robot comes back.',
    examples: ['the robot is alive', 'cozmo is alive again'],
    ...extra,
});

(async () => {
    await check('the judge reads the cited material: the quote and the lines around it reach the model', async () => {
        const t2 = await boot();
        try {
            await candidate(t2, { slug: 'robot-offline', title: 'The robot is offline', uses: [at(0), at(2), at(3)] });
            await t2.ctx.judgeJob.runOnce({ force: true });
            const call = t2.ai.calls[0];
            if (!call) throw new Error('the judge did not call the AI');
            if (!/the robot is offline - line 1/i.test(call.prompt)) throw new Error('the prompt did not carry the cited quote');
            if (!/Use 1/.test(call.prompt) || !/Use 3/.test(call.prompt)) throw new Error('the prompt did not carry every use');
            if (!/ada:/.test(call.prompt)) throw new Error('the prompt did not carry the chat lines around the quote');
        } finally { await t2.close(); }
    });

    await check('the judge stores the score, the reason and the written entry', async () => {
        const t2 = await boot({ ai: { answer: answer(0.93) } });
        try {
            const entry = await candidate(t2, { slug: 'cozmo-s-alive', title: 'Cozmo s alive', uses: [at(0), at(2), at(3)] });
            await t2.ctx.judgeJob.runOnce({ force: true });
            const verdict = await t2.ctx.entries.judgement(entry.id);
            if (!verdict) throw new Error('no judgement was stored');
            if (Number(verdict.score) !== 0.93) throw new Error(`the score is ${verdict.score}`);
            if (!verdict.reason) throw new Error('no reason was stored');
            if (verdict.origin !== 'It starts in the first cited line.') throw new Error('the origin was not stored');
            if (verdict.spread !== 'People say it when the robot comes back.') throw new Error('the spread was not stored');
            if (!Array.isArray(verdict.examples) || verdict.examples.length !== 2) throw new Error('the examples were not stored');
            const after = await t2.ctx.entries.byId(entry.id);
            if (after.title !== 'Cozmo is alive') throw new Error(`the AI title was not used: ${after.title}`);
        } finally { await t2.close(); }
    });

    await check('a candidate that clears the bar is published', async () => {
        const t2 = await boot({ ai: { answer: answer(0.9) } });
        try {
            const entry = await candidate(t2, { slug: 'yes-please', title: 'Yes please', uses: [at(0), at(2), at(3)] });
            const out = await t2.ctx.judgeJob.runOnce({ force: true });
            if (out.published !== 1) throw new Error(`expected one published entry, got ${out.published}`);
            const after = await t2.ctx.entries.byId(entry.id);
            if (after.visibility !== 'public') throw new Error('the entry is not public');
        } finally { await t2.close(); }
    });

    await check('the rule: a score under 0.75 keeps the entry hidden', async () => {
        const t2 = await boot({ ai: { answer: answer(0.74) } });
        try {
            const entry = await candidate(t2, { slug: 'weak-phrase', title: 'Yeah thats true', uses: [at(0), at(2), at(3)] });
            const out = await t2.ctx.judgeJob.runOnce({ force: true });
            if (out.published !== 0) throw new Error('a weak entry was published');
            const after = await t2.ctx.entries.byId(entry.id);
            if (after.visibility !== 'hidden') throw new Error('the entry is not hidden');
            const list = await t2.ctx.entries.listHidden({ limit: 10 });
            const row = list.find((e) => e.id === entry.id);
            if (!row) throw new Error('the entry is not on the staff list');
            if (Number(row.score) !== 0.74) throw new Error(`the staff list shows ${row.score}`);
        } finally { await t2.close(); }
    });

    await check('the rule: fewer than three uses keeps the entry hidden', async () => {
        const t2 = await boot({ ai: { answer: answer(0.95) } });
        try {
            const entry = await candidate(t2, { slug: 'twice-only', title: 'Twice only', uses: [at(0), at(2)] });
            const out = await t2.ctx.judgeJob.runOnce({ force: true });
            if (out.published !== 0) throw new Error('a twice-used entry was published');
            const after = await t2.ctx.entries.byId(entry.id);
            if (after.visibility !== 'hidden') throw new Error('the entry is not hidden');
        } finally { await t2.close(); }
    });

    await check('the rule: three uses on one day in one channel keep the entry hidden', async () => {
        const t2 = await boot({ ai: { answer: answer(0.95) } });
        try {
            const entry = await candidate(t2, { slug: 'one-day', title: 'Same day', uses: [at(0), at(0), at(0)] });
            const out = await t2.ctx.judgeJob.runOnce({ force: true });
            if (out.published !== 0) throw new Error('an entry used on one day was published');
        } finally { await t2.close(); }
    });

    await check('the rule: three uses across two channels clear the bar even on one day', async () => {
        const t2 = await boot({ ai: { answer: answer(0.95) } });
        try {
            const entry = await candidate(t2, { slug: 'two-channels', title: 'Both places', uses: [at(0), at(0), at(0)], channels: ['chat', 'live'] });
            const out = await t2.ctx.judgeJob.runOnce({ force: true });
            if (out.published !== 1) throw new Error('an entry used in two channels was not published');
            const after = await t2.ctx.entries.byId(entry.id);
            if (after.visibility !== 'public') throw new Error('the entry is not public');
        } finally { await t2.close(); }
    });

    await check('the rule: a denied source is never stored and never published', async () => {
        const t2 = await boot({ ai: { answer: answer(0.99) } });
        try {
            const out = await t2.ctx.entries.createCandidate({
                slug: 'denied-one', title: 'Denied one', kind: 'meme', status: 'rising',
                first_seen_at: at(0), last_seen_at: at(3), visibility: 'hidden',
                citations: [
                    { role: 'origin', source_service: 'live', source_type: 'vod', source_id: '5709', vod_id: 5709, offset_seconds: 10, quote_text: 'the robot is offline', url: 'https://openvibe.video/v/5709?t=10', observed_at: at(0) },
                    { role: 'use', source_service: 'chat', source_type: 'chat_message', source_id: '1', chat_message_id: 1001, quote_text: 'the robot is offline', url: 'https://openvibe.chat/', observed_at: at(2) },
                    { role: 'use', source_service: 'chat', source_type: 'chat_message', source_id: '2', chat_message_id: 1002, quote_text: 'the robot is offline', url: 'https://openvibe.chat/', observed_at: at(3) },
                ],
            });
            const stored = await t2.ctx.entries.citations(out.entry.id);
            if (stored.length !== 2) throw new Error(`the denied citation was stored (${stored.length} citations)`);
            if (stored.some((c) => c.vod_id === 5709)) throw new Error('the denied VOD is in the citations');
            const judged = await t2.ctx.judgeJob.runOnce({ force: true });
            if (judged.published !== 0) throw new Error('an entry citing a denied VOD was published');
            const after = await t2.ctx.entries.byId(out.entry.id);
            if (after.visibility !== 'hidden') throw new Error('the entry is not hidden');
        } finally { await t2.close(); }
    });

    await check('the rule: text that names looks never reaches the public', async () => {
        const t2 = await boot({ ai: { answer: answer(0.99, { title: 'Cozmo in his blue shirt', summary: 'A man in a kitchen says the robot is offline.' }) } });
        try {
            const entry = await candidate(t2, { slug: 'looks-one', title: 'Looks one', uses: [at(0), at(2), at(3)] });
            const out = await t2.ctx.judgeJob.runOnce({ force: true });
            if (out.published !== 0) throw new Error('an entry whose text names looks was published');
            const after = await t2.ctx.entries.byId(entry.id);
            if (after.visibility !== 'hidden') throw new Error('the entry is not hidden');
            if (after.title === 'Cozmo in his blue shirt') throw new Error('the title that named looks was used');
            const verdict = await t2.ctx.entries.judgement(entry.id);
            if (!verdict.looks) throw new Error('the judgement does not say the text named looks');
        } finally { await t2.close(); }
    });

    await check('the rule: text that carries a denied word never reaches the public', async () => {
        const t2 = await boot({ ai: { answer: answer(0.99, { summary: 'The joke is about a nazi in a kitchen.' }) } });
        try {
            const entry = await candidate(t2, { slug: 'denied-word', title: 'Denied word', uses: [at(0), at(2), at(3)] });
            const out = await t2.ctx.judgeJob.runOnce({ force: true });
            if (out.published !== 0) throw new Error('an entry with a denied word was published');
            const verdict = await t2.ctx.entries.judgement(entry.id);
            if (!verdict.denied) throw new Error('the judgement does not say the text is denied');
        } finally { await t2.close(); }
    });

    await check('every decision is a status event', async () => {
        const t2 = await boot({ ai: { answer: answer(0.9) } });
        try {
            const entry = await candidate(t2, { slug: 'logged-one', title: 'Logged one', uses: [at(0), at(2), at(3)] });
            await t2.ctx.judgeJob.runOnce({ force: true });
            const history = await t2.ctx.entries.decisions(entry.id);
            if (!history.length) throw new Error('no status event was written');
            const decision = history[0];
            if (decision.decision !== 'publish') throw new Error(`the decision is ${decision.decision}`);
            if (decision.from_visibility !== 'hidden' || decision.to_visibility !== 'public') throw new Error('the visibility move was not recorded');
            if (Number(decision.score) !== 0.9) throw new Error(`the event carries the score ${decision.score}`);
        } finally { await t2.close(); }
    });

    await check('a kept candidate is logged too, with the reasons', async () => {
        const t2 = await boot({ ai: { answer: answer(0.3) } });
        try {
            const entry = await candidate(t2, { slug: 'kept-one', title: 'Kept one', uses: [at(0), at(2), at(3)] });
            await t2.ctx.judgeJob.runOnce({ force: true });
            const history = await t2.ctx.entries.decisions(entry.id);
            if (!history.length) throw new Error('no status event was written');
            if (history[0].decision !== 'keep_hidden') throw new Error(`the decision is ${history[0].decision}`);
            if (!/scored 0.30/.test(history[0].reason || '')) throw new Error(`the reason does not say why: ${history[0].reason}`);
        } finally { await t2.close(); }
    });

    await check('the staff list shows the hidden candidates with their score', async () => {
        const t2 = await boot({ ai: { answer: answer(0.42) } });
        try {
            const entry = await candidate(t2, { slug: 'staff-one', title: 'Staff one', uses: [at(0), at(2), at(3)] });
            await t2.ctx.judgeJob.runOnce({ force: true });
            const res = await t2.get('/api/v1/staff/candidates', { as: t2.network.addUser('mod', { role: 'global_mod' }) });
            if (res.status !== 200) throw new Error(`the staff list answered ${res.status}`);
            const body = res.json();
            const row = (body.candidates || []).find((c) => c.id === entry.id);
            if (!row) throw new Error('the candidate is not on the staff list');
            if (Number(row.score) !== 0.42) throw new Error(`the list shows the score ${row.score}`);
            if (!row.reason) throw new Error('the list shows no reason');
            if (row.uses !== 3) throw new Error(`the list shows ${row.uses} uses`);
        } finally { await t2.close(); }
    });

    await check('the staff list is not for anonymous visitors', async () => {
        const t = await boot();
        try {
            const res = await t.get('/api/v1/staff/candidates');
            if (res.status !== 401) throw new Error(`the staff list answered ${res.status} to an anonymous caller`);
        } finally { await t.close(); }
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
