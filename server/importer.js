'use strict';

/**
 * The candidate importer (v1). It reads only public APIs — OpenVibe.Live's Rundown and VOD transcripts, and
 * OpenVibe.Chat's global timeline and history — and proposes a candidate entry when the same 3–6 word phrase
 * appears in at least two uses on at least two different days. A candidate is inserted hidden, with one citation
 * per use; it never publishes. Staff publish it through POST /api/v1/entries/:slug/publish.
 *
 * The job runs every 30 minutes (MEME_IMPORTER_INTERVAL_MS) and is off under MEME_DRILL; tests call runOnce().
 * A failing upstream is logged and skipped: Chat down still lets the Rundown produce candidates, and vice versa.
 * A phrase already in the table is enriched (new citations, an extended first/last range) rather than copied.
 */
const { parseApiTime } = require('./upstreams');
const { isDenied } = require('./deny-list');
const { cleanSummary } = require('./text/no-looks');
const { slugify } = require('./store');

const MIN_WORDS = 3;
const MAX_WORDS = 6;
const MAX_USES_PER_PHRASE = 25;
const STOP = new Set(('a about above actually after again against all almost alone along already also although always am among an and another any anyone anything are around as at back be became because become been before being below between both but by came can cannot cant could did didnt do does doesnt doing don dont done down during each either else enough even ever every few first for found from get gets getting give go going gone gonna got gotta great group guy guys had has have having he her here hers him himself his hi how however i id if im in into is isnt it its itself ive just kind kinda know last least less let like likely little lot made make many may maybe me mean might mine more most much must my myself near need neither never new next no nobody none nor not nothing now of off often on once one only or other others otherwise our ours out over own part people perhaps place point put quite rather really right said same saw say saying see seen several she should since small so some somebody something still such sure take tell than that thats the their them then there these they thing think this those though thought three through time to today together too took toward try turn two under until up upon us use used using very via want was way we well went were what whatever when where whether which while who why will with within without would year years yes yet you your yours yourself').split(' '));

const DAY = 86_400_000;
const nOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const displayTitle = (phrase) => phrase.charAt(0).toUpperCase() + phrase.slice(1);

