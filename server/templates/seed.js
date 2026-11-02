'use strict';

/**
 * The templates. OpenVibe.Meme's caption generator draws its text over a picture; the pictures are the well-known
 * meme templates, taken from Wikimedia Commons under a licence that lets us use them: public domain, CC0 or a
 * Creative Commons licence. A file under any other licence is left out.
 *
 * Every template keeps its own licence and credit, and the file page it came from, so the picture is attributed
 * where it is shown. The three data-free placeholders of v1 (tpl_classic, tpl_reaction, tpl_triptych) stay: they
 * are the site's own, and they need no attribution.
 *
 * The names are the well-known ones; the file is found in Commons and checked, not assumed. A template whose file
 * cannot be found, or whose licence does not allow reuse, is skipped and reported.
 */
const { createPacer, fetchText, fetchJson } = require('../sources/http');

/** The well-known templates: the name, the word the file must carry, and how many text boxes it has. */
const WELL_KNOWN = Object.freeze([
    { name: 'Drake Hotline Bling', token: 'drake', box_count: 2 },
    { name: 'Distracted Boyfriend', token: 'distracted', box_count: 1 },
    { name: 'Expanding Brain', token: 'brain', box_count: 4 },
    { name: 'Change My Mind', token: 'change', box_count: 1 },
    { name: 'Is This a Pigeon', token: 'pigeon', box_count: 2 },
    { name: 'Woman Yelling at a Cat', token: 'yelling', box_count: 2 },
    { name: 'Surprised Pikachu', token: 'pikachu', box_count: 2 },
    { name: 'Two Buttons', token: 'button', box_count: 3 },
    { name: 'Boardroom Meeting', token: 'boardroom', box_count: 2 },
    { name: 'Running Away from a Balloon', token: 'balloon', box_count: 2 },
    { name: 'Crying Cat', token: 'cat', box_count: 2 },
    { name: 'Pointing at the Dog', token: 'dog', box_count: 2 },
    { name: 'They Don\'t Know', token: 'know', box_count: 2 },
    { name: 'Trade Offer', token: 'trade', box_count: 2 },
    { name: 'Left Exit 12 Off Ramp', token: 'ramp', box_count: 2 },
    { name: 'Hide the Pain Harold', token: 'harold', box_count: 2 },
    { name: 'Roll Safe', token: 'roll', box_count: 2 },
    { name: 'Disaster Girl', token: 'disaster', box_count: 2 },
    { name: 'Philosoraptor', token: 'raptor', box_count: 2 },
    { name: 'Success Kid', token: 'success', box_count: 2 },
    { name: 'Mocking SpongeBob', token: 'spongebob', box_count: 2 },
    { name: 'This Is Fine', token: 'fine', box_count: 2 },
    { name: 'Waiting Skeleton', token: 'skeleton', box_count: 2 },
    { name: 'X All the Y', token: 'all', box_count: 2 },
    { name: 'Sweating Guy', token: 'sweat', box_count: 2 },
    { name: 'Gru\'s Plan', token: 'gru', box_count: 4 },
    { name: 'Skeleton Jumping', token: 'skeleton', box_count: 1 },
    { name: 'Afraid to Ask Andy', token: 'andy', box_count: 2 },
    { name: 'Me Gusta Mucho', token: 'gusta', box_count: 2 },
    { name: 'Seagull Full of Fries', token: 'seagull', box_count: 2 },
    { name: 'Chad and Virgo', token: 'virgo', box_count: 2 },
    { name: 'Stonks', token: 'stonks', box_count: 2 },
    { name: 'Cheugy', token: 'cheugy', box_count: 2 },
    { name: 'Elon Musk', token: 'musk', box_count: 2 },
    { name: 'No U Mad', token: 'mad', box_count: 2 },
    { name: 'Nutcracker', token: 'nutcracker', box_count: 2 },
    { name: 'Evil Toddler', token: 'toddler', box_count: 2 },
    { name: 'Sweating Buddha', token: 'buddha', box_count: 2 },
    { name: 'Yao Ming Face', token: 'yao', box_count: 2 },
    { name: 'Il Posto di Lavoro', token: 'lavoro', box_count: 2 },
    { name: 'Gru and the Plan', token: 'gru', box_count: 2 },
    { name: 'Duck and Cover', token: 'duck', box_count: 2 },
    { name: 'Scumbag Steve', token: 'steve', box_count: 2 },
    { name: 'Overly Attached Girlfriend', token: 'girlfriend', box_count: 2 },
    { name: 'Inhaling Seagull', token: 'seagull', box_count: 2 },
    { name: 'Annoyed Cat', token: 'cat', box_count: 2 },
]);

