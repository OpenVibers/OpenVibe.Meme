'use strict';

/**
 * The one outbound HTTP helper the open-source jobs share: identify every request, pace it per host, keep the
 * answer's fetch time, and turn a failure into a short, non-secret error. The URLs come from config (the official
 * public hosts); no user-chosen URL is ever fetched.
 */
const { setTimeout: sleep } = require('node:timers/promises');

function hostOf(url) {
    try { return new URL(url).host; } catch { return String(url); }
}

/** Serialise requests per host, at least minIntervalMs apart (the Wikimedia API policy asks for it). */
function createPacer(minIntervalMs = 0) {
    const last = new Map();
    let chain = Promise.resolve();
    return function pace(url) {
        const host = hostOf(url);
        const run = chain.then(async () => {
            const wait = Math.max(0, (last.get(host) || 0) + minIntervalMs - Date.now());
            if (wait) await sleep(wait);
            last.set(host, Date.now());
        });
        chain = run.catch(() => {});
        return run.then(() => () => {});
    };
}

class SourceError extends Error {
    constructor(message, { code = 'meme.source', status = 502 } = {}) {
        super(message);
        this.name = 'SourceError';
        this.code = code;
        this.status = status;
    }
}

/**
 * fetchText(url, { fetchImpl, userAgent, headers, timeoutMs, pace, retries })
 * Returns { text, status, url, fetchedAt }. Retries 429/5xx twice with a short backoff; a 4xx (except 429) is final.
 */
async function fetchText(url, opts = {}) {
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const headers = {
        'User-Agent': opts.userAgent || 'OpenVibe.Meme/0.2 (+https://openvibe.meme; contact@openvibe.network)',
        Accept: opts.accept || 'application/json, text/plain;q=0.9, */*;q=0.5',
        ...(opts.headers || {}),
    };
    const retries = Number.isFinite(opts.retries) ? opts.retries : 2;
    let release = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (opts.pace && !release) release = await opts.pace(url);
        try {
            const res = await fetchImpl(url, {
                method: opts.method || 'GET',
                headers,
                body: opts.body,
                signal: AbortSignal.timeout(Math.max(1000, Number(opts.timeoutMs) || 20_000)),
                redirect: 'follow',
            });
            const text = await res.text();
            if (res.ok) {
                if (release) { release(); release = null; }
                return { text, status: res.status, url, fetchedAt: new Date().toISOString() };
            }
            lastErr = new SourceError(`${opts.label || hostOf(url)} answered ${res.status}`, { status: res.status === 404 ? 404 : 502 });
            if (res.status === 429 || res.status >= 500) {
                if (release) { release(); release = null; }
                if (attempt < retries) {
                    const retryAfter = Number(opts.headers && opts.headers.get && opts.headers.get('retry-after'));
                    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(10_000, retryAfter * 1000) : 800 * (attempt + 1));
                    continue;
                }
            }
            if (release) { release(); release = null; }
            throw lastErr;
        } catch (err) {
            if (release) { release(); release = null; }
            lastErr = err instanceof SourceError ? err : new SourceError(`${opts.label || hostOf(url)}: ${(err && err.message) || 'request failed'}`);
            if (attempt < retries) { await sleep(600 * (attempt + 1)); continue; }
            throw lastErr;
        }
    }
    throw lastErr || new SourceError(`${opts.label || hostOf(url)}: request failed`);
}

async function fetchJson(url, opts = {}) {
    const out = await fetchText(url, opts);
    try { return { ...out, json: JSON.parse(out.text) }; } catch { throw new SourceError(`${opts.label || hostOf(url)} answered something that is not JSON`); }
}

module.exports = { createPacer, fetchText, fetchJson, SourceError, hostOf };