function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9']+/g, ' ')
        .replace(/'+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function words(text) { return normalize(text) ? normalize(text).split(' ') : []; }
function contentCount(tokens) { return tokens.filter((w) => !STOP.has(w) && w.length > 1).length; }
function utcDay(iso) { return String(iso || '').slice(0, 10); }
function useKey(u) { return `${u.source_type}:${u.source_id}:${u.offset_seconds == null ? '' : u.offset_seconds}`; }

/**
 * Every 3–6 word window of every use, filtered to phrases that start and end with a content word and contain at
 * least two content words. Returns [{ phrase, uses }] with ≥ minUses uses on ≥ minDays days.
 */
function recurringPhrases(uses, { minUses = 2, minDays = 2 } = {}) {
    const map = new Map();
    for (const use of uses) {
        const toks = words(use.quote_text);
        if (toks.length < MIN_WORDS) continue;
        for (let n = MIN_WORDS; n <= MAX_WORDS; n++) {
            for (let i = 0; i + n <= toks.length; i++) {
                const win = toks.slice(i, i + n);
                if (STOP.has(win[0]) || STOP.has(win[n - 1])) continue;
                if (contentCount(win) < 2) continue;
                const phrase = win.join(' ');
                if (phrase.length < 12) continue;
                const list = map.get(phrase);
                if (list) { if (!list.some((u) => useKey(u) === useKey(use))) list.push(use); }
                else map.set(phrase, [use]);
            }
        }
    }
    const out = [];
    for (const [phrase, list] of map) {
        if (list.length < minUses) continue;
        const days = new Set(list.map((u) => utcDay(u.observed_at)));
        if (days.size < minDays) continue;
        if (new Set(list.map(useKey)).size < minUses) continue;
        out.push({ phrase, uses: list });
    }
    return out;
}

function detectCandidates(uses, { minUses = 2, minDays = 2, hints = '', max = 10 } = {}) {
    const found = recurringPhrases(uses, { minUses, minDays });
    for (const c of found) {
        const days = new Set(c.uses.map((u) => utcDay(u.observed_at))).size;
        c.score = c.uses.length * 10 + days * 5 + (hints.includes(c.phrase) ? 4 : 0) + Math.min(c.phrase.length, 40) / 10;
        c.days = days;
    }
    found.sort((a, b) => b.score - a.score || b.phrase.length - a.phrase.length || (a.phrase < b.phrase ? -1 : 1));
    const kept = [];
    for (const c of found) {
        if (kept.some((k) => k.phrase.includes(c.phrase) || c.phrase.includes(k.phrase))) continue;
        kept.push(c);
        if (kept.length >= max) break;
    }
    return kept;
}

function statusFor(firstSeen, lastSeen, now) {
    const first = Date.parse(firstSeen);
    const last = Date.parse(lastSeen);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return 'rising';
    if (last < now - 90 * DAY) return 'dead';
    if (first < now - 60 * DAY && last > now - 30 * DAY) return 'classic';
    if (first > now - 14 * DAY) return 'rising';
    return 'peaked';
}

function createImporter({ config, s, entries, upstreams, fetchImpl = globalThis.fetch, log = console }) {
    let timers = [];
    const stats = { runs: 0, uses: 0, candidates: 0, created: 0, enriched: 0, errors: 0, last_run_at: null, last_error: null };

    /** One openvibe.video call per (vod, sec) is enough; a 404 removes the use. */
    function resolver() {
        const cache = new Map();
        return async (vodId, sec) => {
            const key = `${vodId}:${Math.floor(Number(sec) || 0)}`;
            if (!cache.has(key)) cache.set(key, upstreams.canonicalVideo(vodId, sec).catch((err) => ({ error: err })));
            return await cache.get(key);
        };
    }

    async function collect() {
        const errors = [];
        const uses = [];
        const hints = [];
        const canon = resolver();

        // Chat: the history is verbatim; the timeline is a model paraphrase, so it is a discovery hint only and
        // never becomes a citation (there is no message id in it — research §2.1).
        try {
            const history = await upstreams.chatHistory({ limit: 200 });
            for (const m of history.messages) {
                if (Number(m.is_deleted) === 1) continue;
                if (m.message_type && m.message_type !== 'chat') continue;
                const observed = parseApiTime(m.timestamp);
                if (!observed || !normalize(m.message)) continue;
                uses.push({
                    source_service: 'chat', source_type: 'chat_message', source_id: String(m.id),
                    chat_message_id: Number(m.id), quote_text: String(m.message), observed_at: observed,
                    url: `${upstreams.base(config.upstreams.chat)}/`,
                });
            }
        } catch (err) { errors.push(`chat history: ${err.message}`); log.warn(`[OpenVibe.Meme] importer: ${err.message}`); }

        try {
            const timeline = await upstreams.chatTimeline({ limit: 60 });
            for (const e of timeline.events) hints.push(normalize(`${e.label || ''} ${e.detail || ''}`));
        } catch (err) { errors.push(`chat timeline: ${err.message}`); log.warn(`[OpenVibe.Meme] importer: ${err.message}`); }

        // Rundown: every quote is verbatim speech with a VOD second already converted to VOD time.
        const vods = new Set();
        try {
            const topics = await upstreams.rundownTopics({ limit: config.importer.maxTopics });
            for (const topic of topics) {
                let detail = null;
                try { detail = await upstreams.rundownTopic(topic.slug); } catch (err) { errors.push(`rundown ${topic.slug}: ${err.message}`); continue; }
                if (!detail) continue;
                for (const take of detail.takes) {
                    const said = parseApiTime(take.said_at) || parseApiTime(topic.last_seen_at);
                    const vodId = nOrNull(take.vod_id);
                    const streamId = nOrNull(take.stream_id);
                    if (vodId && !isDenied({ vod_id: vodId })) vods.add(vodId);
                    for (const quote of Array.isArray(take.quotes) ? take.quotes : []) {
                        const sec = nOrNull(quote.sec) != null ? nOrNull(quote.sec) : nOrNull(take.sec);
                        if (!said || !normalize(quote.text) || vodId == null || sec == null) continue;
                        if (isDenied({ vod_id: vodId })) continue;
                        uses.push({
                            source_service: 'live', source_type: 'rundown_segment', source_id: String(take.id),
                            stream_id: streamId, vod_id: vodId, offset_seconds: sec, quote_text: String(quote.text),
                            observed_at: said, url: `${upstreams.base(config.upstreams.video)}/v/${vodId}?t=${Math.floor(sec)}`,
                        });
                    }
                }
            }
        } catch (err) { errors.push(`rundown: ${err.message}`); log.warn(`[OpenVibe.Meme] importer: ${err.message}`); }

        // VOD transcripts: a segment has no date of its own, so it is used only when the VOD row gives one.
        try {
            const ids = [...vods].slice(0, config.importer.maxVods);
            const rows = {};
            for (const id of ids) {
                try { const row = await upstreams.vod(id); if (row) rows[id] = row; } catch (err) { errors.push(`vod ${id}: ${err.message}`); }
            }
            const tr = await upstreams.transcripts(ids);
            for (const [id, data] of Object.entries(tr)) {
                const row = rows[id];
                const observed = row ? parseApiTime(row.created_at || row.published_at || row.recorded_at || row.started_at) : null;
                if (!observed) continue;
                for (const seg of Array.isArray(data.segments) ? data.segments : []) {
                    if (!normalize(seg.text) || seg.text.length < 8) continue;
                    const sec = nOrNull(seg.start);
                    if (sec == null) continue;
                    uses.push({
                        source_service: 'live', source_type: 'vod', source_id: String(id), vod_id: Number(id), offset_seconds: sec,
                        quote_text: String(seg.text), observed_at: observed,
                        url: `${upstreams.base(config.upstreams.video)}/v/${id}?t=${Math.floor(sec)}`,
                    });
                }
            }
        } catch (err) { errors.push(`transcripts: ${err.message}`); log.warn(`[OpenVibe.Meme] importer: ${err.message}`); }

        return { uses, hints: hints.join(' '), errors };
    }

    /** Canonicalise a candidate's citations (the joined-VOD redirect) and drop what is gone/denied. */
    async function materialize(candidate, canon) {
        const picked = [...candidate.uses]
            .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || (a.source_type < b.source_type ? -1 : 1))
            .slice(0, MAX_USES_PER_PHRASE);
        const out = [];
        for (const u of picked) {
            if (isDenied(u)) continue;
            const c = { ...u };
            if (u.vod_id != null && u.offset_seconds != null) {
                const resolved = await canon(u.vod_id, u.offset_seconds);
                if (resolved.denied || resolved.gone || resolved.hidden) continue;
                if (!resolved.error && resolved.url) {
                    c.vod_id = resolved.vod_id;
                    c.offset_seconds = resolved.offset_seconds;
                    c.url = resolved.url;
                }
            }
            if (isDenied(c)) continue;
            out.push({ ...c, role: out.length === 0 ? 'origin' : 'use' });
        }
        return out;
    }

    async function runOnce() {
        const runAt = new Date(s.now()).toISOString();
        const { uses, hints, errors } = await collect();
        const canon = resolver();
        const found = detectCandidates(uses, {
            minUses: config.importer.minUses, minDays: config.importer.minDays, hints,
            max: Math.max(1, Number(config.importer.maxCandidates) || 10),
        });
        let created = 0;
        let enriched = 0;
        for (const candidate of found) {
            try {
                const cites = await materialize(candidate, canon);
                if (!cites.length) continue;
                const firstSeen = cites.reduce((m, c) => (Date.parse(c.observed_at) < Date.parse(m) ? c.observed_at : m), cites[0].observed_at);
                const lastSeen = cites.reduce((m, c) => (Date.parse(c.observed_at) > Date.parse(m) ? c.observed_at : m), cites[0].observed_at);
                const title = displayTitle(candidate.phrase);
                const summary = cleanSummary(title, `"${title}" recurs in ${cites.length} moments across ${new Set(cites.map((c) => utcDay(c.observed_at))).size} days on OpenVibe, from ${firstSeen.slice(0, 10)} to ${lastSeen.slice(0, 10)}.${hints.includes(candidate.phrase) ? ' Chat\'s timeline names it too.' : ''}`);
                const existing = await entries.bySlug(slugify(title));
                if (existing) {
                    const r = await entries.enrich(existing.id, { first_seen_at: firstSeen, last_seen_at: lastSeen, cites });
                    if (r && r.changed) enriched++;
                } else {
                    await entries.createCandidate({
                        slug: slugify(title), title, kind: candidate.phrase.split(' ').length <= 4 ? 'catchphrase' : 'meme',
                        summary, status: statusFor(firstSeen, lastSeen, s.now()), first_seen_at: firstSeen, last_seen_at: lastSeen,
                        visibility: 'hidden', citations: cites,
                    });
                    created++;
                }
            } catch (err) {
                errors.push(`candidate ${candidate.phrase}: ${err.message}`);
                log.warn(`[OpenVibe.Meme] importer candidate failed: ${err.message}`);
            }
        }
        stats.runs++;
        stats.uses = uses.length;
        stats.candidates = found.length;
        stats.created += created;
        stats.enriched += enriched;
        stats.errors += errors.length;
        stats.last_run_at = runAt;
        stats.last_error = errors[0] || null;
        const out = { ok: errors.length === 0, uses: uses.length, candidates: found.length, created, enriched, errors };
        log.log(`[OpenVibe.Meme] importer: ${uses.length} uses → ${found.length} candidates, ${created} created, ${enriched} enriched${errors.length ? `, ${errors.length} errors` : ''}`);
        return out;
    }

    function start() {
        if (config.drill || timers.length) return false;
        const quiet = () => runOnce().catch((err) => log.warn(`[OpenVibe.Meme] importer tick failed: ${err.message}`));
        const kick = setTimeout(quiet, 30_000);
        const tick = setInterval(quiet, config.importer.intervalMs);
        if (kick.unref) kick.unref();
        if (tick.unref) tick.unref();
        timers = [kick, tick];
        return true;
    }
    function stop() {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
    }

    return { runOnce, start, stop, stats: () => ({ ...stats, running: timers.length > 0 }) };
}

module.exports = { createImporter, detectCandidates, recurringPhrases, statusFor, normalize, STOP };
