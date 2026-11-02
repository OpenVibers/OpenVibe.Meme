'use strict';

/**
 * Meme's data: entries, their citations, status history, the week's votes, templates, saved captions and reports.
 *
 * A write that changes a public entry writes its Search document (or tombstone) in the same transaction
 * (server/search.js). A candidate is always inserted hidden; only entries.publish() makes it public, and only for
 * staff (server/http/api.js). revision goes up on every change, and every status change leaves a
 * meme_status_events row. Captions hold text lines only — no image is ever stored for a caption.
 */
const crypto = require('crypto');
const { isDenied } = require('./deny-list');
const { cleanSummary } = require('./text/no-looks');
const { weekBounds } = require('./week');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS = Object.freeze(['joke', 'catchphrase', 'bit', 'meme', 'saga', 'classic', 'format', 'event', 'person', 'phrase', 'deep_dive']);
const STATUSES = Object.freeze(['rising', 'peaked', 'classic', 'dead']);
const VISIBILITIES = Object.freeze(['public', 'unlisted', 'hidden']);
const SCOPES = Object.freeze(['openvibe', 'internet']);
// The consent plan's L1 set. A label describes content; it never bans it.
const LABELS = Object.freeze(['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers']);
const MODERATION_STATES = Object.freeze(['pending', 'approved', 'rejected']);
const CAPTION_VISIBILITIES = Object.freeze(['public', 'unlisted', 'hidden']);
const MAX_LINES = 4;
const MAX_LINE = 120;
const BLOCKED_WORDS = Object.freeze(['nigger', 'faggot', 'retard', 'kys', 'rape', 'pedo', 'nazi']);
const MEDIA_ID_RE = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TEXT = { summary: 2000, meaning: 8000, usage: 4000 };

const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const nOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const refusal = (status, code, message, field) => ({ ok: false, status, code, message, ...(field ? { field } : {}) });

function wireEntry(row) {
    if (!row) return null;
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        scope: row.scope || 'openvibe',
        summary: row.summary == null ? null : row.summary,
        meaning: row.meaning == null ? null : row.meaning,
        usage: row.usage == null ? null : row.usage,
        labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
        status: row.status,
        status_since: iso(row.status_since),
        first_seen_at: iso(row.first_seen_at),
        last_seen_at: iso(row.last_seen_at),
        visibility: row.visibility,
        revision: Number(row.revision) || 1,
        submitted_by: row.submitted_by || null,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        ...(row.uses == null ? {} : { uses: Number(row.uses) || 0 }),
        ...(row.image_url ? { image_url: row.image_url } : {}),
        ...(row.image_credit ? { image_credit: row.image_credit } : {}),
        ...(row.image_license ? { image_license: row.image_license } : {}),
        ...(row.image_license_url ? { image_license_url: row.image_license_url } : {}),
        ...(row.image_source_url ? { image_source_url: row.image_source_url } : {}),
        ...(row.attribution ? { attribution: row.attribution } : {}),
        ...(row.external_id ? { external_id: row.external_id } : {}),
    };
}

function wireJudgement(row) {
    if (!row) return null;
    let examples = row.examples;
    if (typeof examples === 'string') { try { examples = JSON.parse(examples); } catch { examples = []; } }
    return {
        entry_id: row.entry_id,
        score: Number(row.score),
        reason: row.reason,
        title: row.title == null ? null : row.title,
        summary: row.summary == null ? null : row.summary,
        origin: row.origin == null ? null : row.origin,
        spread: row.spread == null ? null : row.spread,
        examples: Array.isArray(examples) ? examples.map(String) : [],
        denied: Boolean(row.denied),
        looks: Boolean(row.looks),
        model: row.model == null ? null : row.model,
        provider: row.provider == null ? null : row.provider,
        run_id: row.run_id == null ? null : row.run_id,
        judged_at: iso(row.judged_at),
        judged_by: row.judged_by,
    };
}

function wireOrigin(row) {
    if (!row) return null;
    return {
        source: row.source,
        url: row.url,
        title: row.title,
        publisher: row.publisher == null ? null : row.publisher,
        author: row.author == null ? null : row.author,
        published_at: iso(row.published_at),
        retrieved_at: iso(row.retrieved_at),
        quote: row.quote == null ? null : row.quote,
    };
}

function wireSpread(row) {
    if (!row) return null;
    return { id: Number(row.id), observed_at: iso(row.observed_at), place: row.place, url: row.url == null ? null : row.url, count: row.count == null ? null : Number(row.count), note: row.note == null ? null : row.note };
}

function wireVariation(row) {
    if (!row) return null;
    return { id: Number(row.id), name: row.name, description: row.description == null ? null : row.description, media_id: row.media_id == null ? null : row.media_id, source_url: row.source_url == null ? null : row.source_url };
}

function wireExample(row) {
    if (!row) return null;
    return { id: Number(row.id), media_id: row.media_id, caption: row.caption == null ? null : row.caption, source_url: row.source_url == null ? null : row.source_url };
}

function wireRelated(row) {
    if (!row) return null;
    return { id: row.id, slug: row.slug, title: row.title, status: row.status, summary: row.summary == null ? null : row.summary };
}

function wireRevision(row) {
    if (!row) return null;
    let change = row.change;
    let diff = row.diff;
    if (typeof change === 'string') { try { change = JSON.parse(change); } catch { change = {}; } }
    if (typeof diff === 'string') { try { diff = JSON.parse(diff); } catch { diff = []; } }
    return {
        revision: Number(row.revision),
        author: row.author,
        base_revision: row.base_revision == null ? null : Number(row.base_revision),
        change: change || {},
        diff: Array.isArray(diff) ? diff : [],
        moderation_state: row.moderation_state,
        note: row.note == null ? null : row.note,
        created_at: iso(row.created_at),
        reviewed_at: iso(row.reviewed_at),
        reviewed_by: row.reviewed_by == null ? null : row.reviewed_by,
    };
}

function wireCitation(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        entry_id: row.entry_id,
        role: row.role,
        source_service: row.source_service,
        source_type: row.source_type,
        source_id: row.source_id,
        stream_id: nOrNull(row.stream_id),
        vod_id: nOrNull(row.vod_id),
        clip_id: nOrNull(row.clip_id),
        chat_message_id: nOrNull(row.chat_message_id),
        offset_seconds: nOrNull(row.offset_seconds),
        quote_text: row.quote_text,
        quote_hash: row.quote_hash,
        url: row.url,
        observed_at: iso(row.observed_at),
        source_status: row.source_status,
        captured_at: iso(row.captured_at),
    };
}

function wireTemplate(row) {
    if (!row) return null;
    return {
        id: row.id, name: row.name, image_url: row.image_url, box_count: Number(row.box_count), source: row.source,
        license: row.license, created_at: iso(row.created_at),
        ...(row.credit ? { credit: row.credit } : {}),
        ...(row.source_url ? { source_url: row.source_url } : {}),
        ...(row.attribution ? { attribution: row.attribution } : {}),
        ...(row.layout ? { layout: row.layout } : {}),
    };
}

function wireCaption(row) {
    if (!row) return null;
    let lines = row.lines;
    if (typeof lines === 'string') { try { lines = JSON.parse(lines); } catch { lines = []; } }
    return {
        id: row.id,
        subject: row.subject,
        template_id: row.template_id,
        lines: Array.isArray(lines) ? lines.map(String) : [],
        created_at: iso(row.created_at),
        visibility: row.visibility,
    };
}

function wireReport(row) {
    if (!row) return null;
    return {
        id: row.id,
        entry_id: row.entry_id,
        subject: row.subject,
        kind: row.kind,
        reason: row.reason,
        note: row.note == null ? null : row.note,
        status: row.status,
        created_at: iso(row.created_at),
        handled_at: iso(row.handled_at),
        handled_by: row.handled_by,
        ...(row.entry_slug ? { entry_slug: row.entry_slug } : {}),
        ...(row.entry_title ? { entry_title: row.entry_title } : {}),
    };
}

function normalizeLine(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Validate a title/kind/status patch body. Returns { ok, value } or a refusal. */
function patchFields(body) {
    const b = body && typeof body === 'object' ? body : {};
    const allowed = ['title', 'kind', 'status', 'reason'];
    const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
    if (unknown.length) return refusal(400, 'meme.invalid', `Unknown field: ${unknown[0]}`, unknown[0]);
    const out = {};
    if (b.title !== undefined) {
        const title = String(b.title == null ? '' : b.title).replace(/\s+/g, ' ').trim();
        if (!title || title.length > 160) return refusal(400, 'meme.invalid', 'title must be 1 to 160 characters', 'title');
        out.title = title;
    }
    if (b.kind !== undefined) {
        if (!KINDS.includes(b.kind)) return refusal(400, 'meme.invalid', `kind must be one of ${KINDS.join(', ')}`, 'kind');
        out.kind = b.kind;
    }
    if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return refusal(400, 'meme.invalid', `status must be one of ${STATUSES.join(', ')}`, 'status');
        out.status = b.status;
    }
    if (b.reason !== undefined) {
        const reason = String(b.reason == null ? '' : b.reason).trim().slice(0, 500);
        if (reason) out.reason = reason;
    }
    if (!Object.keys(out).some((k) => k !== 'reason')) return refusal(400, 'meme.invalid', 'Send title, kind or status', null);
    return { ok: true, value: out };
}

