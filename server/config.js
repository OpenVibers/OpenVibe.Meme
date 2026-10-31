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

        // The candidate importer: every 30 minutes, off under MEME_DRILL (tests call runOnce()).
        importer: {
            intervalMs: Math.max(60_000, int(env.MEME_IMPORTER_INTERVAL_MS, 30 * 60_000)),
            minUses: Math.max(2, int(env.MEME_IMPORTER_MIN_USES, 2)),
            minDays: Math.max(2, int(env.MEME_IMPORTER_MIN_DAYS, 2)),
            maxTopics: Math.min(50, Math.max(1, int(env.MEME_IMPORTER_MAX_TOPICS, 12))),
            maxVods: Math.min(50, Math.max(1, int(env.MEME_IMPORTER_MAX_VODS, 12))),
            maxCandidates: Math.min(30, Math.max(1, int(env.MEME_IMPORTER_MAX_CANDIDATES, 10))),
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

        // Every citation is re-verified daily, off under MEME_DRILL.
        reverify: { intervalMs: Math.max(60_000, int(env.MEME_REVERIFY_INTERVAL_MS, 24 * 60 * 60_000)) },
    };
}

module.exports = { load };
