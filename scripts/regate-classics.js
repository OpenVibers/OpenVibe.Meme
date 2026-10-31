#!/usr/bin/env node
'use strict';

/**
 * Re-gate the hidden classics with today's rule (server/ai/gate.js evaluateClassic), from the judgement each one already
 * has: no AI is called again. A classic that clears the rule now is published through the store (the origin check and
 * the Search document come with it) and the decision is a status event; the rest stay hidden with their reasons.
 *
 *   node scripts/regate-classics.js --dry-run   # report only
 *   node scripts/regate-classics.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config();

const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createStore } = require('../server/store');
const { createSearchIndex } = require('../server/search');
const { evaluateClassic } = require('../server/ai/gate');

async function regate({ s, entries, dryRun = false, minScore = 0.75 }) {
    const rows = await s.db.many(`SELECT e.slug, e.title, j.score, j.title AS j_title, j.summary, j.origin, j.spread, j.examples, j.denied, j.looks, j.reason
        FROM meme_entries e JOIN meme_judgements j ON j.entry_id = e.id
        WHERE e.kind = 'classic' AND e.visibility <> 'public' ORDER BY e.slug`);
    const out = { checked: rows.length, published: [], kept: 0, refused: [] };
    for (const r of rows) {
        const judgement = { score: r.score, title: r.j_title, summary: r.summary, origin: r.origin, spread: r.spread, examples: r.examples, denied: r.denied, looks: r.looks };
        const decision = evaluateClassic({ judgement, minScore, entry: { title: r.title } });
        if (!decision.publish) { out.kept++; continue; }
        if (dryRun) { out.published.push(r.slug); continue; }
        const done = await entries.publish(r.slug, { changedBy: 'service:meme:regate' });
        if (!done.ok) { out.refused.push(`${r.slug}: ${done.code || done.message || 'refused'}`); continue; }
        await entries.logDecision({
            entryId: done.entry.id, decision: 'publish', fromStatus: 'classic', toStatus: 'classic', fromVisibility: 'hidden', toVisibility: 'public',
            score: decision.score, reason: `re-gated on 10-31's classic rule: the AI scored it ${Number(decision.score).toFixed(2)}`, changedBy: 'service:meme:regate',
        });
        out.published.push(r.slug);
    }
    return out;
}

module.exports = { regate };

if (require.main === module) {
    (async () => {
        const config = load();
        const s = await openStore(config);
        const entries = createStore(s, { search: createSearchIndex({ config, s }) });
        const out = await regate({ s, entries, dryRun: process.argv.includes('--dry-run') });
        console.log(`[regate-classics] checked ${out.checked}, published ${out.published.length}, kept ${out.kept}, refused ${out.refused.length}`);
        if (out.refused.length) console.log(out.refused.slice(0, 10).join('\n'));
        await s.close();
    })().catch((err) => { console.error(err); process.exit(1); });
}
