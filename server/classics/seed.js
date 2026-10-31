'use strict';

/**
 * The encyclopedia's seed. It reads the well-known internet memes from the open lists (Wikipedia's lists of Internet
 * phenomena and memes, CC BY-SA) and from Wikidata (CC0), writes each one with the same AI pass the OpenVibe
 * candidates use, and keeps every entry's source, picture licence and attribution.
 *
 * One entry per meme:
 *   kind 'classic', status 'classic', the AI's title and summary, where it started and how it spread, two or three
 *   example uses, and the citations it was written from: the Wikipedia article (the origin), the list's own words
 *   about it, the Wikidata facts, and the Commons picture under its own licence.
 *
 * The same publish rule as the candidates: the AI scored it 0.75 or more on "is this a real, widely used meme",
 * the text names no looks and no denied word, and the entry is complete. What does not clear the bar stays hidden
 * for staff, with its score — the list holds videos, products and people too, and not all of them are memes.
 */
const { isExplicit } = require('../text/no-looks');
const { hasDeniedWord } = require('../deny-list');
const { evaluateClassic } = require('../ai/gate');
const { slugify } = require('../store');

/** The attribution every classic carries: Wikipedia's and Wikidata's licences. */
const ATTRIBUTION = 'Text from Wikipedia (CC BY-SA 4.0); facts from Wikidata (CC0).';

