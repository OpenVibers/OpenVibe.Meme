'use strict';
/**
 * The templates: the well-known meme templates from Wikimedia Commons. Each one keeps its licence, its credit and
 * the file page it came from, and a file whose licence forbids reuse is never seeded.
 */
const { boot, check, done } = require('./helpers/boot');
const { createTemplatesJob } = require('../server/templates/seed');

/** A stand-in for Wikimedia Commons. */
function commonsFetch({ license = 'CC BY-SA 4.0', mime = 'image/jpeg' } = {}) {
    return async (url) => {
        const u = new URL(url);
        const q = u.searchParams;
        const body = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), headers: new Map() });
        if (q.get('list') === 'search') {
            return body({ query: { search: [{ title: 'File:Drake Hotline Bling.jpg' }, { title: 'File:Other.jpg' }] } });
        }
        if (q.get('prop') === 'imageinfo') {
            const titles = String(q.get('titles') || '').split('|');
            return body({
                query: {
                    pages: titles.map((title) => ({
                        title,
                        imageinfo: [{
                            mime,
                            url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Drake.jpg',
                            thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Drake.jpg/800px-Drake.jpg',
                            extmetadata: {
                                LicenseShortName: { value: license },
                                LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
                                Artist: { value: '<a href="https://commons.wikimedia.org/wiki/User:Someone">Someone</a>' },
                            },
                        }],
                    })),
                },
            });
        }
        return body({});
    };
}

(async () => {
    await check('a template is seeded with its licence, its credit and its source page', async () => {
        const t = await boot();
        try {
            const job = createTemplatesJob({ config: t.config, entries: t.ctx.entries, fetchImpl: commonsFetch(), log: console });
            const out = await job.runOnce({ limit: 1 });
            if (!out.seeded) throw new Error('no template was seeded');
            const rows = await t.ctx.s.db.many('SELECT * FROM meme_templates ORDER BY created_at');
            const row = rows.find((r) => r.id.startsWith('tpl_commons_'));
            if (!row) throw new Error('the seeded template is not in the table');
            if (!row.license) throw new Error('the template carries no licence');
            if (!row.credit) throw new Error('the template carries no credit');
            if (!row.source_url || !/^https:\/\/commons\.wikimedia\.org\//.test(row.source_url)) throw new Error(`the source page is ${row.source_url}`);
            if (!/^https:\/\/upload\.wikimedia\.org\//.test(row.image_url)) throw new Error(`the picture is ${row.image_url}`);
            if (!row.attribution) throw new Error('the template carries no attribution');
        } finally { await t.close(); }
    });

    await check('the templates are listed with their attribution', async () => {
        const t = await boot();
        try {
            const job = createTemplatesJob({ config: t.config, entries: t.ctx.entries, fetchImpl: commonsFetch(), log: console });
            await job.runOnce({ limit: 1 });
            const res = await t.get('/api/v1/templates');
            if (res.status !== 200) throw new Error(`the templates answered ${res.status}`);
            const body = res.json();
            const seeded = body.templates.find((x) => x.id.startsWith('tpl_commons_'));
            if (!seeded) throw new Error('the seeded template is not listed');
            if (!seeded.license) throw new Error('the listed template carries no licence');
            if (!seeded.credit) throw new Error('the listed template carries no credit');
        } finally { await t.close(); }
    });

    await check('a file whose licence forbids reuse is never seeded', async () => {
        const t = await boot();
        try {
            const job = createTemplatesJob({ config: t.config, entries: t.ctx.entries, fetchImpl: commonsFetch({ license: 'All rights reserved' }), log: console });
            const out = await job.runOnce({ limit: 3 });
            if (out.seeded) throw new Error(`${out.seeded} template(s) were seeded from a file that forbids reuse`);
            const rows = await t.ctx.s.db.many("SELECT id FROM meme_templates WHERE id LIKE 'tpl_commons_%'");
            if (rows.length) throw new Error('a template was written from a file that forbids reuse');
        } finally { await t.close(); }
    });

    await check('a file that is not a picture is never seeded', async () => {
        const t = await boot();
        try {
            const job = createTemplatesJob({ config: t.config, entries: t.ctx.entries, fetchImpl: commonsFetch({ mime: 'video/mp4' }), log: console });
            const out = await job.runOnce({ limit: 3 });
            if (out.seeded) throw new Error(`${out.seeded} template(s) were seeded from a file that is not a picture`);
        } finally { await t.close(); }
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
