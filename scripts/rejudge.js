#!/usr/bin/env node
'use strict';

/**
 * The re-judge round: every candidate is judged again from its own citations, and the publish rule decides what
 * becomes public. The script says what it did, entry by entry, with the score and the reasons.
 *
 *   node scripts/rejudge.js                # every hidden candidate
 *   node scripts/rejudge.js --slug cozmo-s-alive --slug wait-wait-wait
 *   node scripts/rejudge.js --dry-run      # judge and report, publish nothing
 *
 * A candidate that clears the bar (0.75 or more, used at least three times across at least two days or two
 * channels, nothing denied, nothing about looks) is published and the decision is a status event. Everything else
 * stays hidden for staff, with its score on GET /api/v1/staff/candidates.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config();

const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createStore } = require('../server/store');
const { createSearchIndex } = require('../server/search');
const { createUpstreams } = require('../server/upstreams');
const { createMemeAi } = require('../server/ai/client');
const { createContext } = require('../server/ai/context');
const { createJudge } = require('../server/ai/judge');
const { createJudgeJob } = require('../server/jobs/judge');

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return null;
    const next = process.argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
};

async function main() {
    const config = load();
    const slugs = process.argv.reduce((acc, v, i, all) => (v === '--slug' && all[i + 1] ? [...acc, all[i + 1]] : acc), []);
    const dryRun = process.argv.includes('--dry-run');
    const s = await openStore(config, { log: console });
    try {
        const search = createSearchIndex({ config, s });
        const entries = createStore(s, { search });
        const upstreams = createUpstreams({ config, fetchImpl: globalThis.fetch, log: console });
        const ai = createMemeAi({ config, fetchImpl: globalThis.fetch, log: console });
        const context = createContext({ config, upstreams, log: console });
        const judge = createJudge({ config, ai, context, log: console });
        const job = createJudgeJob({ config, s, entries, judge, context, log: console });
        if (!ai.enabled) throw new Error('OpenVibe.AI is not configured (OV_OAUTH_CLIENT_SECRET and OV_AI_INTERNAL_URL); nothing was judged');

        const before = await entries.listHidden({ limit: 500 });
        const out = await job.runOnce({ force: !slugs.length, only: slugs.length ? slugs : null, publish: !dryRun });
        const after = await entries.listHidden({ limit: 500 });

        const published = [];
        const kept = [];
        for (const entry of before) {
            const verdict = await entries.judgement(entry.id);
            const row = after.find((e) => e.id === entry.id);
            const line = {
                slug: entry.slug,
                title: entry.title,
                score: verdict ? verdict.score : null,
                reason: verdict ? verdict.reason : null,
                uses: row ? row.uses : entry.uses,
                days: row ? row.days : 0,
                channels: row ? row.channels : 0,
                visibility: row ? row.visibility : 'published',
            };
            if (!row) published.push(line);
            else kept.push(line);
        }
        console.log(`[rejudge] ${JSON.stringify(out)}`);
        for (const line of published) console.log(`[rejudge] PUBLISHED ${line.slug} — ${line.score} — ${line.reason}`);
        for (const line of kept) console.log(`[rejudge] hidden   ${line.slug} — ${line.score} — ${line.uses} uses, ${line.days} days, ${line.channels} channels`);
        console.log(`[rejudge] published ${published.length}, kept hidden ${kept.length}`);
        if (dryRun) console.log('[rejudge] dry run: the entries above were judged; publish them with the job again without --dry-run');
        process.exitCode = out.ok ? 0 : 1;
    } finally {
        await s.close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`[rejudge] ${err && err.message ? err.message : err}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
