'use strict';

/**
 * The open sources of the encyclopedia: Wikipedia (CC BY-SA), Wikidata (CC0) and Wikimedia Commons (each file under
 * its own licence). Nothing is scraped from a site whose terms forbid it; these three have APIs that say what may
 * be used and how it must be credited.
 *
 *   listEntries(title)     a Wikipedia list read into entries: the name, the section and the list's own words
 *   categoryMembers(cat)   the pages of a Wikipedia category (the second list of well-known memes)
 *   resolveQids(titles)    a Wikipedia title → its Wikidata Q id
 *   entities(qids)         Wikidata: the inception date, the picture, the label and the description
 *   leadExtract(titles)    a Wikipedia article's lead, in plain words
 *   imageInfo(files)       a Commons file: the picture, its licence and its credit
 *
 * Every request names the service (a User-Agent with a contact address) and is paced per host, as the Wikimedia
 * API policy asks.
 */
const { setTimeout: sleep } = require('node:timers/promises');

class SourceError extends Error {
    constructor(message, { code = 'meme.source', status = 502 } = {}) {
        super(message);
        this.name = 'SourceError';
        this.code = code;
        this.status = status;
    }
}

/** Templates that carry no words of their own. */
const EMPTY_TEMPLATES = new Set(['snd', 'lang', 'nowrap', 'small', 'sic', 'efn', 'citation', 'cite web', 'cite book',
    'cite magazine', 'cite news', 'cite journal', 'ill', 'nobold', 'not italic', 'abbr', 'portal', 'anchor', 'vanchor',
    'clr', 'color', 'center', 'blockquote', 'div col', 'div col end', 'flatlist', 'hlist', 'columns-list', 'ref']);

const chunk = (list, n) => {
    const out = [];
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
    return out;
};

/** The words of a wiki text, without the markup: links keep their display text, templates keep their content. */
function plainText(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<ref[^>]*\/>/gi, ' ');
    s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, ' ');
    s = s.replace(/<[^>]+>/g, ' ');
    // Links: [[Target|Display]] → Display, [[Target]] → Target.
    for (let i = 0; i < 6; i++) {
        const before = s;
        s = s.replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, '$2');
        s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');
        if (s === before) break;
    }
    // Templates: an empty one goes, another keeps its content.
    for (let i = 0; i < 8; i++) {
        const before = s;
        s = s.replace(/\{\{([^{}|]*)(?:\|([^{}]*))?\}\}/g, (m, name, arg) => {
            const key = String(name).trim().toLowerCase();
            if (EMPTY_TEMPLATES.has(key)) return ' ';
            return ` ${arg == null ? '' : arg} `;
        });
        if (s === before) break;
    }
    s = s.replace(/'''''|'''|''/g, '');
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return s.replace(/\s+/g, ' ').trim();
}