/** A Wikidata date: "+1997-00-00T00:00:00Z" (a year) or "1997-05-01T00:00:00Z". */
function toIsoDate(value) {
    const s = String(value == null ? '' : value).replace(/^\+/, '');
    const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(s);
    if (!m) return null;
    const year = Number(m[1]);
    const month = m[2] && m[2] !== '00' ? Number(m[2]) : 1;
    const day = m[3] && m[3] !== '00' ? Number(m[3]) : 1;
    if (year < 1900 || year > 2100) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The year a description mentions first, when Wikidata has no date: "…in 2013…" */
function yearFrom(text) {
    const m = /\b(19[5-9]\d|20[0-2]\d)\b/.exec(String(text || ''));
    if (!m) return null;
    return `${m[1]}-01-01T00:00:00.000Z`;
}

/** A citation for the open web. It is stored like any other: a public URL and the sha256 of the quoted text. */
function webCitation({ source_type, source_id, quote_text, url, observed_at, role = 'use' }) {
    return {
        role,
        source_service: 'web',
        source_type,
        source_id: String(source_id).slice(0, 200),
        quote_text: String(quote_text || '').trim(),
        url: String(url),
        observed_at: observed_at || new Date().toISOString(),
        source_status: 'live',
    };
}

function createClassicsJob({ config, s, entries, sources, judge, log = console }) {
    const stats = { runs: 0, found: 0, seeded: 0, published: 0, kept: 0, skipped: 0, errors: 0, last_run_at: null, last_error: null };
    const opts = config.encyclopedia || {};

    /** The lists: Wikipedia's list of Internet phenomena and the category behind it. */
    async function collect() {
        const found = [];
        for (const title of opts.lists || []) {
            try {
                const entriesOfList = await sources.listEntries(title);
                for (const e of entriesOfList) found.push({ ...e, list: title });
            } catch (err) {
                log.warn(`[OpenVibe.Meme] classics: list ${title}: ${err.message}`);
            }
        }
        for (const category of opts.categories || []) {
            try {
                for (const e of await sources.categoryMembers(category)) found.push({ ...e, list: `Category:${category}` });
            } catch (err) {
                log.warn(`[OpenVibe.Meme] classics: category ${category}: ${err.message}`);
            }
        }
        // One entry per name: the first one wins.
        const seen = new Set();
        const out = [];
        for (const e of found) {
            const key = e.title.trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(e);
        }
        return out.slice(0, Math.max(1, Number(opts.limit) || 400));
    }

    /**
     * The citations of one classic, and the facts behind them. Returns null when the sources are too thin to write
     * an entry from, or when the text is not something this site publishes.
     */
    async function buildCandidate(item, { qids, facts, leads, images }) {
        const title = item.title;
        const article = item.target && item.target.includes('/') ? null : item.target;
        const resolved = article ? qids.get(article) : null;
        const fact = resolved ? facts.get(resolved.qid) : null;
        const lead = article ? (leads.get(article) || '') : '';

        // The list's own words, and the article's lead: the two texts the entry is written from.
        const listText = item.description || '';
        if (!listText && !lead) return null;

        // Nothing explicit and nothing from the deny list ever enters the database, in a quote either.
        if (isExplicit(listText, lead)) return null;
        if (hasDeniedWord(`${title} ${listText} ${lead}`)) return null;

        const now = new Date(s.now()).toISOString();
        const inception = (fact && toIsoDate(fact.inception)) || yearFrom(listText) || yearFrom(lead) || now;
        const cites = [];

        if (lead) {
            cites.push(webCitation({
                source_type: 'wikipedia',
                source_id: article || title,
                quote_text: lead.slice(0, 4000),
                url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(article || title).replace(/ /g, '_'))}`,
                observed_at: inception,
                role: 'origin',
            }));
        }
        if (listText) {
            cites.push(webCitation({
                source_type: 'wikipedia',
                source_id: `${item.list || 'Wikipedia list'}#${title}`,
                quote_text: listText.slice(0, 4000),
                url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.list || 'List_of_Internet_phenomena').replace(/ /g, '_'))}`,
                observed_at: inception,
                role: 'use',
            }));
        }
        if (resolved && fact) {
            const when = fact.inception ? `First recorded: ${fact.inception}.` : '';
            cites.push(webCitation({
                source_type: 'wikidata',
                source_id: resolved.qid,
                quote_text: `Wikidata ${resolved.qid}: ${fact.label || title}${fact.description ? ` — ${fact.description}` : ''}. ${when}`.trim(),
                url: `https://www.wikidata.org/wiki/${resolved.qid}`,
                observed_at: inception,
                role: 'use',
            }));
        }
        let image = null;
        if (fact && fact.image && images.has(fact.image)) {
            image = images.get(fact.image);
            cites.push(webCitation({
                source_type: 'commons',
                source_id: fact.image,
                quote_text: `${image.license}${image.license_url ? ` (${image.license_url})` : ''}. ${image.credit}.`,
                url: image.page_url,
                observed_at: now,
                role: 'example',
            }));
        }
        if (!cites.length) return null;
        return { item, cites, inception, image, qid: resolved ? resolved.qid : null, title, lead, listText };
    }

    /**
     * Seed the encyclopedia. `limit` caps how many entries this run writes; `publish` is false for a dry run.
     * Returns the counts: found, seeded, published, kept hidden, skipped.
     */
    async function runOnce({ limit = null, publish = true } = {}) {
        const runAt = new Date(s.now()).toISOString();
        const errors = [];
        if (!judge || !judge.enabled) {
            const message = 'OpenVibe.AI is not configured: nothing was written.';
            stats.last_error = message;
            return { ok: false, seeded: 0, published: 0, kept: 0, skipped: 0, error: message };
        }
        const found = await collect();
        stats.found = found.length;
        const max = Math.min(1000, Math.max(1, Number(limit) || opts.limit || 400));

        // The facts for every name at once: a Wikipedia title → Q id, the entities, the leads, the pictures.
        const articles = [...new Set(found.map((e) => e.target).filter((t) => t && !t.includes('/')))];
        const qids = await sources.resolveQids(articles);
        const facts = await sources.entities([...qids.values()].map((v) => v.qid));
        const leads = await sources.leadExtract(articles);
        const images = await sources.imageInfo([...facts.values()].map((f) => f.image).filter(Boolean));

        let seeded = 0;
        let published = 0;
        let kept = 0;
        let skipped = 0;
        for (const item of found) {
            if (seeded >= max) break;
            try {
                const built = await buildCandidate(item, { qids, facts, leads, images });
                if (!built) { skipped++; continue; }
                // One entry per meme: a Wikidata id already seeded is left alone.
                if (built.qid) {
                    const existing = await s.db.maybe('SELECT id FROM meme_entries WHERE external_id = $1', [built.qid]);
                    if (existing) { skipped++; continue; }
                }
                const slug = slugify(built.item.title);
                const existing = await entries.bySlug(slug);
                if (existing) { skipped++; continue; }

                // The AI writes the entry from the cited text only.
                const prepared = built.cites.map((citation) => ({ citation, context: [] }));
                const verdict = await judge.judge({ id: built.title, title: built.title, kind: 'classic' }, prepared);
                const title = verdict.title || built.title;
                const decision = evaluateClassic({ judgement: verdict, minScore: opts.minScore || 0.75, entry: { title } });
                const summary = verdict.summary || built.listText.slice(0, 300);
                const created = await entries.createEntry({
                    slug,
                    title,
                    kind: 'classic',
                    summary,
                    status: 'classic',
                    first_seen_at: built.inception,
                    last_seen_at: new Date(s.now()).toISOString(),
                    visibility: publish && decision.publish ? 'public' : 'hidden',
                    citations: built.cites,
                    image_url: built.image ? built.image.url : null,
                    image_credit: built.image ? built.image.credit : null,
                    image_license: built.image ? built.image.license : null,
                    image_license_url: built.image ? built.image.license_url : null,
                    image_source_url: built.image ? built.image.page_url : null,
                    attribution: ATTRIBUTION,
                    external_id: built.qid,
                });
                await entries.saveJudgement(created.entry.id, verdict);
                await entries.logDecision({
                    entryId: created.entry.id,
                    decision: decision.publish ? 'publish' : 'keep_hidden',
                    fromStatus: 'rising',
                    toStatus: 'classic',
                    fromVisibility: 'hidden',
                    toVisibility: created.entry.visibility,
                    score: decision.score,
                    reason: decision.publish
                        ? `the AI scored it ${Number(decision.score).toFixed(2)}: ${verdict.reason || ''}`.slice(0, 500)
                        : `kept hidden: ${decision.reasons.join('; ')}`.slice(0, 500),
                });
                seeded++;
                if (decision.publish) published++;
                else kept++;
            } catch (err) {
                errors.push(`${item.title}: ${err.message}`);
                log.warn(`[OpenVibe.Meme] classics ${item.title} failed: ${err.message}`);
            }
        }
        stats.runs++;
        stats.seeded += seeded;
        stats.published += published;
        stats.kept += kept;
        stats.skipped += skipped;
        stats.errors += errors.length;
        stats.last_run_at = runAt;
        stats.last_error = errors[0] || null;
        const out = { ok: errors.length === 0, found: found.length, seeded, published, kept, skipped, errors };
        log.log(`[OpenVibe.Meme] classics: ${found.length} found, ${seeded} seeded, ${published} published, ${kept} kept hidden, ${skipped} skipped${errors.length ? `, ${errors.length} errors` : ''}`);
        return out;
    }

    return { runOnce, collect, buildCandidate, stats: () => ({ ...stats }) };
}

module.exports = { createClassicsJob, toIsoDate, yearFrom, webCitation, ATTRIBUTION };
