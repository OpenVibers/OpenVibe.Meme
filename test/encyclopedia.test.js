'use strict';
/**
 * The encyclopedia: the well-known internet memes, seeded from the open lists and written by the same AI pass.
 *
 * Every seeded entry is an entry of kind 'classic' with its origin, its spread and its sources; it carries the
 * attribution of the licences its text is under; nothing is published whose text names looks or carries a denied
 * word; and a picture is only used when its licence allows it.
 */
const { boot, check, done } = require('./helpers/boot');
const { createSources } = require('../server/classics/sources');
const { createClassicsJob } = require('../server/classics/seed');

const LIST_WIKITEXT = `== Films ==
* [[Dog eats husband]]{{snd}}A joke about a woman who cooked her husband and fed him to her dogs.
* [[Success Kid]]{{snd}}A picture of a child raising a barbell, used to describe a small success.
* [[Hidden treasure map]]{{snd}}A map that leads to a hidden treasure.
== Video ==
* [[Nyan cat]]{{snd}}A cat with Pop-Tart wings flying through space with a rainbow trail.
`;

/** A stand-in for Wikipedia, Wikidata and Wikimedia Commons. */
function wikiFetch(overrides = {}) {
    return async (url) => {
        const u = new URL(url);
        const q = u.searchParams;
        const action = q.get('action');
        const body = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj, headers: new Map() });

        if (action === 'parse') {
            if (q.get('page') === 'List_of_Internet_phenomena') return body({ parse: { wikitext: LIST_WIKITEXT } });
            return body({ parse: { wikitext: '== Films ==\n* [[Dog eats husband]]{{snd}}A joke about a woman who cooked her husband and fed him to her dogs.\n' } });
        }
        if (action === 'query' && q.get('list') === 'categorymembers') return body({ query: { categorymembers: [] } });
        if (action === 'query' && q.get('prop') === 'pageprops') {
            const titles = String(q.get('titles') || '').split('|');
            return body({
                query: {
                    pages: titles.map((title) => ({ title, pageprops: { wikibase_item: overrides.qid || 'Q100' } })),
                },
            });
        }
        if (action === 'query' && q.get('prop') === 'extracts') {
            const titles = String(q.get('titles') || '').split('|');
            return body({
                query: {
                    pages: titles.map((title) => ({
                        title,
                        extract: overrides.extract || 'The joke is a black-humour joke about a woman who cooked her husband and fed him to her dogs, told as a recipe.',
                    })),
                },
            });
        }
        if (action === 'query' && q.get('prop') === 'imageinfo') {
            const titles = String(q.get('titles') || '').split('|');
            return body({
                query: {
                    pages: titles.map((title) => ({
                        title,
                        mime: 'image/jpeg',
                        imageinfo: [{
                            url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Dog.jpg',
                            thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Dog.jpg/800px-Dog.jpg',
                            extmetadata: {
                                LicenseShortName: { value: overrides.license || 'CC BY-SA 4.0' },
                                LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
                                Artist: { value: '<a href="https://commons.wikimedia.org/wiki/User:Someone">Someone</a>' },
                            },
                        }],
                    })),
                },
            });
        }
        if (action === 'wbgetentities') {
            const ids = String(q.get('ids') || '').split('|');
            return body({
                entities: Object.fromEntries(ids.map((id) => [id, {
                    id,
                    labels: { en: { value: 'Dog eats husband' } },
                    descriptions: { en: { value: 'internet meme' } },
                    claims: { P571: [{ mainsnak: { datavalue: { value: { time: '+2007-00-00T00:00:00Z' } } } }], P18: [{ mainsnak: { datavalue: { value: 'Dog.jpg' } } }] },
                    sitelinks: { enwiki: { title: 'Dog eats husband' } },
                }])),
            });
        }
        return body({});
    };
}

const answer = (score, extra = {}) => () => JSON.stringify({
    score,
    reason: `the AI scored it ${score}`,
    title: 'Dog eats husband',
    summary: 'A dark joke told as a recipe.',
    origin: 'It comes from a 2007 image macro.',
    spread: 'People tell it as a recipe, with the punchline in the last line.',
    examples: ['recipe: 1 husband, 2 dogs', 'ingredients: one husband'],
    ...extra,
});

async function seed(t, { answerFn = answer(0.9), fetchImpl = wikiFetch(), config = {} } = {}) {
    const cfg = t.config;
    const sources = createSources({ config: { ...cfg, encyclopedia: { ...cfg.encyclopedia, ...config } }, fetchImpl, log: console });
    const judge = t.ctx.judge;
    const job = createClassicsJob({ config: cfg, s: t.ctx.s, entries: t.ctx.entries, sources, judge, log: console });
    // The stand-in AI answers every prompt with the same verdict.
    t.ai.setAnswer(answerFn);
    return await job.runOnce({ publish: true });
}