const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const multiline = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
const validDate = (v) => { if (v == null || v === '') return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d.toISOString(); };
const WINDOWS = Object.freeze({ day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 });

/** `day|week|month` → the ISO instant the window starts, `all`/empty → null, anything else → undefined. */
function windowStart(window, now) {
    if (window == null || window === '' || window === 'all') return null;
    const ms = WINDOWS[String(window)];
    return ms == null ? undefined : new Date(Number(now()) - ms).toISOString();
}

function labelsField(raw) {
    if (raw == null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return refusal(400, 'meme.invalid', 'labels must be an array', 'labels');
    const out = [];
    for (const v of raw) {
        const label = String(v == null ? '' : v).trim().toLowerCase();
        if (!LABELS.includes(label)) return refusal(400, 'meme.invalid', `labels must be one of ${LABELS.join(', ')}`, 'labels');
        if (!out.includes(label)) out.push(label);
    }
    return { ok: true, value: out };
}

function originField(raw, { required = false } = {}) {
    if (raw == null) return required ? refusal(400, 'meme.invalid', 'origin is required for an internet entry', 'origin') : { ok: true, value: null };
    if (typeof raw !== 'object' || Array.isArray(raw)) return refusal(400, 'meme.invalid', 'origin must be an object', 'origin');
    const allowed = ['source', 'url', 'title', 'publisher', 'author', 'published_at', 'quote'];
    const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
    if (unknown.length) return refusal(400, 'meme.invalid', `Unknown origin field: ${unknown[0]}`, 'origin');
    const url = String(raw.url == null ? '' : raw.url).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048) return refusal(400, 'meme.invalid', 'origin.url must be a public http(s) URL', 'origin.url');
    const title = text(raw.title);
    if (!title || title.length > 300) return refusal(400, 'meme.invalid', 'origin.title must be 1 to 300 characters', 'origin.title');
    const source = raw.source == null ? 'web' : String(raw.source);
    if (!['web', 'reddit', 'media', 'openvibe'].includes(source)) return refusal(400, 'meme.invalid', 'origin.source must be web, reddit, media or openvibe', 'origin.source');
    const published = validDate(raw.published_at);
    if (raw.published_at != null && raw.published_at !== '' && published === undefined) return refusal(400, 'meme.invalid', 'origin.published_at must be a date', 'origin.published_at');
    const publisher = raw.publisher == null || raw.publisher === '' ? null : text(raw.publisher).slice(0, 120);
    const author = raw.author == null || raw.author === '' ? null : text(raw.author).slice(0, 120);
    const quote = raw.quote == null || raw.quote === '' ? null : multiline(raw.quote).slice(0, 2000);
    return { ok: true, value: { source, url, title, publisher, author, published_at: published, quote } };
}

function spreadField(raw) {
    if (raw == null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return refusal(400, 'meme.invalid', 'spread must be an array', 'spread');
    if (raw.length > 100) return refusal(400, 'meme.invalid', 'spread may have at most 100 points', 'spread');
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        if (!p || typeof p !== 'object' || Array.isArray(p)) return refusal(400, 'meme.invalid', `spread[${i}] must be an object`, 'spread');
        const observed = validDate(p.observed_at);
        if (!observed) return refusal(400, 'meme.invalid', `spread[${i}].observed_at must be a date`, 'spread');
        const place = text(p.place);
        if (!place || place.length > 80) return refusal(400, 'meme.invalid', `spread[${i}].place must be 1 to 80 characters`, 'spread');
        const url = p.url == null || p.url === '' ? null : String(p.url).trim();
        if (url && (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2048)) return refusal(400, 'meme.invalid', `spread[${i}].url must be a public http(s) URL`, 'spread');
        const count = p.count == null || p.count === '' ? null : Number(p.count);
        if (count != null && (!Number.isInteger(count) || count < 0)) return refusal(400, 'meme.invalid', `spread[${i}].count must be a whole number`, 'spread');
        const note = p.note == null || p.note === '' ? null : text(p.note).slice(0, 500);
        out.push({ observed_at: observed, place, url, count, note });
    }
    return { ok: true, value: out };
}

function variationsField(raw) {
    if (raw == null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return refusal(400, 'meme.invalid', 'variations must be an array', 'variations');
    if (raw.length > 50) return refusal(400, 'meme.invalid', 'variations may have at most 50 entries', 'variations');
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const v = raw[i];
        if (!v || typeof v !== 'object' || Array.isArray(v)) return refusal(400, 'meme.invalid', `variations[${i}] must be an object`, 'variations');
        const name = text(v.name);
        if (!name || name.length > 120) return refusal(400, 'meme.invalid', `variations[${i}].name must be 1 to 120 characters`, 'variations');
        const mediaId = v.media_id == null || v.media_id === '' ? null : String(v.media_id).trim();
        if (mediaId && !MEDIA_ID_RE.test(mediaId)) return refusal(400, 'meme.invalid', `variations[${i}].media_id must be a Media object id`, 'variations');
        const sourceUrl = v.source_url == null || v.source_url === '' ? null : String(v.source_url).trim();
        if (sourceUrl && (!/^https?:\/\/[^\s]+$/i.test(sourceUrl) || sourceUrl.length > 2048)) return refusal(400, 'meme.invalid', `variations[${i}].source_url must be a public http(s) URL`, 'variations');
        out.push({ name, description: v.description == null || v.description === '' ? null : multiline(v.description).slice(0, 1000), media_id: mediaId, source_url: sourceUrl });
    }
    return { ok: true, value: out };
}

function examplesField(raw) {
    if (raw == null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return refusal(400, 'meme.invalid', 'examples must be an array', 'examples');
    if (raw.length > 50) return refusal(400, 'meme.invalid', 'examples may have at most 50 entries', 'examples');
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const e = raw[i];
        if (!e || typeof e !== 'object' || Array.isArray(e)) return refusal(400, 'meme.invalid', `examples[${i}] must be an object`, 'examples');
        const mediaId = String(e.media_id == null ? '' : e.media_id).trim();
        if (!MEDIA_ID_RE.test(mediaId)) return refusal(400, 'meme.invalid', `examples[${i}].media_id must be a Media object id`, 'examples');
        const sourceUrl = e.source_url == null || e.source_url === '' ? null : String(e.source_url).trim();
        if (sourceUrl && (!/^https?:\/\/[^\s]+$/i.test(sourceUrl) || sourceUrl.length > 2048)) return refusal(400, 'meme.invalid', `examples[${i}].source_url must be a public http(s) URL`, 'examples');
        out.push({ media_id: mediaId, caption: e.caption == null || e.caption === '' ? null : text(e.caption).slice(0, 300), source_url: sourceUrl });
    }
    return { ok: true, value: out };
}