/** The name a list entry carries: the link's display text, or its target without the section. */
function entryTitle(raw) {
    const link = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(raw);
    if (link) {
        const display = (link[2] || '').replace(/'''/g, '').trim();
        if (display) return display;
        return String(link[1]).split('#')[0].replace(/_/g, ' ').trim();
    }
    const quoted = /^["“”'](.+?)["“”']/.exec(String(raw).trim());
    if (quoted) return quoted[1].trim();
    return '';
}

/**
 * One Wikipedia list, read into entries. Each entry is { title, target, section, description } where the
 * description is the list's own words about that entry.
 */
function parseList(wikitext) {
    const out = [];
    let section = '';
    for (const line of String(wikitext || '').split('\n')) {
        const heading = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
        if (heading) { section = plainText(heading[2]); continue; }
        if (!/^\*+\s*\S/.test(line)) continue;
        if (/^\*\*+/.test(line)) continue;                     // a sub-bullet is a note, not an entry
        if (/^(See also|References|Notes|External links)$/i.test(section)) continue;
        const body = line.replace(/^\*+\s*/, '');
        const raw = body.split('{{snd}}')[0];
        const title = entryTitle(raw);
        if (!title || title.length > 120) continue;
        const target = (/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(raw) || [])[1] || title;
        const description = plainText(body.split('{{snd}}').slice(1).join('{{snd}}') || body.slice(raw.length));
        out.push({ title, target: String(target).replace(/_/g, ' '), section, description });
    }
    return out;
}

/** True when a licence lets us use the picture: public domain, CC0, or a Creative Commons licence. */
function isFreeLicense(name) {
    const s = String(name || '').trim().toLowerCase();
    if (!s) return false;
    if (/^(cc0|public domain|pd|no restrictions|cc pd)/.test(s)) return true;
    if (/^cc[ -]?(by|by-sa|by-nc|by-nd)[ -]?\d/.test(s)) return true;
    if (s === 'cc by') return true;
    if (s.startsWith('cc by')) return true;
    return false;
}

/** The Commons metadata, without its HTML. */
function cleanMeta(value) {
    if (!value) return '';
    return plainText(String(value).replace(/<[^>]+>/g, ' ')).slice(0, 300);
}

function createSources({ config, fetchImpl = globalThis.fetch, log = console }) {
    const opts = config.encyclopedia || {};
    const userAgent = opts.userAgent || 'OpenVibe.Meme/0.2 (+https://openvibe.meme; contact@openvibe.network)';
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 20_000);
    const lastCall = new Map();

    /** One request per host, at least minIntervalMs apart, with a retry on 429 and 5xx. */
    async function call(url, { label = 'Wikipedia', retries = 2 } = {}) {
        const host = new URL(url).host;
        const wait = Math.max(0, (lastCall.get(host) || 0) + (Number(opts.minIntervalMs) || 0) - Date.now());
        if (wait) await sleep(wait);
        lastCall.set(host, Date.now());
        let lastErr = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            let res;
            try {
                res = await fetchImpl(url, {
                    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
                    signal: AbortSignal.timeout(timeoutMs),
                    redirect: 'follow',
                });
            } catch (err) {
                lastErr = new SourceError(`${label}: ${err && err.message}`, { code: 'meme.source.unreachable' });
                await sleep(500 * (attempt + 1));
                continue;
            }
            if (res.ok) {
                const text = await res.text();
                try { return JSON.parse(text); } catch { throw new SourceError(`${label} answered something that is not JSON`, { code: 'meme.source.body' }); }
            }
            if (res.status === 404) return { notFound: true };
            lastErr = new SourceError(`${label} answered ${res.status}`, { status: res.status >= 500 ? 502 : res.status });
            if (res.status === 429 || res.status >= 500) {
                await sleep(800 * (attempt + 1));
                continue;
            }
            throw lastErr;
        }
        throw lastErr || new SourceError(`${label} did not answer`);
    }

    const api = (base, params) => `${String(base).replace(/\/+$/, '')}/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;

    /** One Wikipedia list, read into entries. */
    async function listEntries(title) {
        const data = await call(api(opts.wikipedia, {
            action: 'parse', page: String(title || '').replace(/ /g, '_'), prop: 'wikitext', redirects: '1',
        }), { label: `Wikipedia ${title}` });
        if (!data || data.notFound || !data.parse) return [];
        return parseList(data.parse.wikitext);
    }

    /** The pages of a Wikipedia category: the second list of well-known memes. */
    async function categoryMembers(category) {
        const out = [];
        let cont = null;
        for (let page = 0; page < 8; page++) {
            const data = await call(api(opts.wikipedia, {
                action: 'query', list: 'categorymembers', cmtitle: `Category:${String(category).replace(/ /g, '_')}`,
                cmlimit: '500', cmnamespace: '0', ...(cont ? { cmcontinue: cont } : {}),
            }), { label: `Wikipedia category ${category}` });
            if (!data || data.notFound) break;
            for (const m of data.query && data.query.categorymembers ? data.query.categorymembers : []) {
                if (m && m.title) out.push({ title: m.title, target: m.title, section: 'Category', description: '' });
            }
            cont = data.continue && data.continue.cmcontinue ? data.continue.cmcontinue : null;
            if (!cont) break;
        }
        return out;
    }

    /** Wikipedia titles → their Wikidata Q id (redirects followed). */
    async function resolveQids(titles) {
        const wanted = [...new Set((titles || []).map((t) => String(t || '').trim()).filter(Boolean))];
        const out = new Map();
        for (const group of chunk(wanted, 40)) {
            const data = await call(api(opts.wikipedia, {
                action: 'query', redirects: '1', prop: 'pageprops', ppprop: 'wikibase_item', titles: group.join('|'),
            }), { label: 'Wikipedia' });
            if (!data || data.notFound) continue;
            const pages = (data.query && data.query.pages) || [];
            const redirects = (data.query && data.query.redirects) || [];
            const redirectTo = new Map(redirects.map((r) => [String(r.from), String(r.to)]));
            const byTitle = new Map(pages.map((p) => [String(p.title), p]));
            for (const title of group) {
                const landed = redirectTo.get(title) || title;
                const page = byTitle.get(landed) || byTitle.get(title);
                const qid = page && page.pageprops && page.pageprops.wikibase_item;
                if (qid && /^Q[1-9][0-9]{0,11}$/.test(qid)) out.set(title, { qid, title: page.title });
            }
        }
        return out;
    }

    /** Q ids → the facts the encyclopedia needs: when it started, its picture, its label. */
    async function entities(qids) {
        const wanted = [...new Set((qids || []).filter((q) => /^Q[1-9][0-9]{0,11}$/.test(String(q))))];
        const out = new Map();
        for (const group of chunk(wanted, 40)) {
            const data = await call(api(opts.wikidata, {
                action: 'wbgetentities', ids: group.join('|'), props: 'claims|labels|descriptions|sitelinks', languages: 'en',
            }), { label: 'Wikidata' });
            if (!data || data.notFound) continue;
            const all = data.entities || {};
            for (const qid of group) {
                const e = all[qid];
                if (!e) continue;
                const claims = e.claims || {};
                const first = (prop) => {
                    const list = claims[prop];
                    if (!Array.isArray(list) || !list.length) return null;
                    const v = list[0] && list[0].mainsnak && list[0].mainsnak.datavalue && list[0].mainsnak.datavalue.value;
                    return v == null ? null : v;
                };
                const inception = first('P571');
                const image = first('P18');
                out.set(qid, {
                    qid,
                    label: (e.labels && e.labels.en && e.labels.en.value) || null,
                    description: (e.descriptions && e.descriptions.en && e.descriptions.en.value) || null,
                    inception: inception && inception.time ? String(inception.time).replace(/^\+/, '') : null,
                    image: typeof image === 'string' ? image : null,
                    article: (e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title) || null,
                });
            }
        }
        return out;
    }

    /** Wikipedia articles → their lead, in plain words. */
    async function leadExtract(titles) {
        const wanted = [...new Set((titles || []).map((t) => String(t || '').trim()).filter(Boolean))];
        const out = new Map();
        for (const group of chunk(wanted, 20)) {
            const data = await call(api(opts.wikipedia, {
                action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', redirects: '1',
                exlimit: 'max', titles: group.join('|'),
            }), { label: 'Wikipedia' });
            if (!data || data.notFound) continue;
            const pages = (data.query && data.query.pages) || [];
            const redirects = (data.query && data.query.redirects) || [];
            const redirectTo = new Map(redirects.map((r) => [String(r.from), String(r.to)]));
            const byTitle = new Map(pages.map((p) => [String(p.title), p]));
            for (const title of group) {
                const landed = redirectTo.get(title) || title;
                const page = byTitle.get(landed) || byTitle.get(title);
                const extract = page && typeof page.extract === 'string' ? page.extract.trim() : '';
                if (extract) out.set(title, extract.slice(0, 4000));
            }
        }
        return out;
    }

    /** Commons files → the picture, its licence and its credit. A file under a licence that forbids reuse is dropped. */
    async function imageInfo(files) {
        const wanted = [...new Set((files || []).map((f) => String(f || '').trim()).filter(Boolean))];
        const out = new Map();
        for (const group of chunk(wanted, 40)) {
            const data = await call(api(opts.commons, {
                action: 'query', prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '1200',
                titles: group.map((f) => (f.startsWith('File:') ? f : `File:${f}`)).join('|'),
            }), { label: 'Wikimedia Commons' });
            if (!data || data.notFound) continue;
            const pages = (data.query && data.query.pages) || [];
            for (const page of pages) {
                const info = page && page.imageinfo && page.imageinfo[0];
                if (!info) continue;
                const meta = info.extmetadata || {};
                const val = (name) => cleanMeta(meta[name] && meta[name].value);
                const license = val('LicenseShortName') || val('License') || '';
                const licenseUrl = val('LicenseUrl');
                if (!isFreeLicense(license)) continue;
                const url = info.thumburl || info.url;
                if (!url || !/^https:\/\/upload\.wikimedia\.org\//.test(url)) continue;
                out.set(String(page.title).replace(/^File:/, ''), {
                    url,
                    original_url: info.url || url,
                    page_url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`,
                    license,
                    license_url: licenseUrl,
                    credit: val('Artist') || val('Credit') || 'Wikimedia Commons',
                    usage_terms: val('UsageTerms'),
                });
            }
        }
        return out;
    }

    return { listEntries, categoryMembers, resolveQids, entities, leadExtract, imageInfo, isFreeLicense, plainText, parseList };
}

module.exports = { createSources, parseList, plainText, isFreeLicense, entryTitle, SourceError };
