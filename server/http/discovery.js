'use strict';

/**
 * Crawl artifacts for openvibe.meme: robots.txt, sitemap.xml, llms.txt and llms-full.txt. Public entries are for
 * search engines and AI crawlers; sign-in, the API, the internal route and a hidden entry are not. A sitemap also
 * lists every public entry page (/m/<slug>).
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Meme';
const DESCRIPTION = 'Explore an open meme encyclopedia: learn what memes mean, trace their origins and variations, and make your own with reusable templates.';
const DISALLOW = ['/auth/', '/api/', '/internal', '/metrics'];

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'EntertainmentApplication', keywords: 'internet memes, meme encyclopedia, meme origins, meme templates, meme maker' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

function publicPages() {
    return [
        { path: '/', changefreq: 'daily', priority: 1.0, title: 'OpenVibe.Meme home', text: 'An open meme encyclopedia with researched entries, a weekly favorite, and a caption maker.' },
        { path: '/browse', changefreq: 'daily', priority: 0.9, title: 'Explore internet memes', text: 'Search an open encyclopedia of internet memes, origins, variations, and reusable templates.' },
        { path: '/week', changefreq: 'daily', priority: 0.9, title: 'Meme of the week', text: 'This week’s candidates and the people’s vote.' },
        { path: '/make', changefreq: 'weekly', priority: 0.7, title: 'Meme maker', text: 'Pick a reusable template, write a caption, preview it, and export a PNG.' },
        { path: '/developers', changefreq: 'weekly', priority: 0.6, title: 'The OpenVibe.Meme API', text: 'The JSON API, the Search document and the importer’s public sources.' },
    ];
}

function createDiscoveryRoutes(ctx) {
    const { config, s } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });
    const pages = publicPages();

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.meme: the public entries are for search and AI crawlers; sign-in, the API and the internal route are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW })
            + `# Agent manifest: ${abs('/.well-known/agent.json')}\n`);
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            // AGT-5: each of Meme's own pages is linked at its Markdown twin (openvibe-shared 4.108.0 leaves files,
            // /api/ paths and other sites' links as they are). What an agent may skip is in `optional`, written last.
            markdown: true,
            base: site,
            summary: 'OpenVibe.Meme is an open encyclopedia of internet memes and a maker attached to each entry. Pages explain a format, cite its origin and spread, connect variations and related memes, and link reusable templates.',
            details: 'GET /browse searches the server-rendered internet-meme library. GET /api/v1/memes lists public internet memes; GET /api/v1/memes/:slug adds citations and the use timeline. GET /api/v1/templates lists reusable templates, and signed-in POST /api/v1/render returns a PNG. Live references enrich a known meme only when its name appears in a public transcript; stream catchphrases do not become meme entries.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Meme', url: abs('/'), note: 'internet meme encyclopedia and maker' },
                    { title: 'Explore memes', url: abs('/browse') },
                    { title: 'The ballot', url: abs('/week') },
                    { title: 'Meme maker', url: abs('/make') },
                    { title: 'The API', url: abs('/developers') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Public entries (JSON)', url: abs('/api/v1/entries') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
            ],
            // llmstxt.org's "## Optional": what an agent may skip when it needs a shorter context.
            optional: [
                { title: 'Sitemap', url: abs('/sitemap.xml') },
                { title: 'Full text for language models', url: abs('/llms-full.txt') },
                { title: 'OpenVibe.Chat', url: 'https://openvibe.chat', note: 'where a running joke is often typed first' },
                { title: 'OpenVibe.Live', url: 'https://openvibe.live', note: 'the Rundown and the VOD transcripts' },
                { title: 'OpenVibe.Video', url: 'https://openvibe.video', note: 'the canonical ?t= moment' },
                { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts and staff roles' },
            ],
        }));
    });

    r.get('/llms-full.txt', async (_req, res) => {
        const rows = await s.db.many("SELECT slug, title, summary, kind, status FROM meme_entries WHERE visibility = 'public' AND scope = 'internet' ORDER BY last_seen_at DESC LIMIT 2000");
        const entries = rows.map((e) => ({ url: `/m/${e.slug}`, title: e.title, text: [e.kind, e.status, e.summary].filter(Boolean).join(' · ') }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Meme: the home, the weekly ballot, the generator, the API and every public entry.',
            base: site,
            maxBytes: 512 * 1024,
            sections: [
                { title: 'Pages', pages: pages.map((p) => ({ url: p.path, title: p.title, text: p.text })) },
                { title: 'Entries', pages: entries },
            ],
        }));
    });

    r.get('/sitemap.xml', async (_req, res) => {
        const lastmod = siteUpdated();
        // An entry's licensed picture rides its <url> as an image sitemap entry (SEO-17), so image search can find it.
        const rows = await s.db.many("SELECT slug, updated_at, image_url FROM meme_entries WHERE visibility = 'public' AND scope = 'internet' ORDER BY slug LIMIT 5000");
        const urls = [
            ...pages.map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority })),
            ...rows.map((e) => ({ loc: abs(`/m/${e.slug}`), lastmod: dayOf(e.updated_at) || lastmod, changefreq: 'weekly', priority: 0.7,
                ...(/^https:\/\//.test(e.image_url || '') ? { images: [e.image_url] } : {}) })),
        ];
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
