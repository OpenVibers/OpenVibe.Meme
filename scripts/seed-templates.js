#!/usr/bin/env node
'use strict';

/**
 * Seeds the caption templates: the well-known meme templates from Wikimedia Commons, each under a licence that lets
 * us use it (public domain, CC0 or a Creative Commons licence), each with its credit and the file page it came from.
 *
 *   node scripts/seed-templates.js             # all of them
 *   node scripts/seed-templates.js --limit 10  # only the first ten
 *
 * The script never starts the HTTP server. A template whose file cannot be found, or whose licence does not allow
 * reuse, is skipped and listed in the output. The three data-free placeholders of v1 are left as they are.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config();

const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createStore } = require('../server/store');
const { createSearchIndex } = require('../server/search');
const { createTemplatesJob } = require('../server/templates/seed');

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return null;
    const next = process.argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
};

async function main() {
    const config = load();
    const limit = arg('limit');
    const s = await openStore(config, { log: console });
    try {
        const search = createSearchIndex({ config, s });
        const entries = createStore(s, { search });
        const job = createTemplatesJob({ config, entries, fetchImpl: globalThis.fetch, log: console });
        const out = await job.runOnce({ limit: limit ? Number(limit) : null });
        for (const t of out.templates) console.log(`[seed-templates] ${t.id} · ${t.name} · ${t.license} · ${t.source_url}`);
        for (const m of out.missing) console.log(`[seed-templates] skipped ${m.name}: ${m.reason}`);
        console.log(`[seed-templates] ${JSON.stringify({ seeded: out.seeded, skipped: out.skipped })}`);
        process.exitCode = 0;
    } finally {
        await s.close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`[seed-templates] ${err && err.message ? err.message : err}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