function relatedField(raw) {
    if (raw == null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return refusal(400, 'meme.invalid', 'related must be an array of slugs', 'related');
    if (raw.length > 30) return refusal(400, 'meme.invalid', 'related may name at most 30 entries', 'related');
    const out = [];
    for (const v of raw) {
        const slug = String(v == null ? '' : v).trim();
        if (!SLUG_RE.test(slug) || slug.length > 80) return refusal(400, 'meme.invalid', 'related must be entry slugs', 'related');
        if (!out.includes(slug)) out.push(slug);
    }
    return { ok: true, value: out };
}

/** Citations are OpenVibe's own moments: validate the shape here so a proposal cannot fail inside the insert. */
function citationsField(raw) {
    if (raw == null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return refusal(400, 'meme.invalid', 'citations must be an array', 'citations');
    if (raw.length > 200) return refusal(400, 'meme.invalid', 'citations may have at most 200 entries', 'citations');
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!c || typeof c !== 'object' || Array.isArray(c)) return refusal(400, 'meme.invalid', `citations[${i}] must be an object`, 'citations');
        if (!['origin', 'use', 'example'].includes(c.role)) return refusal(400, 'meme.invalid', `citations[${i}].role must be origin, use or example`, 'citations');
        if (!['live', 'chat', 'community'].includes(c.source_service)) return refusal(400, 'meme.invalid', `citations[${i}].source_service is not a known service`, 'citations');
        if (!['chat_message', 'vod', 'clip', 'rundown_segment', 'ai_paste', 'stream_memory'].includes(c.source_type)) return refusal(400, 'meme.invalid', `citations[${i}].source_type is not a known type`, 'citations');
        if (!String(c.source_id == null ? '' : c.source_id).trim()) return refusal(400, 'meme.invalid', `citations[${i}].source_id is required`, 'citations');
        if (!String(c.quote_text == null ? '' : c.quote_text).trim()) return refusal(400, 'meme.invalid', `citations[${i}].quote_text is required`, 'citations');
        if (!/^https?:\/\/[^\s]+$/i.test(String(c.url == null ? '' : c.url))) return refusal(400, 'meme.invalid', `citations[${i}].url must be a public http(s) URL`, 'citations');
        const observed = validDate(c.observed_at);
        if (!observed) return refusal(400, 'meme.invalid', `citations[${i}].observed_at must be a date`, 'citations');
        if (c.source_status != null && !['live', 'hidden', 'gone'].includes(c.source_status)) return refusal(400, 'meme.invalid', `citations[${i}].source_status is not known`, 'citations');
        out.push({ ...c, observed_at: observed });
    }
    return { ok: true, value: out };
}
function entryFields(body, { partial = false, creation = false } = {}) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const allowed = ['title', 'slug', 'kind', 'scope', 'summary', 'meaning', 'usage', 'status', 'labels', 'first_seen_at', 'last_seen_at', 'origin', 'spread', 'variations', 'examples', 'related', 'citations', 'note'];
    const unknown = Object.keys(b).filter((k) => !allowed.includes(k) || (!creation && k === 'slug'));
    if (unknown.length) return refusal(400, 'meme.invalid', `Unknown field: ${unknown[0]}`, unknown[0]);
    const out = {};
    const changed = (key) => b[key] !== undefined;
    if (changed('title') || creation) {
        const title = text(b.title);
        if (!title || title.length > 160) return refusal(400, 'meme.invalid', 'title must be 1 to 160 characters', 'title');
        out.title = title;
    }
    if (creation) {
        const slug = text(b.slug);
        if (slug && (!SLUG_RE.test(slug) || slug.length > 80)) return refusal(400, 'meme.invalid', 'slug must be lowercase words joined by hyphens', 'slug');
        if (slug) out.slug = slug;
    }
    if (changed('kind') || creation) {
        const kind = b.kind == null ? 'meme' : String(b.kind);
        if (!KINDS.includes(kind)) return refusal(400, 'meme.invalid', `kind must be one of ${KINDS.join(', ')}`, 'kind');
        out.kind = kind;
    }
    if (changed('scope') || creation) {
        const scope = b.scope == null ? 'internet' : String(b.scope);
        if (!SCOPES.includes(scope)) return refusal(400, 'meme.invalid', `scope must be one of ${SCOPES.join(', ')}`, 'scope');
        out.scope = scope;
    }
    if (changed('status') || creation) {
        const status = b.status == null ? 'rising' : String(b.status);
        if (!STATUSES.includes(status)) return refusal(400, 'meme.invalid', `status must be one of ${STATUSES.join(', ')}`, 'status');
        out.status = status;
    }
    for (const key of ['summary', 'meaning', 'usage']) {
        if (!changed(key)) continue;
        const value = multiline(b[key]);
        if (value.length > MAX_TEXT[key]) return refusal(400, 'meme.invalid', `${key} is longer than ${MAX_TEXT[key]} characters`, key);
        out[key] = value || null;
    }
    if (changed('labels') || creation) {
        const labels = labelsField(b.labels);
        if (!labels.ok) return labels;
        out.labels = labels.value;
    }
    if (changed('first_seen_at') || creation) {
        const first = validDate(b.first_seen_at);
        if (b.first_seen_at != null && b.first_seen_at !== '' && first === undefined) return refusal(400, 'meme.invalid', 'first_seen_at must be a date', 'first_seen_at');
        out.first_seen_at = first;
    }
    if (changed('last_seen_at') || creation) {
        const last = validDate(b.last_seen_at);
        if (b.last_seen_at != null && b.last_seen_at !== '' && last === undefined) return refusal(400, 'meme.invalid', 'last_seen_at must be a date', 'last_seen_at');
        out.last_seen_at = last;
    }
    if (changed('origin') || creation) {
        const o = originField(b.origin, { required: creation && (b.scope == null || b.scope === 'internet') });
        if (!o.ok) return o;
        out.origin = o.value;
    }
    for (const [key, fn] of [['spread', spreadField], ['variations', variationsField], ['examples', examplesField], ['related', relatedField]]) {
        if (!changed(key) && !creation) continue;
        const r = fn(b[key]);
        if (!r.ok) return r;
        out[key] = r.value;
    }
    if (changed('citations')) {
        const c = citationsField(b.citations);
        if (!c.ok) return c;
        out.citations = c.value;
    } else if (creation) out.citations = [];
    if (changed('note')) out.note = text(b.note).slice(0, 1000) || null;
    if (partial && !Object.keys(out).some((k) => k !== 'note')) return refusal(400, 'meme.invalid', 'Send at least one field to change');
    return { ok: true, value: out };
}

function changeDiff(before, after) {
    const out = [];
    for (const key of ['title', 'kind', 'scope', 'summary', 'meaning', 'usage', 'status', 'labels', 'first_seen_at', 'last_seen_at', 'origin', 'spread', 'variations', 'examples', 'related']) {
        if (after[key] === undefined) continue;
        const a = before[key] === undefined ? null : before[key];
        const b = after[key];
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        out.push({ field: key, from: a, to: b });
    }
    return out;
}

/** Captions: 1–4 plain-text lines, each 1–120 characters, a small blocked-word list, no control characters. */
function captionLines(raw) {
    if (!Array.isArray(raw)) return refusal(400, 'meme.invalid', 'lines must be an array of 1 to 4 strings', 'lines');
    if (raw.length < 1 || raw.length > MAX_LINES) return refusal(400, 'meme.invalid', `lines must have 1 to ${MAX_LINES} entries`, 'lines');
    const lines = [];
    for (let i = 0; i < raw.length; i++) {
        const line = normalizeLine(raw[i]);
        if (!line) return refusal(400, 'meme.invalid', `line ${i + 1} is empty`, 'lines');
        if (line.length > MAX_LINE) return refusal(400, 'meme.invalid', `line ${i + 1} is longer than ${MAX_LINE} characters`, 'lines');
        if (/[\u0000-\u001f\u007f]/.test(String(raw[i]))) return refusal(400, 'meme.invalid', 'lines are plain text: no control characters', 'lines');
        if (BLOCKED_WORDS.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, 'i').test(line))) {
            return refusal(400, 'meme.blocked_words', 'That wording is not allowed in a caption', 'lines');
        }
        lines.push(line);
    }
    return { ok: true, lines };
}

