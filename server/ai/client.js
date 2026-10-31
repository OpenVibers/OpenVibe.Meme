'use strict';

/**
 * OpenVibe.Meme's only model gateway: OpenVibe.AI's `generate` operation, called as the first-party service `meme`
 * with a client-credentials token (audience openvibe.ai, scope ai.run.create). Network grants the token and the
 * `ai.*` namespace lets it run `ai.generate` — the same path Live and Design take.
 *
 * Nothing here knows about memes: the client takes a prompt and a system message and answers the text. The judge
 * (server/ai/judge.js) is what asks a question and reads an answer.
 *
 * A run that never finishes is an error, not a hang: every call carries a deadline. AI's routing is the authority —
 * Meme never names a provider, so a pool's choice is what actually answered, and that is what is recorded.
 */
const { serviceAuth } = require('openvibe-contracts');

class MemeAiError extends Error {
    constructor(status, code, detail) {
        super(detail || code);
        this.name = 'MemeAiError';
        this.status = status;
        this.code = code;
        this.detail = detail || code;
    }
}

/** The JSON a model usually meant: a fenced block, a stray sentence around it, or a truncated tail. */
function parseJsonLoose(text) {
    if (!text) return null;
    const raw = String(text).trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1].trim() : raw;
    try { return JSON.parse(body); } catch { /* not JSON on its own */ }
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(body.slice(start, end + 1)); } catch { /* not JSON either */ }
    }
    return null;
}