(async () => {
    await check('the encyclopedia is seeded with entries of kind classic, cited and attributed', async () => {
        const t = await boot();
        try {
            const out = await seed(t);
            if (!out.seeded) throw new Error('nothing was seeded');
            const rows = await t.ctx.s.db.many("SELECT * FROM meme_entries WHERE kind = 'classic' ORDER BY slug");
            if (!rows.length) throw new Error('no classic entry was written');
            const row = rows[0];
            if (row.visibility !== 'public') throw new Error(`the entry is ${row.visibility}, not public`);
            if (!row.attribution) throw new Error('the entry carries no attribution');
            if (!/Wikipedia/.test(row.attribution) || !/Wikidata/.test(row.attribution)) throw new Error(`the attribution is ${row.attribution}`);
            if (!row.image_license) throw new Error('the entry carries no licence');
            if (!row.image_credit) throw new Error('the entry carries no credit');
            if (!row.image_url || !/^https:\/\/upload\.wikimedia\.org\//.test(row.image_url)) throw new Error(`the picture is ${row.image_url}`);
            const citations = await t.ctx.entries.citations(row.id);
            if (citations.length < 3) throw new Error(`the entry has ${citations.length} citations`);
            if (!citations.some((c) => c.source_type === 'wikipedia')) throw new Error('no Wikipedia citation');
            if (!citations.some((c) => c.source_type === 'wikidata')) throw new Error('no Wikidata citation');
            if (!citations.some((c) => c.role === 'origin')) throw new Error('no origin citation');
            for (const c of citations) {
                if (!/^https:\/\//.test(c.url)) throw new Error(`a citation has no public URL: ${c.url}`);
                if (!c.quote_text) throw new Error('a citation has no quoted text');
            }
        } finally { await t.close(); }
    });

    await check('every seeded entry carries its attribution', async () => {
        const t = await boot();
        try {
            await seed(t);
            const rows = await t.ctx.s.db.many("SELECT id, attribution, image_license FROM meme_entries WHERE kind = 'classic'");
            if (!rows.length) throw new Error('nothing was seeded');
            for (const row of rows) {
                if (!row.attribution) throw new Error(`entry ${row.id} has no attribution`);
                if (!row.image_license) throw new Error(`entry ${row.id} has no licence`);
            }
        } finally { await t.close(); }
    });

    await check('nothing is published whose text names looks', async () => {
        const t = await boot();
        try {
            await seed(t, { answerFn: answer(0.95, { summary: 'A man in a kitchen tells the joke.', title: 'Dog eats husband' }) });
            const rows = await t.ctx.s.db.many("SELECT id, visibility, summary FROM meme_entries WHERE kind = 'classic'");
            for (const row of rows) {
                const { hasLooks } = require('openvibe-sdk/no-looks');
                if (row.visibility === 'public' && hasLooks(row.summary || '')) throw new Error(`entry ${row.id} is public and its summary names looks`);
            }
        } finally { await t.close(); }
    });

    await check('nothing is published whose text carries a denied word', async () => {
        const t = await boot();
        try {
            await seed(t, { answerFn: answer(0.95, { summary: 'The joke is about a nazi in a kitchen.' }) });
            const rows = await t.ctx.s.db.many("SELECT id, visibility, summary FROM meme_entries WHERE kind = 'classic'");
            for (const row of rows) {
                if (row.visibility === 'public' && /nazi/i.test(row.summary || '')) throw new Error(`entry ${row.id} is public and its summary carries a denied word`);
            }
        } finally { await t.close(); }
    });

    await check('a classic the AI scored under the bar stays hidden, with its score', async () => {
        const t = await boot();
        try {
            await seed(t, { answerFn: answer(0.4) });
            const rows = await t.ctx.s.db.many("SELECT id, visibility FROM meme_entries WHERE kind = 'classic'");
            if (!rows.length) throw new Error('nothing was seeded');
            for (const row of rows) {
                if (row.visibility !== 'hidden') throw new Error(`entry ${row.id} was published under the bar`);
            }
            const list = await t.ctx.entries.listHidden({ limit: 50 });
            const judged = list.find((e) => e.kind === 'classic');
            if (!judged) throw new Error('the classic is not on the staff list');
            if (Number(judged.score) !== 0.4) throw new Error(`the staff list shows ${judged.score}`);
        } finally { await t.close(); }
    });

    await check('a picture whose licence forbids reuse is not used', async () => {
        const t = await boot();
        try {
            await seed(t, { fetchImpl: wikiFetch({ license: 'All rights reserved' }) });
            const rows = await t.ctx.s.db.many("SELECT id, image_url FROM meme_entries WHERE kind = 'classic'");
            for (const row of rows) {
                if (row.image_url) throw new Error(`entry ${row.id} uses a picture under a licence that forbids reuse`);
            }
        } finally { await t.close(); }
    });

    await check('the seeded classics are public in the API', async () => {
        const t = await boot();
        try {
            await seed(t);
            const res = await t.get('/api/v1/entries?limit=50');
            if (res.status !== 200) throw new Error(`the list answered ${res.status}`);
            const classics = res.json().entries.filter((e) => e.kind === 'classic');
            if (!classics.length) throw new Error('no classic entry is public');
            if (!classics[0].attribution) throw new Error('the public entry carries no attribution');
        } finally { await t.close(); }
    });

    await check('a classic the AI could not write is not seeded at all', async () => {
        const t = await boot();
        try {
            await seed(t, { answerFn: answer(0.9, { title: '', summary: '', origin: '', spread: '', examples: [] }) });
            const rows = await t.ctx.s.db.many("SELECT id, visibility FROM meme_entries WHERE kind = 'classic'");
            for (const row of rows) {
                if (row.visibility === 'public') throw new Error(`entry ${row.id} was published without a written entry`);
            }
        } finally { await t.close(); }
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