function createStore(s, { search }) {
    const db = s.db;
    // Every write function takes an optional transaction handle; without one it runs on the pool and is its own
    // statement (no multi-statement atomicity unless the caller opens s.tx()).
    const q = (t) => t || db;

    async function bySlug(slug, t) {
        return await q(t).maybe('SELECT * FROM meme_entries WHERE slug = $1', [String(slug || '')]);
    }
    async function byId(id, t) {
        return await q(t).maybe('SELECT * FROM meme_entries WHERE id = $1', [String(id || '')]);
    }
    async function citations(entryId, t) {
        return (await q(t).many('SELECT * FROM meme_citations WHERE entry_id = $1 ORDER BY observed_at ASC, id ASC', [entryId])).map(wireCitation);
    }
    async function liveCitations(entryId, t) {
        return (await q(t).many("SELECT * FROM meme_citations WHERE entry_id = $1 AND source_status = 'live' ORDER BY observed_at ASC, id ASC", [entryId])).map(wireCitation);
    }

    async function originOf(entryId, t) {
        return wireOrigin(await q(t).maybe('SELECT * FROM meme_origins WHERE entry_id = $1', [entryId]));
    }
    async function spreadOf(entryId, t) {
        return (await q(t).many('SELECT * FROM meme_spread_points WHERE entry_id = $1 ORDER BY observed_at ASC, id ASC', [entryId])).map(wireSpread);
    }
    async function variationsOf(entryId, t) {
        return (await q(t).many('SELECT * FROM meme_variations WHERE entry_id = $1 ORDER BY id ASC', [entryId])).map(wireVariation);
    }
    async function examplesOf(entryId, t) {
        return (await q(t).many('SELECT * FROM meme_examples WHERE entry_id = $1 ORDER BY id ASC', [entryId])).map(wireExample);
    }
    async function relatedOf(entryId, t) {
        const rows = await q(t).many(
            `SELECT e.id, e.slug, e.title, e.status, e.summary FROM meme_entry_related r
             JOIN meme_entries e ON e.id = r.related_id
             WHERE r.entry_id = $1 AND e.visibility = 'public' ORDER BY e.title ASC, e.slug ASC`,
            [entryId],
        );
        return rows.map(wireRelated);
    }
    async function revisionsOf(entryId, { staff = false } = {}, t) {
        const where = staff ? 'entry_id = $1' : "entry_id = $1 AND moderation_state = 'approved'";
        return (await q(t).many(`SELECT * FROM meme_entry_revisions WHERE ${where} ORDER BY revision DESC`, [entryId])).map(wireRevision);
    }
    /** Everything one entry page needs. The caller decides visibility; this never filters by it. */
    async function detail(row, { staff = false } = {}) {
        const [cites, origin, spread, variations, examples, related, revisions] = await Promise.all([
            citations(row.id), originOf(row.id), spreadOf(row.id), variationsOf(row.id), examplesOf(row.id), relatedOf(row.id), revisionsOf(row.id, { staff }),
        ]);
        return {
            ...wireEntry(row),
            origin: origin || cites.find((c) => c.role === 'origin') || cites[0] || null,
            web_origin: origin,
            citations: cites,
            timeline: cites.filter((c) => c.role !== 'example'),
            examples: [...cites.filter((c) => c.role === 'example'), ...examples],
            spread, variations, related, revisions,
        };
    }

    /** Public entries. `sort=newest` is a (first_seen_at, id) keyset; `sort=top` counts live uses in `window`. */
    async function list({ limit = 20, cursor = null, kind = null, status = null, scope = null, q: query = null, label = null,
        sort = 'newest', window = null, channel = null } = {}) {
        const n = Math.min(50, Math.max(1, Number(limit) || 20));
        if (kind && !KINDS.includes(kind)) return { entry: null, error: 'kind' };
        if (status && !STATUSES.includes(status)) return { entry: null, error: 'status' };
        if (scope && !SCOPES.includes(scope)) return { entry: null, error: 'scope' };
        if (label && !LABELS.includes(String(label).toLowerCase())) return { entry: null, error: 'label' };
        if (sort !== 'newest' && sort !== 'top') return { entry: null, error: 'sort' };
        const since = windowStart(window, s.now);
        if (window != null && window !== '' && since === undefined) return { entry: null, error: 'window' };
        const args = [];
        let where = "e.visibility = 'public'";
        let usesExpr = 'NULL::integer';
        if (since) {
            args.push(since);
            usesExpr = `(SELECT COUNT(*)::int FROM meme_citations c WHERE c.entry_id = e.id AND c.source_status = 'live' AND c.observed_at >= $${args.length}::timestamptz)`;
        } else if (channel != null || sort === 'top') {
            usesExpr = "(SELECT COUNT(*)::int FROM meme_citations c WHERE c.entry_id = e.id AND c.source_status = 'live')";
        }
        if (kind) { args.push(kind); where += ` AND e.kind = $${args.length}`; }
        if (status) { args.push(status); where += ` AND e.status = $${args.length}`; }
        if (scope) { args.push(scope); where += ` AND e.scope = $${args.length}`; }
        if (label) { args.push(String(label).toLowerCase()); where += ` AND e.labels @> ARRAY[$${args.length}]::text[]`; }
        if (query) {
            args.push(`%${String(query).trim().replace(/[\\%_]/g, '\\$&')}%`);
            const at = args.length;
            where += ` AND (e.title ILIKE $${at} ESCAPE '\\' OR e.summary ILIKE $${at} ESCAPE '\\' OR e.meaning ILIKE $${at} ESCAPE '\\' OR e.usage ILIKE $${at} ESCAPE '\\' OR e.slug ILIKE $${at} ESCAPE '\\')`;
        }
        if (channel != null) {
            const stream = Number.parseInt(channel, 10);
            if (!Number.isFinite(stream) || stream < 1) return { entry: null, error: 'channel' };
            args.push(stream);
            where += ` AND EXISTS (SELECT 1 FROM meme_citations c WHERE c.entry_id = e.id AND c.stream_id = $${args.length})`;
        }
        if (sort === 'newest' && cursor) {
            let pos = null;
            try {
                const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
                if (typeof decoded.t === 'string' && typeof decoded.i === 'string' && !Number.isNaN(Date.parse(decoded.t))) pos = decoded;
            } catch { /* an unreadable cursor is refused by the caller */ }
            if (!pos) return { entry: null, error: 'cursor' };
            args.push(pos.t, pos.i);
            where += ` AND (e.first_seen_at, e.id) < ($${args.length - 1}::timestamptz, $${args.length})`;
        }
        args.push(n + 1);
        const order = sort === 'top' ? `uses DESC, e.last_seen_at DESC, e.id DESC` : 'e.first_seen_at DESC, e.id DESC';
        const rows = await db.many(`SELECT e.*, ${usesExpr} AS uses FROM meme_entries e WHERE ${where} ORDER BY ${order} LIMIT $${args.length}`, args);
        const hasMore = rows.length > n;
        const page = rows.slice(0, n);
        const last = page[page.length - 1];
        return {
            entries: page.map(wireEntry),
            next_cursor: sort === 'newest' && hasMore && last ? Buffer.from(JSON.stringify({ t: iso(last.first_seen_at), i: last.id })).toString('base64url') : null,
        };
    }

    async function trending({ limit = 20 } = {}) {
        const n = Math.min(50, Math.max(1, Number(limit) || 20));
        const rows = await db.many(
            `SELECT * FROM meme_entries WHERE visibility = 'public'
             ORDER BY CASE status WHEN 'rising' THEN 0 WHEN 'peaked' THEN 1 WHEN 'classic' THEN 2 WHEN 'dead' THEN 3 ELSE 4 END,
                      last_seen_at DESC, id DESC LIMIT $1`,
            [n],
        );
        return rows.map(wireEntry);
    }

    /** The current week's candidates (public entries with a live use that week) and their ballot counts. */
    async function week({ week: label, subject = null } = {}) {
        const bounds = weekBounds(label);
        if (!bounds) return null;
        const rows = await db.many(
            `SELECT e.*,
                    (SELECT COUNT(*)::int FROM meme_votes v WHERE v.week = $1 AND v.entry_id = e.id) AS votes,
                    (SELECT COUNT(*)::int FROM meme_votes v WHERE v.week = $1 AND v.entry_id = e.id AND v.subject = $2) AS mine
             FROM meme_entries e
             WHERE e.visibility = 'public'
               AND EXISTS (SELECT 1 FROM meme_citations c
                           WHERE c.entry_id = e.id AND c.source_status = 'live'
                             AND c.observed_at >= $3::timestamptz AND c.observed_at < $4::timestamptz)
             ORDER BY votes DESC, e.last_seen_at DESC, e.id DESC LIMIT 30`,
            [label, subject, bounds.start, bounds.end],
        );
        return {
            week: label,
            starts_at: bounds.start,
            ends_at: bounds.end,
            candidates: rows.map((r) => ({ ...wireEntry(r), votes: Number(r.votes) || 0, mine: Number(r.mine) > 0 })),
        };
    }

    /** Uses per UTC day over the last `days` days, zero-filled so a chart has no holes. */
    async function series(entryId, { days = 30 } = {}) {
        const n = Math.min(365, Math.max(1, Number(days) || 30));
        const now = new Date(s.now());
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        start.setUTCDate(start.getUTCDate() - (n - 1));
        const rows = await db.many(
            `SELECT to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS uses
             FROM meme_citations
             WHERE entry_id = $1 AND role IN ('origin', 'use') AND source_status = 'live'
               AND observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz
             GROUP BY 1 ORDER BY 1`,
            [entryId, start.toISOString(), now.toISOString()],
        );
        const counts = new Map(rows.map((r) => [r.day, Number(r.uses) || 0]));
        const out = [];
        for (let i = 0; i < n; i++) {
            const d = new Date(start.getTime() + i * 86_400_000);
            const day = d.toISOString().slice(0, 10);
            out.push({ day, uses: counts.get(day) || 0 });
        }
        return { days: n, from: start.toISOString(), to: now.toISOString(), series: out };
    }

    /** The id for a slug, appending -2, -3… when one is already taken. */
    async function uniqueSlug(base, t) {
        const root = String(base || 'meme').slice(0, 70).replace(/^-+|-+$/g, '') || 'meme';
        let slug = root;
        for (let i = 2; i < 200; i++) {
            const found = await q(t).maybe('SELECT id FROM meme_entries WHERE slug = $1', [slug]);
            if (!found) return slug;
            slug = `${root}-${i}`;
        }
        return `${root}-${Date.now().toString(36)}`;
    }

    /**
     * Insert one entry and its citations in the caller's transaction. A candidate is inserted hidden; an
     * encyclopedia entry ('classic') is inserted public. Citations that name the deny list are dropped here too.
     */
    async function createEntry({
        slug = null, title, kind = 'meme', summary = null, status = 'rising', first_seen_at, last_seen_at,
        visibility = 'hidden', citations: cites = [], image_url = null, image_credit = null, image_license = null,
        image_license_url = null, image_source_url = null, attribution = null, external_id = null,
    }, t = null) {
        const run = async (tx) => {
            const id = s.newId('mem');
            const cleanSlug = await uniqueSlug(slug || slugify(title), tx);
            const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Untitled meme';
            const cleanKind = KINDS.includes(kind) ? kind : 'meme';
            let first = iso(first_seen_at) || s.iso();
            let last = iso(last_seen_at) || first;
            if (Date.parse(first) > Date.parse(last)) { const swap = first; first = last; last = swap; }
            const row = await q(tx).maybe(
                `INSERT INTO meme_entries (id, slug, title, kind, summary, status, status_since, first_seen_at, last_seen_at, visibility, revision, created_at, updated_at,
                    image_url, image_credit, image_license, image_license_url, image_source_url, attribution, external_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10, 1, now(), now(),
                    $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
                [id, cleanSlug, cleanTitle, cleanKind, cleanSummary(cleanTitle, summary), status, iso(last), first, last, visibility,
                    image_url || null, image_credit || null, image_license || null, image_license_url || null, image_source_url || null,
                    attribution || null, external_id || null],
            );
            const added = await addCitations(row.id, cites, tx);
            await q(tx).exec(
                `INSERT INTO meme_entry_revisions (entry_id, revision, author, base_revision, change, diff, moderation_state, created_at, reviewed_at, reviewed_by)
                 VALUES ($1, 1, 'service:meme', NULL, $2::jsonb, '[]'::jsonb, 'approved', now(), now(), 'service:meme') ON CONFLICT DO NOTHING`,
                [row.id, JSON.stringify({ title: cleanTitle, kind, summary: row.summary, status, scope: 'openvibe', labels: [] })],
            );
            const entry = wireEntry(row);
            if (entry.visibility === 'public') await search.sync(tx, entry, added);
            return { entry, citations: added };
        };
        return t ? await run(t) : await s.tx(run);
    }

    /** A candidate is an entry that stays hidden until the judge clears it. */
    async function createCandidate(opts, t = null) {
        return await createEntry({ ...opts, visibility: opts.visibility || 'hidden' }, t);
    }

    /** Insert citations in the caller's transaction; the sha256 is computed from the verbatim quote. */
    async function addCitations(entryId, cites = [], t = null) {
        const run = async (tx) => {
            const out = [];
            for (const c of Array.isArray(cites) ? cites : []) {
                if (!c || isDenied(c)) continue;
                const quote = String(c.quote_text == null ? '' : c.quote_text);
                if (!quote.trim()) continue;
                const role = c.role === 'origin' || c.role === 'example' ? c.role : 'use';
                const observed = iso(c.observed_at) || s.iso();
                const row = await q(tx).maybe(
                    `INSERT INTO meme_citations (entry_id, role, source_service, source_type, source_id, stream_id, vod_id, clip_id, chat_message_id,
                        offset_seconds, quote_text, quote_hash, url, observed_at, source_status, captured_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15, now())
                     ON CONFLICT DO NOTHING RETURNING *`,
                    [entryId, role, c.source_service, c.source_type, String(c.source_id).slice(0, 200), c.stream_id == null ? null : Number(c.stream_id),
                        c.vod_id == null ? null : Number(c.vod_id), c.clip_id == null ? null : Number(c.clip_id),
                        c.chat_message_id == null ? null : Number(c.chat_message_id), c.offset_seconds == null ? null : Number(c.offset_seconds),
                        quote, sha256(quote), String(c.url), observed, c.source_status || 'live'],
                );
                if (row) out.push(wireCitation(row));
            }
            return out;
        };
        return t ? await run(t) : await s.tx(run);
    }

    /** Add uses to an existing candidate, extend its range and bump its revision only when something changed. */
    async function enrich(entryId, { first_seen_at, last_seen_at, cites = [] }) {
        return await s.tx(async (t) => {
            const row = await byId(entryId, t);
            if (!row) return null;
            const first = iso(first_seen_at) || iso(row.first_seen_at);
            const last = iso(last_seen_at) || iso(row.last_seen_at);
            const added = await addCitations(entryId, cites, t);
            const earlier = Date.parse(first) < Date.parse(iso(row.first_seen_at));
            const later = Date.parse(last) > Date.parse(iso(row.last_seen_at));
            if (!added.length && !earlier && !later) return { entry: wireEntry(row), added: 0, changed: false };
            const updated = await t.maybe(
                `UPDATE meme_entries SET first_seen_at = LEAST(first_seen_at, $2::timestamptz), last_seen_at = GREATEST(last_seen_at, $3::timestamptz),
                   revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`,
                [entryId, first, last],
            );
            const all = await liveCitations(entryId, t);
            if (updated.visibility === 'public') await search.sync(t, wireEntry(updated), all);
            return { entry: wireEntry(updated), added: added.length, changed: true };
        });
    }

    /** A citation changed (a redirect, or a use went away) while the entry stayed public: a new revision and document. */
    async function reindex(entryId, { changedBy = 'service:meme:reverify' } = {}) {
        return await s.tx(async (t) => {
            const row = await byId(entryId, t);
            if (!row || row.visibility !== 'public') return { ok: false, unchanged: true };
            const updated = await t.maybe('UPDATE meme_entries SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *', [row.id]);
            const all = await liveCitations(row.id, t);
            await search.sync(t, wireEntry(updated), all);
            return { ok: true, entry: wireEntry(updated) };
        });
    }

    /** Upsert the internet origin (a public page). */
    async function setOrigin(entryId, origin, t) {
        if (!origin) { await q(t).exec('DELETE FROM meme_origins WHERE entry_id = $1', [entryId]); return; }
        await q(t).exec(
            `INSERT INTO meme_origins (entry_id, source, url, title, publisher, author, published_at, retrieved_at, quote)
             VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, now(), $8)
             ON CONFLICT (entry_id) DO UPDATE SET source = EXCLUDED.source, url = EXCLUDED.url, title = EXCLUDED.title,
                publisher = EXCLUDED.publisher, author = EXCLUDED.author, published_at = EXCLUDED.published_at,
                retrieved_at = now(), quote = EXCLUDED.quote`,
            [entryId, origin.source || 'web', origin.url, origin.title, origin.publisher || null, origin.author || null, origin.published_at || null, origin.quote || null],
        );
    }

    async function setSpread(entryId, points, t) {
        await q(t).exec('DELETE FROM meme_spread_points WHERE entry_id = $1', [entryId]);
        for (const p of points) {
            await q(t).exec(
                'INSERT INTO meme_spread_points (entry_id, observed_at, place, url, count, note) VALUES ($1, $2::timestamptz, $3, $4, $5, $6)',
                [entryId, p.observed_at, p.place, p.url || null, p.count == null ? null : p.count, p.note || null],
            );
        }
    }

    async function setVariations(entryId, list, t) {
        await q(t).exec('DELETE FROM meme_variations WHERE entry_id = $1', [entryId]);
        for (const v of list) {
            await q(t).exec('INSERT INTO meme_variations (entry_id, name, description, media_id, source_url) VALUES ($1, $2, $3, $4, $5)',
                [entryId, v.name, v.description || null, v.media_id || null, v.source_url || null]);
        }
    }

    async function setExamples(entryId, list, t) {
        await q(t).exec('DELETE FROM meme_examples WHERE entry_id = $1', [entryId]);
        for (const e of list) {
            await q(t).exec('INSERT INTO meme_examples (entry_id, media_id, caption, source_url) VALUES ($1, $2, $3, $4)',
                [entryId, e.media_id, e.caption || null, e.source_url || null]);
        }
    }

    async function setRelated(entryId, slugs, t) {
        const checked = await checkRelated(slugs, t);
        if (!checked.ok) return checked;
        const ids = checked.ids.filter((id) => id !== entryId);
        await q(t).exec('DELETE FROM meme_entry_related WHERE entry_id = $1', [entryId]);
        for (const id of ids) await q(t).exec('INSERT INTO meme_entry_related (entry_id, related_id) VALUES ($1, $2)', [entryId, id]);
        return { ok: true };
    }

    /** Resolve related slugs before any write, so a missing slug never leaves a half-applied revision. */
    async function checkRelated(slugs, t) {
        const ids = [];
        for (const slug of slugs || []) {
            const rel = await q(t).maybe('SELECT id FROM meme_entries WHERE slug = $1', [slug]);
            if (!rel) return refusal(400, 'meme.invalid', `related names no entry: ${slug}`, 'related');
            if (!ids.includes(rel.id)) ids.push(rel.id);
        }
        return { ok: true, ids };
    }

    async function allRelatedSlugs(entryId, t) {
        return (await q(t).many(
            `SELECT e.slug FROM meme_entry_related r JOIN meme_entries e ON e.id = r.related_id WHERE r.entry_id = $1 ORDER BY e.slug`,
            [entryId],
        )).map((r) => r.slug);
    }

    /** The entry as a revision sees it (only the fields a revision may change). */
    async function snapshot(row, t) {
        return {
            title: row.title, kind: row.kind, scope: row.scope, summary: row.summary, meaning: row.meaning, usage: row.usage,
            status: row.status, labels: wireEntry(row).labels, first_seen_at: iso(row.first_seen_at), last_seen_at: iso(row.last_seen_at),
            origin: await originOf(row.id, t), spread: await spreadOf(row.id, t), variations: await variationsOf(row.id, t),
            examples: await examplesOf(row.id, t), related: await allRelatedSlugs(row.id, t),
        };
    }

    /** Copy a validated change onto the entry. Caller owns the transaction. */
    async function applyChange(t, row, v, revision) {
        if (v.scope === 'internet' && v.origin === undefined && !await originOf(row.id, t)) {
            return refusal(400, 'meme.invalid', 'An internet entry needs an origin.', 'origin');
        }
        if (v.related !== undefined) {
            const rel = await checkRelated(v.related, t);
            if (!rel.ok) return rel;
        }
        const sets = [];
        const args = [row.id];
        for (const key of ['title', 'kind', 'scope', 'summary', 'meaning', 'usage', 'status']) {
            if (v[key] === undefined) continue;
            args.push(v[key]);
            sets.push(`${key} = $${args.length}`);
        }
        let first = v.first_seen_at === undefined ? iso(row.first_seen_at) : v.first_seen_at;
        let last = v.last_seen_at === undefined ? iso(row.last_seen_at) : v.last_seen_at;
        if (Date.parse(first) > Date.parse(last)) { const swap = first; first = last; last = swap; }
        args.push(first, last);
        sets.push(`first_seen_at = $${args.length - 1}::timestamptz`, `last_seen_at = $${args.length}::timestamptz`);
        if (v.labels !== undefined) { args.push(v.labels); sets.push(`labels = $${args.length}::text[]`); }
        if (v.status !== undefined && v.status !== row.status) sets.push('status_since = now()');
        args.push(revision);
        const updated = await t.maybe(
            `UPDATE meme_entries SET ${sets.join(', ')}, revision = $${args.length}, updated_at = now() WHERE id = $1 RETURNING *`,
            args,
        );
        if (v.status !== undefined && v.status !== row.status) {
            await t.exec('INSERT INTO meme_status_events (entry_id, from_status, to_status, reason, changed_by) VALUES ($1, $2, $3, $4, $5)',
                [row.id, row.status, v.status, v.note || null, 'service:meme:revision']);
        }
        if (v.origin !== undefined) {
            const nextScope = v.scope === undefined ? row.scope : v.scope;
            if (!v.origin && nextScope === 'internet') return refusal(400, 'meme.invalid', 'An internet entry needs an origin; it cannot be removed.', 'origin');
            await setOrigin(row.id, v.origin, t);
        }
        if (v.spread !== undefined) await setSpread(row.id, v.spread, t);
        if (v.variations !== undefined) await setVariations(row.id, v.variations, t);
        if (v.examples !== undefined) await setExamples(row.id, v.examples, t);
        if (v.related !== undefined) {
            const rel = await setRelated(row.id, v.related, t);
            if (!rel.ok) return rel;
        }
        if (v.citations !== undefined) await addCitations(row.id, v.citations, t);
        if (updated.visibility === 'public') {
            const all = await liveCitations(row.id, t);
            await search.sync(t, wireEntry(updated), all);
        }
        return { ok: true, entry: wireEntry(updated) };
    }

    /**
     * A signed-in person's proposal: an entry born hidden, with revision 1 pending. Staff creations are public and
     * approved at once. The proposal's fields are visible to its author and staff; publish stays a separate step.
     */
    async function createProposal({ body, author, staff = false } = {}) {
        const checked = entryFields(body, { creation: true });
        if (!checked.ok) return checked;
        const v = checked.value;
        if (v.scope === 'internet' && !v.origin) return refusal(400, 'meme.invalid', 'origin is required for an internet entry', 'origin');
        if (v.scope === 'openvibe' && !v.origin && !(v.citations || []).some((c) => c && c.role === 'origin')) {
            return refusal(400, 'meme.invalid', 'An OpenVibe entry needs an origin citation.', 'citations');
        }
        return await s.tx(async (t) => {
            const relCheck = await checkRelated(v.related, t);
            if (!relCheck.ok) return relCheck;
            const id = s.newId('mem');
            const slug = await uniqueSlug(v.slug || slugify(v.title), t);
            let first = v.first_seen_at || (v.origin && v.origin.published_at) || s.iso();
            let last = v.last_seen_at || s.iso();
            if (Date.parse(first) > Date.parse(last)) { const swap = first; first = last; last = swap; }
            const visibility = staff ? 'public' : 'hidden';
            const row = await t.maybe(
                `INSERT INTO meme_entries (id, slug, title, kind, scope, summary, meaning, usage, labels, status, status_since, first_seen_at, last_seen_at, visibility, revision, submitted_by, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11::timestamptz, $12::timestamptz, $13::timestamptz, $14, 1, $15, now(), now()) RETURNING *`,
                [id, slug, v.title, v.kind, v.scope, staff ? cleanSummary(v.title, v.summary) : v.summary, v.meaning, v.usage,
                    v.labels, v.status, last, first, last, visibility, staff ? null : author],
            );
            if (v.origin) await setOrigin(row.id, v.origin, t);
            await setSpread(row.id, v.spread, t);
            await setVariations(row.id, v.variations, t);
            await setExamples(row.id, v.examples, t);
            const rel = await setRelated(row.id, v.related, t);
            if (!rel.ok) return rel;
            const cites = await addCitations(row.id, v.citations, t);
            const state = staff ? 'approved' : 'pending';
            const change = { ...v, labels: v.labels };
            await t.exec(
                `INSERT INTO meme_entry_revisions (entry_id, revision, author, base_revision, change, diff, moderation_state, note, created_at, reviewed_at, reviewed_by)
                 VALUES ($1, 1, $2, NULL, $3::jsonb, $4::jsonb, $5, $6, now(), $7::timestamptz, $8)`,
                [row.id, staff ? 'service:meme' : author, JSON.stringify(change), JSON.stringify(changeDiff({}, change)), state,
                    v.note || null, staff ? s.iso() : null, staff ? 'service:meme' : null],
            );
            if (visibility === 'public') await search.sync(t, wireEntry(row), cites);
            const revision = wireRevision(await t.maybe('SELECT * FROM meme_entry_revisions WHERE entry_id = $1 AND revision = 1', [row.id]));
            return { ok: true, entry: wireEntry(row), citations: cites, revision, detail: await detail(row) };
        });
    }

    /** A proposed edit. Staff edits apply at once; a person's waits for a reviewer. */
    async function addRevision(slug, { body, author, staff = false } = {}) {
        const checked = entryFields(body, { partial: true });
        if (!checked.ok) return checked;
        const v = checked.value;
        return await s.tx(async (t) => {
            const row = await bySlug(slug, t);
            if (!row) return refusal(404, 'meme.not_found', 'No such meme.');
            const before = await snapshot(row, t);
            const diff = changeDiff(before, v);
            if (!diff.length && !v.note) return refusal(409, 'meme.no_change', 'That revision changes nothing.');
            const next = Number(await t.value('SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM meme_entry_revisions WHERE entry_id = $1', [row.id]));
            const state = staff ? 'approved' : 'pending';
            if (staff) {
                const applied = await applyChange(t, row, v, next);
                if (!applied.ok) return applied;
            } else if (row.scope === 'internet' && v.origin === null) {
                return refusal(400, 'meme.invalid', 'An internet entry needs an origin; it cannot be removed.', 'origin');
            }
            await t.exec(
                `INSERT INTO meme_entry_revisions (entry_id, revision, author, base_revision, change, diff, moderation_state, note, created_at, reviewed_at, reviewed_by)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, now(), $9::timestamptz, $10)`,
                [row.id, next, author, row.revision, JSON.stringify(v), JSON.stringify(diff), state, v.note || null,
                    staff ? s.iso() : null, staff ? author : null],
            );
            const revision = wireRevision(await t.maybe('SELECT * FROM meme_entry_revisions WHERE entry_id = $1 AND revision = $2', [row.id, next]));
            return { ok: true, entry: staff ? wireEntry(await bySlug(slug, t)) : wireEntry(row), revision };
        });
    }

    /** Staff review of one pending revision. Approving copies it onto the entry and re-indexes it. */
    async function reviewRevision(slug, revision, { state, reviewedBy, note = null } = {}) {
        if (!MODERATION_STATES.includes(state) || state === 'pending') return refusal(400, 'meme.invalid', 'state must be approved or rejected', 'state');
        return await s.tx(async (t) => {
            const row = await bySlug(slug, t);
            if (!row) return refusal(404, 'meme.not_found', 'No such meme.');
            const rev = await t.maybe('SELECT * FROM meme_entry_revisions WHERE entry_id = $1 AND revision = $2', [row.id, Number(revision)]);
            if (!rev) return refusal(404, 'meme.not_found', 'No such revision.');
            if (rev.moderation_state !== 'pending') return refusal(409, 'meme.revision_reviewed', `This revision is already ${rev.moderation_state}.`);
            if (state === 'approved' && Number(row.revision) < Number(rev.revision)) {
                let change = rev.change;
                if (typeof change === 'string') { try { change = JSON.parse(change); } catch { change = {}; } }
                const applied = await applyChange(t, row, change || {}, Number(rev.revision));
                if (!applied.ok) return applied;
            }
            const saved = await t.maybe(
                `UPDATE meme_entry_revisions SET moderation_state = $3, reviewed_at = now(), reviewed_by = $4, note = COALESCE($5, note)
                 WHERE entry_id = $1 AND revision = $2 RETURNING *`,
                [row.id, Number(revision), state, reviewedBy, note],
            );
            return { ok: true, revision: wireRevision(saved), entry: wireEntry(await bySlug(slug, t)) };
        });
    }

    /** The moderation queue: pending revisions with their entry's slug and title. */
    async function pendingRevisions({ limit = 50 } = {}) {
        const rows = await db.many(
            `SELECT r.*, e.slug AS entry_slug, e.title AS entry_title FROM meme_entry_revisions r
             JOIN meme_entries e ON e.id = r.entry_id
             WHERE r.moderation_state = 'pending' ORDER BY r.created_at ASC, r.entry_id ASC LIMIT $1`,
            [Math.min(200, Math.max(1, Number(limit) || 50))],
        );
        return rows.map((r) => ({ ...wireRevision(r), entry_slug: r.entry_slug, entry_title: r.entry_title }));
    }

    async function publish(slug, { changedBy = 'service:meme' } = {}) {
        return await s.tx(async (t) => {
            const row = await bySlug(slug, t);
            if (!row) return refusal(404, 'meme.not_found', 'No such meme.');
            const citationOrigin = await t.maybe("SELECT id FROM meme_citations WHERE entry_id = $1 AND role = 'origin' AND source_status = 'live' LIMIT 1", [row.id]);
            const webOrigin = await t.maybe('SELECT entry_id FROM meme_origins WHERE entry_id = $1', [row.id]);
            if (!citationOrigin && !webOrigin) return refusal(409, 'meme.origin_gone', 'The origin citation is missing or gone; this entry cannot be published.');
            if (row.visibility === 'public') return { ok: true, entry: wireEntry(row), unchanged: true };
            const updated = await t.maybe('UPDATE meme_entries SET visibility = $2, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *', [row.id, 'public']);
            const all = await liveCitations(row.id, t);
            await search.sync(t, wireEntry(updated), all);
            return { ok: true, entry: wireEntry(updated), unchanged: false };
        });
    }

    async function hide(slug, { changedBy = 'service:meme' } = {}) {
        return await s.tx(async (t) => {
            const row = await bySlug(slug, t);
            if (!row) return refusal(404, 'meme.not_found', 'No such meme.');
            if (row.visibility === 'hidden') return { ok: true, entry: wireEntry(row), unchanged: true };
            const updated = await t.maybe('UPDATE meme_entries SET visibility = $2, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *', [row.id, 'hidden']);
            await search.sync(t, wireEntry(updated), []);
            return { ok: true, entry: wireEntry(updated), unchanged: false };
        });
    }

    async function patch(slug, { body, changedBy = 'service:meme' } = {}) {
        const checked = patchFields(body);
        if (!checked.ok) return checked;
        const v = checked.value;
        return await s.tx(async (t) => {
            const row = await bySlug(slug, t);
            if (!row) return refusal(404, 'meme.not_found', 'No such meme.');
            const sets = [];
            const args = [row.id];
            for (const key of ['title', 'kind', 'status']) {
                if (v[key] !== undefined) { args.push(v[key]); sets.push(`${key} = $${args.length}`); }
            }
            if (v.status !== undefined && v.status !== row.status) sets.push('status_since = now()');
            const updated = await t.maybe(
                `UPDATE meme_entries SET ${sets.join(', ')}, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`,
                args,
            );
            if (v.status !== undefined && v.status !== row.status) {
                await t.exec('INSERT INTO meme_status_events (entry_id, from_status, to_status, reason, changed_by) VALUES ($1, $2, $3, $4, $5)',
                    [row.id, row.status, v.status, v.reason || null, changedBy]);
            }
            const diff = ['title', 'kind', 'status'].filter((k) => v[k] !== undefined && v[k] !== row[k])
                .map((k) => ({ field: k, from: row[k], to: v[k] }));
            if (diff.length) {
                await t.exec(
                    `INSERT INTO meme_entry_revisions (entry_id, revision, author, base_revision, change, diff, moderation_state, note, created_at, reviewed_at, reviewed_by)
                     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'approved', $7, now(), now(), $3) ON CONFLICT DO NOTHING`,
                    [row.id, updated.revision, changedBy, row.revision, JSON.stringify(v), JSON.stringify(diff), v.reason || null],
                );
            }
            // A hidden entry has no Search document to correct; only a public one is re-indexed here.
            if (updated.visibility === 'public') {
                const all = await liveCitations(row.id, t);
                await search.sync(t, wireEntry(updated), all);
            }
            return { ok: true, entry: wireEntry(updated), unchanged: false };
        });
    }

    async function templates() {
        return (await db.many('SELECT * FROM meme_templates ORDER BY box_count ASC, name ASC')).map(wireTemplate);
    }
    async function templateById(id) {
        return wireTemplate(await db.maybe('SELECT * FROM meme_templates WHERE id = $1', [String(id || '')]));
    }

    /**
     * One template, written from an open source: its picture, where the picture came from, under which licence and
     * who made it. A template that is already there is left alone.
     */
    async function addTemplate({ id, name, image_url, box_count = 2, source, license, credit = null, source_url = null, attribution = null }) {
        const row = await db.maybe(
            `INSERT INTO meme_templates (id, name, image_url, box_count, source, license, credit, source_url, attribution)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO NOTHING RETURNING *`,
            [String(id || ''), String(name || '').slice(0, 80), String(image_url || ''), Math.max(1, Math.min(8, Number(box_count) || 2)),
                String(source || ''), String(license || ''), credit || null, source_url || null, attribution || null],
        );
        return wireTemplate(row || await db.maybe('SELECT * FROM meme_templates WHERE id = $1', [String(id || '')]));
    }

    async function createCaption({ subject, templateId, lines, visibility = 'public' }) {
        if (!CAPTION_VISIBILITIES.includes(visibility)) return refusal(400, 'meme.invalid', `visibility must be one of ${CAPTION_VISIBILITIES.join(', ')}`, 'visibility');
        const checked = captionLines(lines);
        if (!checked.ok) return checked;
        const tpl = await db.maybe('SELECT id FROM meme_templates WHERE id = $1', [String(templateId || '')]);
        if (!tpl) return refusal(404, 'meme.template_not_found', 'No such template.');
        const id = s.newId('mcp');
        const row = await db.maybe(
            `INSERT INTO meme_captions (id, subject, template_id, lines, created_at, visibility)
             VALUES ($1, $2, $3, $4::jsonb, now(), $5) RETURNING *`,
            [id, subject, tpl.id, JSON.stringify(checked.lines), visibility],
        );
        return { ok: true, caption: wireCaption(row) };
    }

    async function captionById(id) {
        return wireCaption(await db.maybe('SELECT * FROM meme_captions WHERE id = $1', [String(id || '')]));
    }

    async function captionCountForTemplate(templateId) {
        return Number(await db.value("SELECT COUNT(*)::int AS n FROM meme_captions WHERE template_id = $1 AND visibility = 'public'", [templateId])) || 0;
    }

    async function castVote({ subject, entryId, week }) {
        const bounds = weekBounds(week);
        if (!bounds) return refusal(400, 'meme.invalid', 'week must be YYYY-Www');
        const row = await db.maybe(
            `SELECT e.* FROM meme_entries e
             WHERE e.id = $1 AND e.visibility = 'public'
               AND EXISTS (SELECT 1 FROM meme_citations c WHERE c.entry_id = e.id AND c.source_status = 'live'
                           AND c.observed_at >= $2::timestamptz AND c.observed_at < $3::timestamptz)`,
            [String(entryId || ''), bounds.start, bounds.end],
        );
        if (!row) return refusal(404, 'meme.not_found', 'No such candidate in this week.');
        const prev = await db.maybe('SELECT entry_id FROM meme_votes WHERE week = $1 AND subject = $2', [week, subject]);
        await db.exec(
            `INSERT INTO meme_votes (week, entry_id, subject, created_at, updated_at)
             VALUES ($1, $2, $3, now(), now())
             ON CONFLICT (week, subject) DO UPDATE SET entry_id = EXCLUDED.entry_id, updated_at = now()`,
            [week, row.id, subject],
        );
        const counts = await db.many('SELECT entry_id, COUNT(*)::int AS votes FROM meme_votes WHERE week = $1 GROUP BY entry_id', [week]);
        return {
            ok: true,
            vote: { week, entry_id: row.id, changed: !prev || prev.entry_id !== row.id },
            counts: Object.fromEntries(counts.map((c) => [c.entry_id, Number(c.votes)])),
        };
    }

    // ── The judge ───────────────────────────────────────────
    /** The verdict and the written entry, stored beside the entry (never inside it). */
    async function saveJudgement(entryId, j, t = null) {
        const run = async (tx) => {
            const row = await q(tx).maybe(
                `INSERT INTO meme_judgements (entry_id, score, reason, title, summary, origin, spread, examples, denied, looks, model, provider, run_id, judged_at, judged_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, now(), $14)
                 ON CONFLICT (entry_id) DO UPDATE SET
                    score = EXCLUDED.score, reason = EXCLUDED.reason, title = EXCLUDED.title, summary = EXCLUDED.summary,
                    origin = EXCLUDED.origin, spread = EXCLUDED.spread, examples = EXCLUDED.examples,
                    denied = EXCLUDED.denied, looks = EXCLUDED.looks, model = EXCLUDED.model, provider = EXCLUDED.provider,
                    run_id = EXCLUDED.run_id, judged_at = now(), judged_by = EXCLUDED.judged_by
                 RETURNING *`,
                [entryId, Number(j.score), String(j.reason || ''), j.title || null, j.summary || null, j.origin || null, j.spread || null,
                    JSON.stringify(Array.isArray(j.examples) ? j.examples : []), Boolean(j.denied), Boolean(j.looks),
                    j.model || null, j.provider || null, j.run_id || null, j.judged_by || 'service:meme:judge'],
            );
            return wireJudgement(row);
        };
        return t ? await run(t) : await s.tx(run);
    }

    async function judgement(entryId, t = null) {
        return wireJudgement(await q(t).maybe('SELECT * FROM meme_judgements WHERE entry_id = $1', [String(entryId || '')]));
    }

    /**
     * Take the AI's title and summary for the entry. The title is only used when it is a real title (no looks) and
     * the entry keeps its own slug: a published link never breaks.
     */
    async function applyJudgement(entryId, { title, summary }, { changedBy = 'service:meme:judge' } = {}) {
        return await s.tx(async (t) => {
            const row = await byId(entryId, t);
            if (!row) return null;
            const sets = [];
            const args = [entryId];
            const cleanTitle = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, 160);
            if (cleanTitle && cleanTitle !== row.title) { args.push(cleanTitle); sets.push(`title = $${args.length}`); }
            const cleanSummary = summary == null ? null : String(summary).replace(/\s+/g, ' ').trim().slice(0, 600);
            if (cleanSummary && cleanSummary !== row.summary) { args.push(cleanSummary); sets.push(`summary = $${args.length}`); }
            if (!sets.length) return { entry: wireEntry(row), changed: false };
            const updated = await t.maybe(
                `UPDATE meme_entries SET ${sets.join(', ')}, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING *`,
                args,
            );
            if (updated.visibility === 'public') {
                const all = await liveCitations(entryId, t);
                await search.sync(t, wireEntry(updated), all);
            }
            return { entry: wireEntry(updated), changed: true };
        });
    }

    /**
     * One decision, one status event: the visibility moved, the score says why. The status itself does not move
     * (a published candidate keeps the status the importer gave it), so from_status and to_status are the same and
     * the decision columns carry the truth.
     */
    async function logDecision({ entryId, decision, fromStatus = null, toStatus = null, fromVisibility = null, toVisibility = null, score = null, reason = null, changedBy = 'service:meme:judge' }) {
        const row = await db.maybe(
            `INSERT INTO meme_status_events (entry_id, from_status, to_status, reason, changed_by, decision, from_visibility, to_visibility, score)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [entryId, fromStatus || null, toStatus || 'rising', reason ? String(reason).slice(0, 500) : null, changedBy, decision,
                fromVisibility || null, toVisibility || null, score == null ? null : Number(score)],
        );
        return row;
    }

    /** The decision history of one entry, newest first. */
    async function decisions(entryId, { limit = 50 } = {}) {
        return (await db.many(
            `SELECT id, entry_id, from_status, to_status, reason, changed_by, decision, from_visibility, to_visibility, score, changed_at
             FROM meme_status_events WHERE entry_id = $1 ORDER BY changed_at DESC, id DESC LIMIT $2`,
            [String(entryId || ''), Math.min(200, Math.max(1, Number(limit) || 50))],
        )).map((r) => ({
            id: Number(r.id), entry_id: r.entry_id, from_status: r.from_status, to_status: r.to_status,
            reason: r.reason, changed_by: r.changed_by, decision: r.decision,
            from_visibility: r.from_visibility, to_visibility: r.to_visibility,
            score: r.score == null ? null : Number(r.score), changed_at: iso(r.changed_at),
        }));
    }

    /**
     * The staff list: every entry that is still hidden, with the judge's score and the numbers behind it. Data
     * only — the page is the orchestrator's.
     */
    async function listHidden({ limit = 100, kind = null } = {}) {
        const n = Math.min(500, Math.max(1, Number(limit) || 100));
        const args = [];
        let where = "e.visibility = 'hidden'";
        if (kind) { if (!KINDS.includes(kind)) return []; args.push(kind); where += ` AND e.kind = $${args.length}`; }
        args.push(n);
        const rows = await db.many(
            `SELECT e.*, j.score AS j_score, j.reason AS j_reason, j.title AS j_title, j.judged_at AS j_judged_at,
                    j.model AS j_model, j.provider AS j_provider, j.denied AS j_denied, j.looks AS j_looks,
                    (SELECT COUNT(*)::int FROM meme_citations c WHERE c.entry_id = e.id AND c.role IN ('origin','use') AND c.source_status = 'live') AS uses,
                    (SELECT COUNT(DISTINCT to_char(c.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))::int FROM meme_citations c WHERE c.entry_id = e.id AND c.role IN ('origin','use') AND c.source_status = 'live') AS days,
                    (SELECT COUNT(DISTINCT c.source_service)::int FROM meme_citations c WHERE c.entry_id = e.id AND c.role IN ('origin','use') AND c.source_status = 'live') AS channels
             FROM meme_entries e LEFT JOIN meme_judgements j ON j.entry_id = e.id
             WHERE ${where}
             ORDER BY (j.score IS NULL) ASC, j.score DESC, e.last_seen_at DESC, e.id DESC LIMIT $${args.length}`,
            args,
        );
        return rows.map((r) => ({
            ...wireEntry(r),
            score: r.j_score == null ? null : Number(r.j_score),
            reason: r.j_reason == null ? null : r.j_reason,
            judged_title: r.j_title == null ? null : r.j_title,
            judged_at: iso(r.j_judged_at),
            model: r.j_model == null ? null : r.j_model,
            provider: r.j_provider == null ? null : r.j_provider,
            denied: Boolean(r.j_denied),
            looks: Boolean(r.j_looks),
            uses: Number(r.uses) || 0,
            days: Number(r.days) || 0,
            channels: Number(r.channels) || 0,
        }));
    }

    /** The hidden entries a judge has not looked at yet (the ones the job takes next). */
    async function unjudged({ limit = 10 } = {}) {
        const n = Math.min(100, Math.max(1, Number(limit) || 10));
        const rows = await db.many(
            `SELECT e.* FROM meme_entries e LEFT JOIN meme_judgements j ON j.entry_id = e.id
             WHERE e.visibility = 'hidden' AND j.entry_id IS NULL
             ORDER BY e.last_seen_at DESC, e.id DESC LIMIT $1`,
            [n],
        );
        return rows.map(wireEntry);
    }

    async function createReport({ entryId, subject, kind, reason, note = null }) {
        const row = await db.maybe("SELECT id FROM meme_entries WHERE id = $1 AND visibility = 'public'", [String(entryId || '')]);
        if (!row) return refusal(404, 'meme.not_found', 'No such public entry.');
        const id = s.newId('mrp');
        const saved = await db.maybe(
            `INSERT INTO meme_reports (id, entry_id, subject, kind, reason, note, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'open', now()) RETURNING *`,
            [id, row.id, subject, kind, reason, note],
        );
        return { ok: true, report: wireReport(saved) };
    }

    async function listOpenReports({ limit = 100 } = {}) {
        const rows = await db.many(
            `SELECT r.*, e.slug AS entry_slug, e.title AS entry_title
             FROM meme_reports r JOIN meme_entries e ON e.id = r.entry_id
             WHERE r.status = 'open' ORDER BY r.created_at ASC LIMIT $1`,
            [Math.min(200, Math.max(1, Number(limit) || 100))],
        );
        return rows.map(wireReport);
    }

    return {
        wireEntry, wireCitation, wireOrigin, wireSpread, wireVariation, wireExample, wireRelated, wireRevision,
        wireTemplate, wireCaption, wireReport, wireJudgement,
        bySlug, byId, citations, liveCitations, originOf, spreadOf, variationsOf, examplesOf, relatedOf, revisionsOf, detail,
        list, trending, week, series, uniqueSlug,
        createCandidate, createEntry, addCitations, enrich, reindex, publish, hide, patch,
        createProposal, addRevision, reviewRevision, pendingRevisions,
        templates, templateById, addTemplate, createCaption, captionById, captionCountForTemplate,
        castVote, createReport, listOpenReports,
        saveJudgement, judgement, applyJudgement, logDecision, decisions, listHidden, unjudged,
        KINDS, STATUSES, VISIBILITIES, SCOPES, LABELS, MODERATION_STATES, BLOCKED_WORDS, MAX_LINES, MAX_LINE,
    };
}

function slugify(title) {
    const s = String(title || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 70);
    return s || 'meme';
}

module.exports = {
    createStore, slugify, patchFields, entryFields, changeDiff, captionLines, windowStart,
    wireEntry, wireCitation, wireOrigin, wireSpread, wireVariation, wireExample, wireRelated, wireRevision,
    wireTemplate, wireCaption, wireReport, SLUG_RE, MEDIA_ID_RE,
    KINDS, STATUSES, VISIBILITIES, SCOPES, LABELS, MODERATION_STATES, BLOCKED_WORDS,
};
