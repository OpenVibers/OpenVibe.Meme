'use strict';

/**
 * Register the Reddit source in OpenVibe.Sources (M3: "a Sources-registered importer"). This is the registry's
 * record of where the data comes from and on what terms. It is created **disabled**: Meme's own importer mints the
 * Reddit OAuth token, so Sources has no static credential it could fetch with. Registration is off unless
 * MEME_SOURCES_REGISTER=1 and OV_SOURCES_INTERNAL_URL is set, and a refusal is logged, never fatal to boot.
 */
const { serviceAuth } = require('openvibe-contracts');

const KEY = 'meme-reddit';

const RECORD = Object.freeze({
    key: KEY,
    name: 'Reddit memes and meme culture (official API)',
    type: 'api',
    category: 'news',
    homepage_url: 'https://www.reddit.com',
    endpoints: [{ url: 'https://oauth.reddit.com/r/memes/top', format: 'json', items_path: 'data.children' }],
    auth: { mode: 'none' },
    robots_note: 'No page is crawled. Meme reads oauth.reddit.com with its own OAuth2 client-credentials token and the app User-Agent; robots.txt is not a permission to bypass the API.',
    terms_note: 'Reddit Developer Terms and API terms: official API only, no scraping, no login/captcha walls, rate limits obeyed (OAuth2 client credentials). Post text and pictures remain their authors\'; the source URL is kept with every trend.',
    license_note: 'Reddit content stays its authors\' and is not relicensed; Meme stores scores, titles, links and a perceptual hash, and a picture only in OpenVibe.Media when that is configured.',
    min_interval_ms: 60_000,
    poll_interval_sec: 900,
    stale_after_sec: 3_600,
    max_items: 100,
    enabled: false,
    review_required: true,
    sensitivity: 'none',
    default_indexability: 'noindex',
    retire_after_sec: 7 * 86_400,
});

function createSourceRegistration({ config, fetchImpl = globalThis.fetch, log = console }) {
    const enabled = Boolean(config.sources && config.sources.register && config.sources.url && config.oauth && config.oauth.clientSecret);
    let tokenClient = null;
    if (enabled) {
        tokenClient = serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.sources',
            scope: 'sources.source.read sources.source.manage',
            fetchImpl,
        });
    }
    const base = () => String(config.sources.url).replace(/\/+$/, '');

    async function call(path, opts = {}) {
        const token = await tokenClient.getToken({ service: 'sources', audience: 'openvibe.sources' });
        const res = await fetchImpl(`${base()}${path}`, {
            ...opts,
            headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
            signal: AbortSignal.timeout(10_000),
        });
        return res;
    }

    /** Idempotent: an existing row is left alone; a 409 from a concurrent create is treated as registered. */
    async function ensure() {
        if (!enabled) return { enabled: false, registered: false };
        try {
            const one = await call(`/api/v1/sources/${KEY}`);
            if (one.ok) return { enabled: true, registered: true, created: false };
            if (one.status !== 404) {
                log.warn(`[OpenVibe.Meme] Sources lookup answered ${one.status}`);
                return { enabled: true, registered: false, status: one.status };
            }
            const created = await call('/api/v1/sources', { method: 'POST', body: JSON.stringify(RECORD) });
            if (created.ok || created.status === 409) return { enabled: true, registered: true, created: created.ok };
            const detail = await created.text().catch(() => '');
            log.warn(`[OpenVibe.Meme] Sources registration answered ${created.status}: ${detail.slice(0, 200)}`);
            return { enabled: true, registered: false, status: created.status };
        } catch (err) {
            log.warn(`[OpenVibe.Meme] Sources registration failed: ${err && err.message ? err.message.slice(0, 200) : err}`);
            return { enabled: true, registered: false, error: String(err && err.message || err) };
        }
    }

    return { enabled, ensure, record: RECORD };
}

module.exports = { createSourceRegistration, RECORD, KEY };