const slug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** The Commons file's licence must allow reuse. */
function isFreeLicense(name) {
    const s = String(name || '').trim().toLowerCase();
    if (!s) return false;
    if (/^(cc0|public domain|pd|no restrictions|cc pd)/.test(s)) return true;
    if (/^cc[ -]?(by|by-sa|by-nc|by-nd)[ -]?\d/.test(s)) return true;
    if (s.startsWith('cc by')) return true;
    return false;
}

const clean = (v) => String(v == null ? '' : v).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

function createTemplatesJob({ config, entries, fetchImpl = globalThis.fetch, log = console }) {
    const opts = config.templates || {};
    const userAgent = opts.userAgent || 'OpenVibe.Meme/0.2 (+https://openvibe.meme; contact@openvibe.network)';
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 20_000);
    const pace = createPacer(Number(opts.minIntervalMs) || 250);

    const api = (params) => `${String(opts.commons).replace(/\/+$/, '')}/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;

    /** The Commons files whose name carries the token. */
    async function search(token) {
        const { json } = await fetchJson(api({
            action: 'query', list: 'search', srsearch: `${token} filetype:bitmap`, srnamespace: '6', srlimit: '12',
        }), { fetchImpl, userAgent, timeoutMs, pace, label: 'Commons search' });
        const hits = (json && json.query && json.query.search) || [];
        return hits.map((h) => String(h.title || '')).filter(Boolean);
    }

    /** The file's picture, licence and credit. A file under a licence that forbids reuse is dropped. */
    async function info(titles) {
        const wanted = [...new Set(titles)].slice(0, 20);
        if (!wanted.length) return new Map();
        const { json } = await fetchJson(api({
            action: 'query', prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '1200', titles: wanted.join('|'),
        }), { fetchImpl, userAgent, timeoutMs, pace, label: 'Commons' });
        const out = new Map();
        for (const page of (json && json.query && json.query.pages) || []) {
            const info = page && page.imageinfo && page.imageinfo[0];
            if (!info) continue;
            if (info.mime && !String(info.mime).startsWith('image/')) continue;
            const meta = info.extmetadata || {};
            const val = (name) => clean(meta[name] && meta[name].value);
            const license = val('LicenseShortName') || val('License') || '';
            if (!isFreeLicense(license)) continue;
            const url = info.thumburl || info.url;
            if (!url || !/^https:\/\/upload\.wikimedia\.org\//.test(url)) continue;
            out.set(String(page.title), {
                url,
                page_url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`,
                license,
                license_url: val('LicenseUrl'),
                credit: val('Artist') || val('Credit') || 'Wikimedia Commons',
            });
        }
        return out;
    }

    /**
     * Seed the templates. Returns { seeded, skipped, templates } — the templates carry their licence and credit.
     */
    async function runOnce({ limit = null, publish = true } = {}) {
        const wanted = (limit ? WELL_KNOWN.slice(0, Math.max(1, Number(limit))) : WELL_KNOWN);
        const seeded = [];
        const skipped = [];
        for (const tpl of wanted) {
            try {
                const titles = await search(tpl.token);
                const files = await info(titles);
                let found = null;
                for (const [title, file] of files) {
                    if (!title.toLowerCase().includes(tpl.token.toLowerCase())) continue;
                    found = file;
                    break;
                }
                if (!found) { skipped.push({ name: tpl.name, reason: 'no freely licensed file found' }); continue; }
                const id = `tpl_commons_${slug(tpl.name)}`;
                const row = await entries.addTemplate({
                    id,
                    name: tpl.name,
                    image_url: found.url,
                    box_count: tpl.box_count || 2,
                    source: 'Wikimedia Commons',
                    license: found.license,
                    credit: found.credit,
                    source_url: found.page_url,
                    attribution: `${found.credit} — ${found.license}, via Wikimedia Commons`.slice(0, 400),
                });
                seeded.push(row);
            } catch (err) {
                skipped.push({ name: tpl.name, reason: err.message });
                log.warn(`[OpenVibe.Meme] template ${tpl.name}: ${err.message}`);
            }
        }
        log.log(`[OpenVibe.Meme] templates: ${seeded.length} seeded, ${skipped.length} skipped`);
        return { ok: true, seeded: seeded.length, skipped: skipped.length, templates: seeded, missing: skipped };
    }

    return { runOnce, search, info, WELL_KNOWN };
}

module.exports = { createTemplatesJob, WELL_KNOWN, isFreeLicense, slug };
