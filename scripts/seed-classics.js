#!/usr/bin/env node
'use strict';

/**
 * Seeds the encyclopedia: the well-known internet memes from Wikipedia's lists (CC BY-SA) and Wikidata (CC0), each
 * written by the same AI pass the OpenVibe candidates use, each cited to the text it was written from.
 *
 *   node scripts/seed-classics.js              # write what is missing, publish what clears the bar
 *   node scripts/seed-classics.js --limit 20   # only the first twenty names of the list
 *   node scripts/seed-classics.js --dry-run    # write nothing; say what would be written
 *
 * The script never starts the HTTP server and never starts a job timer. It reads only the official public APIs of
 * Wikipedia, Wikidata and Wikimedia Commons — never a site whose terms forbid it. What is already seeded (a meme
 * with a Wikidata id already in the table) is left alone, so the script can be run again.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config();

const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createStore } = require('../server/store');
const { createSearchIndex } = require('../server/search');
const { createMemeAi } = require('../server/ai/client');
const { createContext } = require('../server/ai/context');
const { createJudge } = require('../server/ai/judge');
const { createSources } = require('../server/classics/sources');
const { createClassicsJob } = require('../server/classics/seed');

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return null;
    const next = process.argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
};

async function main() {
    const config = load();
    const limit = arg('limit');
    const dryRun = process.argv.includes('--dry-run');
    const s = await openStore(config, { log: console });
    try {
        const search = createSearchIndex({ config, s });
        const entries = createStore(s, { search });
        const upstreams = { chatContext: async () => [], vodContext: async () => [] };
        const ai = createMemeAi({ config, fetchImpl: globalThis.fetch, log: console });
        const context = createContext({ config, upstreams, log: console });
        const judge = createJudge({ config, ai, context, log: console });
        const sources = createSources({ config, fetchImpl: globalThis.fetch, log: console });
        const job = createClassicsJob({ config, s, entries, sources, judge, log: console });
        if (!ai.enabled) throw new Error('OpenVibe.AI is not configured (OV_OAUTH_CLIENT_SECRET and OV_AI_INTERNAL_URL); nothing was written');
        const out = await job.runOnce({ limit: limit ? Number(limit) : null, publish: !dryRun });
        console.log(`[seed-classics] ${JSON.stringify({ ...out, errors: (out.errors || []).slice(0, 10) })}`);
        process.exitCode = out.ok ? 0 : 1;
    } finally {
        await s.close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`[seed-classics] ${err && err.message ? err.message : err}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
