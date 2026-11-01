'use strict';

/**
 * Meme's server-rendered pages. They work without JavaScript: forms are plain POSTs and every link is a real link.
 * Public pages are served `public, max-age=60` with Vary: Cookie; a page drawn for a signed-in person is
 * `private, no-store`.
 *
 *   /                 trending, meme of the week, the generator teaser
 *   /m/:slug          an entry: origin with its citation link, the use timeline, examples, the report form
 *   /week             this week's candidates and the vote form (POST /week/vote)
 *   /make             the caption generator form (POST /make) with a server-rendered preview (GET /make)
 *   /c/:id            one saved caption, text over the template image
 *   /developers       the API
 *   404               the not-found page
 */
const express = require('express');
const seo = require('openvibe-shared/seo');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, notice } = require('../render/html');
const { send, SITE_NAME } = require('../render/layout');
const { isStaff } = require('../identity/staff');
const { currentWeek } = require('../week');
const views = require('../views');

const PUBLIC_CACHE = 'public, max-age=60';

function createPageRoutes(ctx) {
    const { config, s, entries } = ctx;
    const r = asyncRouter();
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const staffViewer = (req) => isStaff(req.viewer);
    const signInPrompt = (what, next) => html`<div class="notice">${what} <a href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a>.</div>`;
    const notFromHere = (req, res) => page(req, res, { title: 'Not from this site', body: raw(html`<div class="mm-wrap mm-page-pad mm-narrow"><div class="mm-empty"><h1>That came from somewhere else</h1><p class="mm-muted">Use the form on <a href="/">OpenVibe.Meme</a>.</p></div></div>`) }, 403);

    async function counts() {
        const rows = await s.db.many("SELECT COUNT(*)::int AS entries, (SELECT COUNT(*)::int FROM meme_citations c JOIN meme_entries e ON e.id = c.entry_id WHERE e.visibility = 'public') AS citations FROM meme_entries WHERE visibility = 'public'");
        return rows[0] || { entries: 0, citations: 0 };
    }

    // ── Home ─────────────────────────────────────────────────
    r.get('/', async (req, res) => {
        const { week } = currentWeek(s.now());
        const [trending, weekOut, c] = await Promise.all([entries.trending({ limit: 8 }), entries.week({ week }), counts()]);
        return page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: null,
            description: 'The open meme database, rebuilt with AI: every entry cites the moment it happened, follows its later uses, and people vote for meme of the week.',
            jsonLd: homeJsonLd(config),
            body: raw(views.home({ trending, week: weekOut, counts: c })),
        });
    });

    // ── One entry ────────────────────────────────────────────
    /** A search result and share-card line: the entry's own summary or first use, cut at a word to 155 characters. */
    function metaDescription(e, citations = []) {
        const origin = citations.find((c) => c.role === 'origin') || citations[0] || null;
        const own = [e.summary, origin && origin.quote_text]
            .map((v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''))
            .find((v) => v.length >= 40);
        if (!own) return `${e.title}: where the joke started, how it spread, and every use on OpenVibe.`;
        if (own.length <= 155) return own;
        const cut = own.slice(0, 154);
        const at = cut.lastIndexOf(' ');
        return `${(at > 40 ? cut.slice(0, at) : cut).replace(/[\s,;:.!?-]+$/, '')}…`;
    }

    async function entryPage(req, res, { problem = null } = {}) {
        const slug = String(req.params.slug || '');
        const row = await entries.bySlug(slug);
        const staff = staffViewer(req);
        if (!row || (row.visibility === 'hidden' && !staff)) return notFound(req, res);
        const citations = await entries.citations(row.id);
        const e = entries.wireEntry(row);
        const description = metaDescription(e, citations);
        const jsonLd = seo.jsonLd.webPage({
            name: e.title,
            url: `${base()}/m/${e.slug}`,
            description,
            siteUrl: base(),
        });
        return page(req, res, {
            index: e.visibility === 'public',
            cache: e.visibility === 'public' ? PUBLIC_CACHE : null,
            title: e.title,
            description,
            jsonLd: [jsonLd],
            body: raw(views.entry({ e, citations, signedIn: Boolean(signedIn(req)), staff, reported: req.query.reported === '1', problem })),
        });
    }
    r.get('/m/:slug', (req, res) => entryPage(req, res));

    r.post('/m/:slug/report', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/m/${req.params.slug}`)}`);
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const row = await entries.bySlug(String(req.params.slug || ''));
        if (!row || row.visibility !== 'public') return notFound(req, res);
        const b = req.body || {};
        const kind = b.kind === 'takedown' || b.kind === 'correction' ? b.kind : null;
        if (!kind) return entryPage(req, res, { problem: 'Choose a takedown or a correction.' });
        const reason = String(b.reason == null ? '' : b.reason).replace(/\s+/g, ' ').trim();
        if (reason.length < 3 || reason.length > 2000) return entryPage(req, res, { problem: 'The reason must be 3 to 2000 characters.' });
        const note = b.note == null || b.note === '' ? null : String(b.note).trim().slice(0, 4000);
        const out = await entries.createReport({ entryId: row.id, subject: req.viewer.subject, kind, reason, note });
        if (!out.ok) return entryPage(req, res, { problem: out.message || 'That report could not be saved.' });
        return res.redirect(303, `/m/${encodeURIComponent(row.slug)}?reported=1`);
    });

    // ── Meme of the week ────────────────────────────────────
    r.get('/week', async (req, res) => {
        const { week } = currentWeek(s.now());
        const subject = signedIn(req) ? req.viewer.subject : null;
        const out = await entries.week({ week, subject });
        return page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'Meme of the week',
            description: 'This ISO week’s candidates for meme of the week and the people’s vote.',
            body: raw(views.week({ out, signedIn: Boolean(subject), voted: req.query.voted === '1', error: req.query.error === '1' })),
        });
    });

    r.post('/week/vote', async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fweek');
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const entryId = req.body && typeof req.body.entry_id === 'string' ? req.body.entry_id.trim() : '';
        if (!entryId) return res.redirect(303, '/week?error=1');
        const { week } = currentWeek(s.now());
        const out = await entries.castVote({ subject: req.viewer.subject, entryId, week });
        return res.redirect(303, out.ok ? '/week?voted=1' : '/week?error=1');
    });

    // ── The caption generator ───────────────────────────────
    const LINES = [1, 2, 3, 4];
    function makeValues(src = {}) {
        const v = { template_id: src.template_id, visibility: src.visibility || 'public' };
        for (const i of LINES) v[`line${i}`] = String(src[`line${i}`] == null ? '' : src[`line${i}`]).slice(0, 120);
        return v;
    }
    async function renderMake(req, res, { values = {}, problem = null, status = 200 } = {}) {
        const templates = await entries.templates();
        const chosen = templates.find((t) => t.id === values.template_id) || templates[0] || null;
        const previewLines = LINES.map((i) => String(values[`line${i}`] || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const preview = chosen && previewLines.length ? { template: chosen, lines: previewLines } : null;
        return page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'Make a caption',
            description: 'Pick a template, type up to four lines and preview them over the image before saving.',
            body: raw(views.make({ templates, values: { ...values, template_id: chosen ? chosen.id : '' }, preview, signedIn: Boolean(signedIn(req)), problem })),
        }, status);
    }
    r.get('/make', async (req, res) => renderMake(req, res, { values: makeValues(req.query) }));
    r.post('/make', async (req, res) => {
        if (!signedIn(req)) return page(req, res, { title: 'Make a caption', body: raw(views.signIn({ title: 'Make a caption', text: 'A saved caption belongs to your OpenVibe account, so you can find it later.', next: '/make' })) }, 401);
        if (!sameOrigin(req, config.baseUrl)) return notFromHere(req, res);
        const values = makeValues(req.body || {});
        const lines = LINES.map((i) => values[`line${i}`]).filter((l) => String(l).trim());
        const out = await entries.createCaption({ subject: req.viewer.subject, templateId: values.template_id, lines, visibility: values.visibility });
        if (!out.ok) return renderMake(req, res, { values, problem: out.message || 'That caption could not be saved.', status: out.status || 400 });
        return res.redirect(303, `/c/${encodeURIComponent(out.caption.id)}`);
    });

    // ── One saved caption ───────────────────────────────────
    r.get('/c/:id', async (req, res) => {
        const c = await entries.captionById(String(req.params.id || ''));
        if (!c) return notFound(req, res);
        const mine = Boolean(signedIn(req) && req.viewer.subject === c.subject);
        if (c.visibility === 'hidden' && !mine && !staffViewer(req)) return notFound(req, res);
        const template = await entries.templateById(c.template_id);
        return page(req, res, {
            index: c.visibility === 'public',
            cache: c.visibility === 'public' ? PUBLIC_CACHE : null,
            title: template ? `A caption on ${template.name}` : 'A saved caption',
            description: c.lines.join(' / ').slice(0, 160),
            body: raw(views.caption({ caption: c, template, mine })),
        });
    });

    // ── Developers ──────────────────────────────────────────
    r.get('/developers', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: 'The OpenVibe.Meme API',
        description: 'The JSON API, the Search document and the public sources the importer reads.',
        jsonLd: [seo.jsonLd.webPage({ name: 'The OpenVibe.Meme API', url: `${base()}/developers`, description: 'The JSON API, the Search document and the public sources the importer reads.', siteUrl: base() })],
        body: raw(views.developers()),
    }));

    // ── Discovery ───────────────────────────────────────────
    r.use(createDiscoveryRoutes(ctx));

    function notFound(req, res) {
        return page(req, res, { title: 'Not found', body: raw(views.notFound()) }, 404);
    }

    return r;
}

module.exports = { createPageRoutes };
