'use strict';
// The public pages the agent layer serves as Markdown twins (openvibe-shared/agent-layer), rendered through the
// same views and layout as the HTML routes and always signed out: the entry report form, the week vote and a
// caption's owner controls never appear in a twin, and a hidden entry or caption has no twin at all.
const seo = require('openvibe-shared/seo');
const views = require('./views');
const { raw } = require('./render/html');
const { renderPage } = require('./render/layout');
const { homeJsonLd } = require('./http/discovery');
const { currentWeek } = require('./week');

function createAgentPages(ctx) {
    const { config, s, entries } = ctx;
    const base = () => String(config.baseUrl).replace(/\/+$/, '');
    const page = (path, o) => ({ html: renderPage({ viewer: { kind: 'anonymous' }, config, path, agentLayer: true, ...o }), title: o.title });

    async function counts() {
        const rows = await s.db.many("SELECT COUNT(*)::int AS entries, (SELECT COUNT(*)::int FROM meme_citations c JOIN meme_entries e ON e.id = c.entry_id WHERE e.visibility = 'public') AS citations FROM meme_entries WHERE visibility = 'public'");
        return rows[0] || { entries: 0, citations: 0 };
    }

    async function home() {
        const { week } = currentWeek(s.now());
        const [trending, weekOut, c] = await Promise.all([entries.trending({ limit: 8 }), entries.week({ week }), counts()]);
        return page('/', {
            index: true, title: null,
            description: 'The open meme database, rebuilt with AI: every entry cites the moment it happened, follows its later uses, and people vote for meme of the week.',
            jsonLd: homeJsonLd(config),
            body: raw(views.home({ trending, week: weekOut, counts: c })),
        });
    }

    async function make(query) {
        const templates = await entries.templates();
        const values = { template_id: query.get('template_id') || '', visibility: query.get('visibility') || 'public' };
        for (const i of [1, 2, 3, 4]) values[`line${i}`] = String(query.get(`line${i}`) || '').slice(0, 120);
        const chosen = templates.find((t) => t.id === values.template_id) || templates[0] || null;
        const previewLines = [1, 2, 3, 4].map((i) => String(values[`line${i}`] || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const preview = chosen && previewLines.length ? { template: chosen, lines: previewLines } : null;
        return page('/make', {
            index: true, title: 'Make a caption',
            description: 'Pick a template, type up to four lines and preview them over the image before saving.',
            body: raw(views.make({ templates, values: { ...values, template_id: chosen ? chosen.id : '' }, preview, signedIn: false, problem: null })),
        });
    }

    async function renderPublicPage(rawPath, { query } = {}) {
        const p = String(rawPath || '/').replace(/\/+$/, '') || '/';
        const q = query instanceof URLSearchParams ? query : new URLSearchParams();
        if (p === '/') return home();
        if (p === '/week') {
            const { week } = currentWeek(s.now());
            const out = await entries.week({ week });
            return page(p, {
                index: true, title: 'Meme of the week',
                description: 'This ISO week’s candidates for meme of the week and the people’s vote.',
                body: raw(views.week({ out, signedIn: false, voted: false, error: false })),
            });
        }
        if (p === '/make') return make(q);
        if (p === '/developers') {
            return page(p, {
                index: true, title: 'The OpenVibe.Meme API',
                description: 'The JSON API, the Search document and the public sources the importer reads.',
                jsonLd: [seo.jsonLd.webPage({ name: 'The OpenVibe.Meme API', url: `${base()}/developers`, description: 'The JSON API, the Search document and the public sources the importer reads.', siteUrl: base() })],
                body: raw(views.developers()),
            });
        }
        const entryMatch = p.match(/^\/m\/([^/]+)$/);
        if (entryMatch) {
            let slug;
            try { slug = decodeURIComponent(entryMatch[1]); } catch { return null; }
            const row = await entries.bySlug(slug);
            if (!row || row.visibility !== 'public') return null;
            const citations = await entries.citations(row.id);
            const e = entries.wireEntry(row);
            return page(p, {
                index: true, title: e.title,
                description: (e.summary || `${e.title} on OpenVibe.Meme`).slice(0, 160),
                jsonLd: [seo.jsonLd.webPage({ name: e.title, url: `${base()}/m/${e.slug}`, description: (e.summary || `${e.title} on OpenVibe.Meme`).slice(0, 160), siteUrl: base() })],
                body: raw(views.entry({ e, citations, signedIn: false, staff: false, reported: false, problem: null })),
            });
        }
        const captionMatch = p.match(/^\/c\/([^/]+)$/);
        if (captionMatch) {
            let id;
            try { id = decodeURIComponent(captionMatch[1]); } catch { return null; }
            const c = await entries.captionById(id);
            if (!c || c.visibility !== 'public') return null;
            const template = await entries.templateById(c.template_id);
            return page(p, {
                index: true,
                title: template ? `A caption on ${template.name}` : 'A saved caption',
                description: c.lines.join(' / ').slice(0, 160),
                body: raw(views.caption({ caption: c, template, mine: false })),
            });
        }
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
