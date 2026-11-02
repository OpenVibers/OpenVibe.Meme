'use strict';

/**
 * OpenVibe.Meme configuration. Every value comes from the environment (production: /etc/openvibe/meme.env,
 * see .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 5120);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.meme' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'meme',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        drill: env.MEME_DRILL === '1' || env.MEME_DRILL === 'true',
        limits: {
            minute: Math.max(1, int(env.MEME_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.MEME_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (MEME_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.MEME_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:meme:' },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        audience: env.MEME_AUDIENCE || 'openvibe.meme',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'meme',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },

        // OpenVibe.Events → this service's account export/deletion route. The secret signs a delivery
        // (comma-separated for rotation, 32+ characters each); unset turns POST /internal/events off (503).
        events: {
            secrets: String(env.MEME_EVENTS_SECRET || '').split(',').map((x) => x.trim()).filter(Boolean),
            url: trim(env.MEME_EVENTS_URL || env.EVENTS_URL || ''),
            endpoint: env.MEME_EVENTS_ENDPOINT || '',
            intervalMs: Math.max(500, int(env.MEME_EVENTS_INTERVAL_MS, 5000)),
            scope: env.MEME_EVENTS_SCOPE || 'events.event.publish',
        },

        // The public APIs the importer reads. No service grant is used in v1: these are the anonymous reads a
        // person can make too (OpenVibe.Live's Rundown and transcripts, OpenVibe.Chat's history and timeline).
        upstreams: {
            chat: trim(env.OV_CHAT_URL || env.OV_CHAT_INTERNAL_URL || 'https://openvibe.chat'),
            live: trim(env.OV_LIVE_URL || env.OV_LIVE_INTERNAL_URL || 'https://openvibe.live'),
            video: trim(env.OV_VIDEO_URL || 'https://openvibe.video'),
            timeoutMs: Math.max(500, int(env.MEME_UPSTREAM_TIMEOUT_MS, 8000)),
        },

        // OpenVibe.AI: the judge and the encyclopedia's writing pass. Meme calls ai.generate as the service
        // `meme` with a client-credentials token (audience openvibe.ai, scope ai.run.create); Network grants the
        // token and the ai.* namespace. Meme never names a provider: AI's routing decides, and the run reports
        // what answered.
        ai: {
            url: trim(env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700'),
            audience: env.MEME_AI_AUDIENCE || 'openvibe.ai',
            scope: env.MEME_AI_SCOPE || 'ai.run.create',
            waitMs: Math.max(1000, int(env.MEME_AI_WAIT_MS, 55_000)),
            timeoutMs: Math.max(1000, int(env.MEME_AI_TIMEOUT_MS, 120_000)),
            pollMs: Math.max(100, int(env.MEME_AI_POLL_MS, 1500)),
            maxTokens: Math.max(200, int(env.MEME_AI_MAX_TOKENS, 1400)),
            temperature: 0.2,
            // The analyzer's runner (M4): off without an explicit AI URL, so a Meme without AI answers
            // meme.ai_unavailable instead of calling an address that is not there.
            runnerUrl: trim(env.OV_AI_INTERNAL_URL || env.OV_AI_URL || ''),
            dailyCalls: Math.max(1, int(env.MEME_AI_DAILY_CALLS, 200)),
            dailyBudgetUsd: Math.max(0, Number(env.MEME_AI_DAILY_BUDGET_USD || 5) || 0),
        },

        // The judge: it scores a candidate from its own citations and writes the entry. Only what clears the bar is
        // published; everything else stays hidden for staff with its score. Off under MEME_DRILL.
        judge: {
            intervalMs: Math.max(60_000, int(env.MEME_JUDGE_INTERVAL_MS, 30 * 60_000)),
            minScore: Number.isFinite(Number(env.MEME_JUDGE_MIN_SCORE)) ? Number(env.MEME_JUDGE_MIN_SCORE) : 0.75,
            minUses: Math.max(1, int(env.MEME_JUDGE_MIN_USES, 3)),
            minDays: Math.max(1, int(env.MEME_JUDGE_MIN_DAYS, 2)),
            minChannels: Math.max(1, int(env.MEME_JUDGE_MIN_CHANNELS, 2)),
            maxPerRun: Math.min(30, Math.max(1, int(env.MEME_JUDGE_MAX_PER_RUN, 10))),
            contextLines: Math.max(1, int(env.MEME_JUDGE_CONTEXT_LINES, 6)),
        },

        // OpenVibe.Media for a trend picture or a generated meme (object API v2, namespace `meme`). Off without
        // the internal URL and Network client secret; tests inject a stand-in.
        media: {
            url: trim(env.OV_MEDIA_INTERNAL_URL || env.OV_MEDIA_URL || ''),
            namespace: env.MEME_MEDIA_NAMESPACE || 'meme',
        },

        // Reddit's official API only (OAuth2 client credentials). The importer is off when either credential is
        // missing; tests inject a local Reddit.
        reddit: {
            clientId: env.MEME_REDDIT_CLIENT_ID || '',
            clientSecret: env.MEME_REDDIT_CLIENT_SECRET || '',
            userAgent: env.MEME_REDDIT_USER_AGENT || 'web:openvibe.meme:v0.3 (by /u/OpenVibe)',
            subreddits: String(env.MEME_REDDIT_SUBREDDITS || 'memes,dankmemes,MemeEconomy,wholesomememes')
                .split(',').map((x) => x.trim().replace(/^\/?r\//i, '')).filter(Boolean).slice(0, 12),
            intervalMs: Math.max(60_000, int(env.MEME_REDDIT_INTERVAL_MS, 15 * 60_000)),
            maxPosts: Math.min(100, Math.max(1, int(env.MEME_REDDIT_MAX_POSTS, 100))),
            minTemplatePosts: Math.min(20, Math.max(2, int(env.MEME_REDDIT_MIN_TEMPLATE_POSTS, 3))),
            maxImageBytes: Math.min(20 * 1024 * 1024, Math.max(64 * 1024, int(env.MEME_REDDIT_MAX_IMAGE_BYTES, 8 * 1024 * 1024))),
        },

        // Register the Reddit source with OpenVibe.Sources (sources.source.manage) when asked. Off by default:
        // a registry entry is a permission decision, not something a process should do on every boot.
        sources: {
            url: trim(env.OV_SOURCES_INTERNAL_URL || ''),
            register: env.MEME_SOURCES_REGISTER === '1' || env.MEME_SOURCES_REGISTER === 'true',
        },

        // The candidate importer: every 30 minutes, off under MEME_DRILL (tests call runOnce()).
        importer: {
            intervalMs: Math.max(60_000, int(env.MEME_IMPORTER_INTERVAL_MS, 30 * 60_000)),
            minUses: Math.max(2, int(env.MEME_IMPORTER_MIN_USES, 2)),
            minDays: Math.max(2, int(env.MEME_IMPORTER_MIN_DAYS, 2)),
            maxTopics: Math.min(50, Math.max(1, int(env.MEME_IMPORTER_MAX_TOPICS, 12))),
            maxVods: Math.min(50, Math.max(1, int(env.MEME_IMPORTER_MAX_VODS, 12))),
            maxCandidates: Math.min(30, Math.max(1, int(env.MEME_IMPORTER_MAX_CANDIDATES, 10))),
        },

        // Deep dives (M5): research.gather + ai.generate, with a daily budget of their own. Off without the AI URL
        // and the Network client secret.
        research: {
            aiUrl: trim(env.OV_AI_INTERNAL_URL || env.OV_AI_URL || ''),
            maxSources: Math.min(20, Math.max(2, int(env.MEME_RESEARCH_MAX_SOURCES, 12))),
            dailyCalls: Math.max(1, int(env.MEME_RESEARCH_DAILY_CALLS, 40)),
            dailyBudgetUsd: Math.max(0, Number(env.MEME_RESEARCH_DAILY_BUDGET_USD || 5) || 0),
            waitMs: Math.max(5_000, int(env.MEME_RESEARCH_WAIT_MS, 180_000)),
        },

        // The generator (M6): research the format's current uses, write captions, render a PNG. Off without AI;
        // Media is needed to store the PNG. The budget is checked before the first AI call.
        generate: {
            aiUrl: trim(env.OV_AI_INTERNAL_URL || env.OV_AI_URL || ''),
            mediaUrl: trim(env.OV_MEDIA_INTERNAL_URL || env.OV_MEDIA_URL || ''),
            mediaNamespace: env.MEME_MEDIA_NAMESPACE || 'meme',
            dailyCalls: Math.max(1, int(env.MEME_GENERATE_DAILY_CALLS, 60)),
            dailyBudgetUsd: Math.max(0, Number(env.MEME_GENERATE_DAILY_BUDGET_USD || 5) || 0),
            maxSources: Math.min(10, Math.max(1, int(env.MEME_GENERATE_MAX_SOURCES, 6))),
            waitMs: Math.max(5_000, int(env.MEME_GENERATE_WAIT_MS, 150_000)),
            maxPixels: Math.min(4096, Math.max(440, int(env.MEME_GENERATE_MAX_WIDTH, 1600))),
        },

        // Each person's share a day of the AI features (server/person-cap.js), on top of each one's daily budget for
        // everyone; staff are not capped. 0 turns a cap off.
        perPerson: {
            analyze: Math.max(0, int(env.MEME_ANALYZE_PER_PERSON_DAY, 20)),
            research: Math.max(0, int(env.MEME_RESEARCH_PER_PERSON_DAY, 3)),
            generate: Math.max(0, int(env.MEME_GENERATE_PER_PERSON_DAY, 15)),
        },

        // Every citation is re-verified daily, off under MEME_DRILL.
        reverify: { intervalMs: Math.max(60_000, int(env.MEME_REVERIFY_INTERVAL_MS, 24 * 60 * 60_000)) },

        // The encyclopedia: the well-known internet memes, cited to Wikipedia (CC BY-SA) and to Wikidata (CC0),
        // written by the same AI pass. It is a one-off seed, not a timer: the job runs from scripts/seed-classics.js.
        encyclopedia: {
            wikipedia: trim(env.MEME_WIKIPEDIA_URL || 'https://en.wikipedia.org'),
            wikidata: trim(env.MEME_WIKIDATA_URL || 'https://www.wikidata.org'),
            commons: trim(env.MEME_COMMONS_URL || 'https://commons.wikimedia.org'),
            userAgent: env.MEME_WIKI_USER_AGENT || 'OpenVibe.Meme/0.2 (+https://openvibe.meme; contact@openvibe.network)',
            timeoutMs: Math.max(1000, int(env.MEME_WIKI_TIMEOUT_MS, 20_000)),
            minIntervalMs: Math.max(0, int(env.MEME_WIKI_MIN_INTERVAL_MS, 250)),
            limit: Math.min(1000, Math.max(1, int(env.MEME_ENCYCLOPEDIA_LIMIT, 400))),
            // The lists the seeds are read from (Wikipedia, CC BY-SA): the phenomena list and the category behind it.
            lists: String(env.MEME_ENCYCLOPEDIA_LISTS || 'List_of_Internet_phenomena').split(',').map((x) => x.trim()).filter(Boolean),
            categories: String(env.MEME_ENCYCLOPEDIA_CATEGORIES || 'Internet memes,Memes').split(',').map((x) => x.trim()).filter(Boolean),
            minScore: Number.isFinite(Number(env.MEME_ENCYCLOPEDIA_MIN_SCORE)) ? Number(env.MEME_ENCYCLOPEDIA_MIN_SCORE) : 0.75,
        },

        // The templates: the well-known public-domain or freely licensed meme templates, from Wikimedia Commons,
        // each with its licence and credit.
        templates: {
            commons: trim(env.MEME_COMMONS_URL || 'https://commons.wikimedia.org'),
            userAgent: env.MEME_WIKI_USER_AGENT || 'OpenVibe.Meme/0.2 (+https://openvibe.meme; contact@openvibe.network)',
            timeoutMs: Math.max(1000, int(env.MEME_WIKI_TIMEOUT_MS, 20_000)),
            minIntervalMs: Math.max(0, int(env.MEME_WIKI_MIN_INTERVAL_MS, 250)),
            limit: Math.min(200, Math.max(1, int(env.MEME_TEMPLATES_LIMIT, 40))),
        },
    };
}

module.exports = { load };