function createMemeAi({ config, fetchImpl = globalThis.fetch, log = console }) {
    const ai = config.ai || {};
    const tokenClient = config.oauth.clientSecret
        ? serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl || config.networkUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: ai.audience,
            scope: ai.scope,
            fetchImpl,
        })
        : null;
    const enabled = Boolean(ai.url && tokenClient);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function call(method, path, body, { retried = false } = {}) {
        if (!enabled) throw new MemeAiError(503, 'meme.ai_not_configured', 'OpenVibe.AI is not configured for OpenVibe.Meme.');
        let headers;
        try {
            headers = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokenClient.authHeaders()) };
        } catch (err) {
            throw new MemeAiError(502, 'meme.ai_token_failed', 'OpenVibe.Network did not issue an AI token for Meme.');
        }
        let res;
        try {
            res = await fetchImpl(`${String(ai.url).replace(/\/+$/, '')}${path}`, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(ai.timeoutMs),
            });
        } catch (err) {
            throw new MemeAiError(502, 'meme.ai_unreachable', err && err.name === 'TimeoutError'
                ? 'OpenVibe.AI did not answer in time.'
                : 'OpenVibe.AI could not be reached.');
        }
        if (res.status === 401 && !retried) {
            tokenClient.invalidate();
            return call(method, path, body, { retried: true });
        }
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            const code = (json && (json.code || json.error)) || `meme.ai_http_${res.status}`;
            const detail = (json && (json.detail || json.message)) || `OpenVibe.AI refused the run (${res.status}).`;
            throw new MemeAiError(res.status >= 500 ? 502 : res.status, String(code).slice(0, 80), String(detail).slice(0, 500));
        }
        return json;
    }

    /** The run's answer, however the run finished. */
    async function waitFor(run, startedAt) {
        let r = run;
        const deadline = Date.now() + ai.timeoutMs;
        while (r && ['queued', 'running'].includes(r.status)) {
            if (!r.id) throw new MemeAiError(502, 'meme.ai_bad_answer', 'OpenVibe.AI answered with a running run that has no id.');
            if (Date.now() > deadline) throw new MemeAiError(504, 'meme.ai_timeout', `The AI run ${r.id} did not finish in time.`);
            await sleep(ai.pollMs);
            const body = await call('GET', `/api/v1/runs/${encodeURIComponent(r.id)}`);
            r = body && body.run ? body.run : body;
        }
        if (!r) throw new MemeAiError(502, 'meme.ai_bad_answer', 'OpenVibe.AI answered without a run.');
        const done = ['succeeded', 'cached', 'completed', 'ok'].includes(r.status)
            || (r.status == null && r.output != null && !r.error);
        if (!done) {
            const e = r.error || {};
            throw new MemeAiError(502, 'meme.ai_run_failed', `The AI run ${r.id || '?'} ${r.status || 'did not finish'}${e.code ? ` (${e.code}: ${e.detail || ''})` : ''}.`);
        }
        return r;
    }

    /** The text of a run's output, whatever the workflow wrapped it in. */
    function textOf(output) {
        if (typeof output === 'string') return output;
        if (!output || typeof output !== 'object') return '';
        for (const k of ['text', 'content', 'body']) if (typeof output[k] === 'string') return output[k];
        if (output.message && typeof output.message.content === 'string') return output.message.content;
        if (Array.isArray(output.choices) && output.choices[0] && typeof output.choices[0].message === 'object') {
            return String(output.choices[0].message.content || '');
        }
        return '';
    }

    /**
     * One run of ai.generate. Answers { text, model, provider, run_id, ms, tokens, cost_usd }.
     * The target names the work, so a run in AI's list says what it was for.
     */
    async function generate({ prompt, system = '', maxTokens = null, temperature = null, target = null, wait = null }) {
        if (!enabled) throw new MemeAiError(503, 'meme.ai_not_configured', 'OpenVibe.AI is not configured for OpenVibe.Meme.');
        const body = {
            prompt: String(prompt || ''),
            ...(system ? { system: String(system) } : {}),
            max_tokens: maxTokens || ai.maxTokens,
            temperature: temperature == null ? ai.temperature : temperature,
            options: { cache: false },
            ...(target ? { target } : {}),
        };
        const startedAt = Date.now();
        const waitMs = Math.min(wait || ai.waitMs, 60_000);
        let created;
        try {
            created = await call('POST', `/api/v1/generate?wait=${waitMs}`, body);
        } catch (err) {
            if (!err || err.status !== 404) throw err;
            // A deployment that exposes the run API but not the convenience operation: the same run, by workflow.
            created = await call('POST', `/api/v1/runs?wait=${waitMs}`, {
                workflow: 'ai.generate',
                input: { prompt: body.prompt, ...(body.system ? { system: body.system } : {}), max_tokens: body.max_tokens, temperature: body.temperature },
                options: body.options,
                ...(target ? { target } : {}),
            });
        }
        const first = created && created.run ? created.run : created;
        const run = await waitFor(first, startedAt);
        const text = textOf(run.output);
        const usage = run.usage || {};
        const prov = run.provenance || {};
        const tokens = usage.tokens && typeof usage.tokens === 'object'
            ? (Number(usage.tokens.input) || 0) + (Number(usage.tokens.output) || 0)
            : (Number(usage.tokens_in) || 0) + (Number(usage.tokens_out) || 0)
                || (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0)
                || (Number(run.tokens) || 0);
        return {
            text: String(text || ''),
            model: String(prov.model || run.model || (run.output && run.output.model) || 'unknown').slice(0, 120),
            provider: String(prov.provider || run.provider || (run.output && run.output.provider) || 'ai').slice(0, 80),
            run_id: run.id || null,
            ms: Math.max(0, Date.now() - startedAt),
            tokens: Math.max(0, Math.round(tokens)),
            cost_usd: Number(usage.cost_usd != null ? usage.cost_usd : (usage.cost != null ? usage.cost : (run.cost_usd || 0))) || 0,
        };
    }

    /** One run, asked for JSON, repaired when the model fences it or adds a sentence. */
    async function json({ prompt, system = '', schema = null, temperature = null, target = null }) {
        const ask = schema
            ? `${prompt}\n\nAnswer with one JSON object and nothing else, with exactly these keys: ${Object.keys(schema).join(', ')}.\nThe shape is:\n${JSON.stringify(schema)}`
            : `${prompt}\n\nAnswer with one JSON object and nothing else.`;
        const out = await generate({ prompt: ask, system, temperature: temperature == null ? 0 : temperature, target });
        const parsed = parseJsonLoose(out.text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new MemeAiError(502, 'meme.ai_not_json', 'The AI run did not answer with a JSON object.');
        }
        return { ...out, data: parsed };
    }

    return { enabled, generate, json, parseJsonLoose, MemeAiError };
}

module.exports = { createMemeAi, parseJsonLoose, MemeAiError };
