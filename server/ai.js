'use strict';

/**
 * OpenVibe.AI for Meme, inside a daily budget. Every call is a registered workflow run:
 *
 *   pics.describe_image   the vision call: what the picture actually shows
 *   ai.extract            the structured call: template, origins, meaning, usage, labels, comment tone
 *   research.gather       M5's evidence pack (not used here)
 *   ai.generate           M5/M6's long read and captions
 *
 * The budget is a per-UTC-day row in meme_ai_usage: calls are reserved before a run starts, the run's stated cost
 * is added when it finishes. A refusal is 429 meme.ai_budget. Without OV_AI_INTERNAL_URL and the Network client
 * secret the runner is off and the analyzer answers 503 meme.ai_unavailable.
 */
const { serviceAuth } = require('openvibe-contracts');
const { createClient } = require('openvibe-sdk/core');
const { createAiClient } = require('openvibe-sdk/ai');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function createAiRunner({ config, s, fetchImpl = globalThis.fetch, log = console, client = null, budget: injectedBudget = null }) {
    // The runner's URL is its own: the judge has a local default address, but this runner is off unless AI is
    // configured explicitly, so a Meme without AI answers meme.ai_unavailable instead of calling nothing.
    const aiUrl = (config.ai && config.ai.runnerUrl) || '';
    const enabled = Boolean(client || (aiUrl && config.oauth && config.oauth.clientSecret));
    let ai = null;
    if (enabled) {
        if (client) ai = createAiClient(client, { baseUrl: aiUrl || config.ai.url });
        else {
            const tokenClient = serviceAuth.createTokenClient({
                tokenUrl: `${config.networkInternalUrl}/oauth/token`,
                clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret,
                audience: 'openvibe.ai',
                scope: 'ai.run.create ai.run.read',
                fetchImpl,
            });
            ai = createAiClient(createClient({ baseUrl: aiUrl, tokenProvider: tokenClient, fetch: fetchImpl, retries: 0 }), { baseUrl: aiUrl });
        }
    }

    const budget = injectedBudget || createBudget({ config, s });
    const day = () => new Date(s.now()).toISOString().slice(0, 10);

    async function usage() {
        const row = await s.db.maybe('SELECT calls, cost_usd FROM meme_ai_usage WHERE day = $1', [day()]);
        return { day: day(), calls: row ? Number(row.calls) || 0 : 0, cost_usd: row ? Number(row.cost_usd) || 0 : 0 };
    }

    /** Reserve `calls` before starting; returns a refusal when the day's budget is already spent. */
    async function reserve(calls = 1, kind = 'analyze') {
        if (!enabled) return { ok: false, status: 503, code: 'meme.ai_unavailable', message: 'OpenVibe.AI is not configured (OV_AI_INTERNAL_URL and OV_OAUTH_CLIENT_SECRET).' };
        const used = await usage();
        if (used.calls + calls > config.ai.dailyCalls) return { ok: false, status: 429, code: 'meme.ai_budget', message: `The daily AI call budget (${config.ai.dailyCalls}) is used up; try again tomorrow.` };
        if (config.ai.dailyBudgetUsd > 0 && used.cost_usd >= config.ai.dailyBudgetUsd) return { ok: false, status: 429, code: 'meme.ai_budget', message: `The daily AI budget ($${config.ai.dailyBudgetUsd}) is used up; try again tomorrow.` };
        await s.db.exec(
            `INSERT INTO meme_ai_usage (day, kind, calls, cost_usd, updated_at) VALUES ($1::date, $3, $2, 0, now())
             ON CONFLICT (day, kind) DO UPDATE SET calls = meme_ai_usage.calls + EXCLUDED.calls, updated_at = now()`,
            [day(), calls, kind],
        );
        return { ok: true };
    }

    async function charge(costUsd, kind = 'analyze') {
        const cost = Math.max(0, Number(costUsd) || 0);
        if (!cost) return;
        await s.db.exec(
            `INSERT INTO meme_ai_usage (day, kind, calls, cost_usd, updated_at) VALUES ($1::date, $3, 0, $2, now())
             ON CONFLICT (day, kind) DO UPDATE SET cost_usd = meme_ai_usage.cost_usd + EXCLUDED.cost_usd, updated_at = now()`,
            [day(), cost, kind],
        );
    }

    async function waitFor(run, waitMs) {
        const until = Date.now() + waitMs;
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

    /** Run one workflow. → { ok, run, output, citations, costUsd } or a refusal. */
    async function run(workflow, input, { calls = 1, waitMs = null, kind = 'analyze' } = {}) {
        const reserved = await reserve(calls, kind);
        if (!reserved.ok) return reserved;
        let run;
        try {
            const created = await ai.runs.create(workflow, input, { wait: waitMs == null ? config.ai.waitMs : waitMs });
            run = created.run || created;
            if (!TERMINAL.has(run.status)) run = await waitFor(run, config.ai.waitMs);
        } catch (err) {
            log.warn(`[OpenVibe.Meme] AI ${workflow} failed: ${err && err.message ? err.message.slice(0, 200) : err}`);
            return { ok: false, status: 502, code: 'meme.ai_failed', message: `OpenVibe.AI could not run ${workflow}.` };
        }
        const cost = Number(run.cost_usd != null ? run.cost_usd : (run.usage && run.usage.cost_usd) || 0) || 0;
        await charge(cost, kind);
        if (run.status !== 'succeeded') {
            return { ok: false, status: 502, code: 'meme.ai_failed', message: `OpenVibe.AI run ${run.id} ended ${run.status}.`, run };
        }
        return { ok: true, run, output: run.output || {}, citations: run.citations || [], costUsd: cost };
    }

    return { enabled, run, reserve, charge, usage, day };
}

/** The budget bookkeeping alone, so a test can drive it without AI. */
function createBudget({ config, s }) {
    return {
        async usage() {
            const day = new Date(s.now()).toISOString().slice(0, 10);
            const row = await s.db.maybe('SELECT calls, cost_usd FROM meme_ai_usage WHERE day = $1', [day]);
            return { day, calls: row ? Number(row.calls) || 0 : 0, cost_usd: row ? Number(row.cost_usd) || 0 : 0 };
        },
        limits: { calls: config.ai.dailyCalls, budget_usd: config.ai.dailyBudgetUsd },
    };
}

module.exports = { createAiRunner, createBudget, TERMINAL };
