'use strict';

/**
 * OpenVibe.Meme — Express app factory; server/index.js listens, tests build their own instance with a temp
 * database and a mock Network.
 *
 *   /, /m/:slug, /week, /make, /c/:id, /developers        the pages (http/pages.js)
 *   /api/v1/*                                              the API (http/api.js)
 *   /auth/*                                                Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics       (loopback only)
 *   /internal/events                                       account export/deletion (loopback only)
 *
 * The importer and the citation re-verifier are made here but started by server/index.js (and never under
 * MEME_DRILL); tests drive their runOnce().
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createPrincipal } = require('./http/principal');
const { createApi } = require('./http/api');
const { createPageRoutes } = require('./http/pages');
const { createServiceReadiness } = require('./observability');
const { assetVersion, send } = require('./render/layout');
const { raw } = require('./render/html');

const accountDataLib = require('./identity/account-data');
const { createStore } = require('./store');
const { createSearchIndex } = require('./search');
const { createSearchRelay } = require('openvibe-publishing/search-relay');
const { createUpstreams } = require('./upstreams');
const { createImporter } = require('./importer');
const { createReverifier } = require('./reverify');
const { createMemeAi } = require('./ai/client');
const { createContext } = require('./ai/context');
const { createJudge } = require('./ai/judge');
const { createJudgeJob } = require('./jobs/judge');
const { createMediaStore } = require('./media');
const { createTrends } = require('./trends');
const { createRedditTrends } = require('./reddit');
const { createSourceRegistration } = require('./source-registration');
const { createAiRunner } = require('./ai');
const { createRedditReader } = require('./reddit-read');
const { createAnalyzer } = require('./analyze');
const { createResearchAi } = require('./research-ai');
const { createResearch } = require('./research');
const { createGenerateAi } = require('./generate-ai');
const { createGenerateMedia } = require('./generate-media');
const { createGenerator } = require('./generate');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { createServiceOutbox } = require('openvibe-sdk/events');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { createHttpTelemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink } = require('openvibe-sdk/telemetry');

/**
 * opts: config, store, now (clock), fetchImpl (Network and the public upstreams), log, valkey, accountSend (a
 * stand-in for Network's internal routes; tests only), telemetrySink.
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const s = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: s.now, log });
    const principal = createPrincipal({ config, keys });

    // The queued Search documents (meme_outbox) go to OpenVibe.Search's owner API with this service's token; off
    // without MEME_SEARCH_URL or the client secret. Started by server/index.js, never under MEME_DRILL.
    const searchRelay = createSearchRelay({
        db: s.db, table: 'meme_outbox', owner: 'meme', searchUrl: config.search.url, fetchImpl, now: s.now, log,
        auth: config.search.url && config.oauth.clientSecret ? contracts.serviceAuth.createTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
            audience: 'openvibe.search', scope: 'search.document.write', fetchImpl,
        }) : null,
    });
    const search = createSearchIndex({ config, s, onQueued: () => searchRelay.kick() });
    const eventOutbox = createServiceOutbox({ db: s.db, source: 'meme', eventsUrl: config.events.url,
        networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, intervalMs: config.events.intervalMs,
        now: s.now, fetch: fetchImpl, log, eventTypes: ['meme.caption.created'] });
    const entries = createStore(s, { search, eventOutbox });
    const upstreams = createUpstreams({ config, fetchImpl, log });
    const importer = createImporter({ config, s, entries, upstreams, fetchImpl, log });
    const reverifier = createReverifier({ config, s, entries, upstreams, log });
    // The judge: OpenVibe.AI scores each candidate from its own citations and writes the entry; the publish rule
    // decides what becomes public.
    const ai = createMemeAi({ config, fetchImpl, log });
    const context = createContext({ config, upstreams, log });
    const judge = createJudge({ config, ai, context, log });
    const judgeJob = createJudgeJob({ config, s, entries, judge, context, log });
    // Reddit trends: the official API, the templates it keeps discovering and the pictures it stores in Media.
    const media = opts.media || createMediaStore({ config, fetchImpl, log });
    const trends = createTrends({ s });
    const reddit = createRedditTrends({ config, s, media, fetchImpl, log, ...(opts.reddit || {}) });
    const sourceRegistration = createSourceRegistration({ config, fetchImpl, log });
    const aiRunner = opts.ai || createAiRunner({ config, s, fetchImpl, log, client: opts.aiClient, budget: opts.aiBudget });
    const redditReader = opts.redditReader || createRedditReader({ config, fetchImpl, ...(opts.redditRead || {}) });
    const analyzer = createAnalyzer({ config, s, ai: aiRunner, reddit: redditReader, fetchImpl, log });
    const researchAi = opts.researchAi || createResearchAi({ config, s, fetchImpl, log, client: opts.aiClient });
    const research = createResearch({ config, s, entries, ai: researchAi, log });
    const generateAi = opts.generateAi || createGenerateAi({ config, s, fetchImpl, log, client: opts.aiClient });
    const generateMedia = opts.generateMedia || createGenerateMedia({ config, fetchImpl, log, objects: opts.mediaObjects });
    const generator = createGenerator({ config, s, entries, ai: generateAi, media: generateMedia, fetchImpl, log });

    // Account export and deletion (ADR-033). The sender posts to Network's internal routes with this service's own
    // client-credentials token; a test injects a stand-in through opts.accountSend.
    const accountData = accountDataLib.create({ db: s.db, log });
    const accountSend = opts.accountSend || (config.oauth.clientSecret
        ? createNetworkSender({ networkInternalUrl: config.networkInternalUrl, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, fetch: fetchImpl })
        : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set: Meme cannot answer account events'); });

    const ctx = {
        config, s, keys, sso, principal, search, searchRelay, eventOutbox, entries, upstreams, importer, reverifier, accountData, accountSend, log,
        fetchImpl,
        ai: aiRunner, judgeAi: ai, context, judge, judgeJob,
        media, trends, reddit, sourceRegistration,
        redditReader, analyzer,
        researchAi, research,
        generateAi, generateMedia, generator,
    };

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'meme', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'meme', release: release.release });
    app.locals.metrics = metrics.registry;
    ctx.telemetry = createHttpTelemetry({ service: 'meme', sink: opts.telemetrySink || createPgTelemetrySink({ db: s.db, log }), skipPrefixes: ['/shared'], intervalMs: 60_000 });
    app.use(ctx.telemetry.middleware());
    app.locals.ctx = ctx;

    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;

    app.use(contracts.http.middleware());
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.quest', 'https://openvibe.chat', 'https://cloudflareinsights.com', 'https://openvibe.events'],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-meme', name: 'OpenVibe.Meme', version: VERSION }));
    release.mount(app, { registry: metrics.registry });
    const readiness = createServiceReadiness({ s, config, release: release.release, valkey, sso});
    app.get('/api/ready', readiness.handler);

    // ── Who is asking (verified offline; refreshed when expired) ──
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, skip: (req) => req.path === '/me' || req.path === '/navbar-token', standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'meme', service: 'meme', host: 'openvibe.meme', name: 'OpenVibe.Meme', profile: 'ugc' })); }

    // ── OpenVibe.Events → this service (loopback only) ──────
    // Account export/deletion; the consumer reads the raw body itself, so it is mounted before any body parser.
    // nginx answers 404 for /internal/.
    app.use('/internal/events', accountData.consumer({
        secrets: config.events.secrets,
        send: accountSend,
        now: s.now,
        onEvent: async (ev) => `ignored:${ev.event_type}`,
    }));

    // ── Static assets (content-hashed ?v= → immutable) ──────
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: Number(process.env.MEME_API_RATE_LIMIT_PER_MIN) || 240, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    app.use('/api/v1', createApi(ctx));
    // GET /openapi.json (SEO-3): the API as OpenAPI 3.1. It is not in openvibe-contracts, so the document is read from
    // the routes this app mounts under /api/, with the summaries the API files' header comments give them
    // (server/http/openapi-routes.js).
    {
        const d = require('./agent-descriptor');
        const site = String(config.baseUrl).replace(/\/+$/, '');
        app.get('/openapi.json', require('./http/openapi-routes').openapiRoute(app, {
            title: `${d.name} API`, description: d.purpose, version: require('../package.json').version, baseUrl: site,
            docs: `${site}/developers`,
            files: ['http/api.js'].map((f) => require('path').join(__dirname, f)),
        }));
    }
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.MEME_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));
    // ── Agent layer (openvibe-shared/agent-layer) ───────────
    // The manifest and the Markdown twins of the public pages. Gated to twin requests only, so a browser and a
    // page drawn for a signed-in person always reach the site's own routes; the twin renderer is signed out.
    {
        const agentLayer = require('openvibe-shared/agent-layer');
        const agent = express.Router();
        agent.use((req, _res, next) => {
            const twinPath = req.path.endsWith('.md');
            const twinFormat = req.query.format === 'markdown';
            const twinAccept = !!(req.headers.accept && req.accepts(['html', 'text/markdown']) === 'text/markdown');
            if (req.path === '/.well-known/agent.json' || twinPath || twinFormat || twinAccept) return next();
            return next('router');
        });
        agentLayer.mount(agent, { descriptor: require('./agent-descriptor'), render: require('./agent-pages').createAgentPages(ctx).renderPublicPage });
        app.use(agent);
    }
    app.use(createPageRoutes(ctx));
    app.use((req, res) => send(res, 404, {
        viewer: req.viewer, config, path: req.originalUrl, title: 'Not found',
        body: raw(require('./views').notFound()),
    }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        log.error('[OpenVibe.Meme]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov }) : res.status(413).type('text/plain').send('That request was too large.');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
