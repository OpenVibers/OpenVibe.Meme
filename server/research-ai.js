'use strict';

/**
 * OpenVibe.AI for deep dives (M5), with its own daily budget in meme_research_usage. It runs registered workflows
 * through the run API: `research.gather` (the sourced evidence pack) and `ai.generate` (the long read). Two calls
 * are reserved before a job starts; the run's stated cost is added when it finishes.
 */
const { serviceAuth } = require('openvibe-contracts');
const { createClient } = require('openvibe-sdk/core');
const { createAiClient } = require('openvibe-sdk/ai');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function createResearchAi({ config, s, fetchImpl = globalThis.fetch, log = console, client = null }) {
    const cfg = config.research || {};
    const enabled = Boolean(client || (cfg.aiUrl && config.oauth && config.oauth.clientSecret));
    let ai = null;
    if (enabled) {
        if (client) ai = createAiClient(client, { baseUrl: cfg.aiUrl });
        else {
            const tokenClient = serviceAuth.createTokenClient({
                tokenUrl: `${config.networkInternalUrl}/oauth/token`,
                clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret,
                audience: 'openvibe.ai',
                scope: 'ai.run.create ai.run.read',
                fetchImpl,
            });
            ai = createAiClient(createClient({ baseUrl: cfg.aiUrl, tokenProvider: tokenClient, fetch: fetchImpl, retries: 0 }), { baseUrl: cfg.aiUrl });
        }
    }
    const day = () => new Date(s.now()).toISOString().slice(0, 10);

    async function usage() {
        const row = await s.db.maybe('SELECT calls, cost_usd FROM meme_research_usage WHERE day = $1', [day()]);
        return { day: day(), calls: row ? Number(row.calls) || 0 : 0, cost_usd: row ? Number(row.cost_usd) || 0 : 0 };
    }

    async function reserve(calls = 1) {
        if (!enabled) return { ok: false, status: 503, code: 'meme.ai_unavailable', message: 'OpenVibe.AI is not configured (OV_AI_INTERNAL_URL and OV_OAUTH_CLIENT_SECRET).' };
        const used = await usage();
        if (used.calls + calls > cfg.dailyCalls) return { ok: false, status: 429, code: 'meme.ai_budget', message: `The daily research call budget (${cfg.dailyCalls}) is used up; try again tomorrow.` };
        if (cfg.dailyBudgetUsd > 0 && used.cost_usd >= cfg.dailyBudgetUsd) return { ok: false, status: 429, code: 'meme.ai_budget', message: `The daily research budget ($${cfg.dailyBudgetUsd}) is used up; try again tomorrow.` };
        await s.db.exec(
            `INSERT INTO meme_research_usage (day, calls, cost_usd, updated_at) VALUES ($1::date, $2, 0, now())
             ON CONFLICT (day) DO UPDATE SET calls = meme_research_usage.calls + EXCLUDED.calls, updated_at = now()`,
            [day(), calls],
        );
        return { ok: true };
    }

    async function charge(costUsd) {
        const cost = Math.max(0, Number(costUsd) || 0);
        if (!cost) return;
        await s.db.exec(
            `INSERT INTO meme_research_usage (day, calls, cost_usd, updated_at) VALUES ($1::date, 0, $2, now())
             ON CONFLICT (day) DO UPDATE SET cost_usd = meme_research_usage.cost_usd + EXCLUDED.cost_usd, updated_at = now()`,
            [day(), cost],
        );
    }

    async function waitFor(run) {
        const until = Date.now() + cfg.waitMs;
        let current = run;
        while (!TERMINAL.has(current.status)) {
            if (Date.now() >= until) throw Object.assign(new Error(`AI run ${current.id} still ${current.status}`), { code: 'ai.timeout' });
            await new Promise((r) => setTimeout(r, 500));
            const got = await ai.runs.get(current.id);
            current = got && (got.run || got);
            if (!current) throw Object.assign(new Error(`AI run ${run.id} disappeared`), { code: 'ai.lost' });
        }
        return current;
    }

    async function run(workflow, input, { calls = 1 } = {}) {
        const reserved = await reserve(calls);
        if (!reserved.ok) return reserved;
        let run;
        try {
            const created = await ai.runs.create(workflow, input, { wait: cfg.waitMs });
            run = created.run || created;
            if (!TERMINAL.has(run.status)) run = await waitFor(run);
        } catch (err) {
            log.warn(`[OpenVibe.Meme] AI ${workflow} failed: ${err && err.message ? err.message.slice(0, 200) : err}`);
            return { ok: false, status: 502, code: 'meme.ai_failed', message: `OpenVibe.AI could not run ${workflow}.` };
        }
        const cost = Number(run.cost_usd != null ? run.cost_usd : (run.usage && run.usage.cost_usd) || 0) || 0;
        await charge(cost);
        if (run.status !== 'succeeded') return { ok: false, status: 502, code: 'meme.ai_failed', message: `OpenVibe.AI run ${run.id} ended ${run.status}.`, run };
        return { ok: true, run, output: run.output || {}, citations: run.citations || [], costUsd: cost };
    }

    return { enabled, run, reserve, charge, usage };
}

module.exports = { createResearchAi, TERMINAL };
