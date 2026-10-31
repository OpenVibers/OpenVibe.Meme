'use strict';

/**
 * M4: analyse one meme. A URL or a Media object goes to OpenVibe.AI's vision call (`pics.describe_image`), then one
 * structured call (`ai.extract`) sees the picture's description, the Reddit post's metadata and comments, the known
 * templates and the closest entries. It answers the template, meaning, usage, L1 labels, origin guesses with a
 * confidence and — for Reddit — the comments' tone. Meme matches those answers against its entries and templates;
 * the model never writes the entry.
 *
 * Reddit is read through its official API only (server/reddit-read.js). The daily AI budget is reserved before a
 * call and the run's stated cost is charged after it.
 */
// The consent plan's L1 set (kept local so M4 does not depend on M2's migration).
const LABELS = Object.freeze(['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers']);
const LABEL_SET = new Set(LABELS);
const TONES = new Set(['positive', 'negative', 'mixed', 'neutral', 'ironic']);
const MAX_TEXT = 24_000;
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const tokensOf = (text) => [...new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter((w) => w.length > 2))].slice(0, 24);

const STRUCTURE = {
    type: 'object', additionalProperties: false,
    required: ['template', 'meaning', 'usage', 'labels', 'origins'],
    properties: {
        template: {
            type: 'object', additionalProperties: false, required: ['name', 'known'],
            properties: { name: { type: 'string', maxLength: 160 }, known: { type: 'boolean' }, closest_entry: { type: ['string', 'null'], maxLength: 80 } },
        },
        meaning: { type: 'string', maxLength: 2000 },
        usage: { type: 'string', maxLength: 2000 },
        labels: { type: 'array', maxItems: 6, items: { enum: LABELS } },
        origins: {
            type: 'array', maxItems: 8,
            items: {
                type: 'object', additionalProperties: false, required: ['title', 'confidence'],
                properties: { title: { type: 'string', maxLength: 300 }, url: { type: ['string', 'null'], maxLength: 2048 }, year: { type: ['integer', 'null'], minimum: 1990, maximum: 2030 }, confidence: { type: 'number', minimum: 0, maximum: 1 }, why: { type: ['string', 'null'], maxLength: 500 } },
            },
        },
        similar: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 300 } },
        comments_tone: {
            type: ['object', 'null'], additionalProperties: false,
            properties: { tone: { enum: ['positive', 'negative', 'mixed', 'neutral', 'ironic'] }, summary: { type: 'string', maxLength: 800 } },
        },
    },
};

function publicUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return String(u).length <= 2048 ? u.toString() : null;
}

function createAnalyzer({ config, s, ai, reddit = null, fetchImpl = globalThis.fetch, log = console, mediaBaseUrl = 'https://openvibe.media' }) {
    const isReddit = (url) => Boolean(reddit && reddit.redditPostId(url));

    async function matchEntries(query) {
        const tokens = tokensOf(query);
        if (!tokens.length) return [];
        const args = tokens.slice(0, 8);
        const clauses = args.map((_, i) => `(e.title ILIKE $${i + 1} ESCAPE '\\' OR e.summary ILIKE $${i + 1} ESCAPE '\\')`).join(' OR ');
        const rows = await s.db.many(
            `SELECT e.* FROM meme_entries e WHERE e.visibility = 'public' AND (${clauses}) ORDER BY e.last_seen_at DESC LIMIT 20`,
            args.map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`),
        );
        const scored = rows.map((row) => {
            const hay = `${row.title} ${row.summary || ''} ${row.meaning || ''}`.toLowerCase();
            const hits = args.filter((t) => hay.includes(t)).length;
            return { row, hits };
        }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits || String(b.row.last_seen_at).localeCompare(String(a.row.last_seen_at)));
        return scored.slice(0, 8).map(({ row, hits }) => ({
            id: row.id, slug: row.slug, title: row.title, kind: row.kind, status: row.status,
            summary: row.summary || null, match: hits,
        }));
    }

    async function matchTemplate(name) {
        const wanted = tokensOf(name);
        if (!wanted.length) return null;
        const rows = await s.db.many('SELECT * FROM meme_templates ORDER BY box_count ASC, name ASC');
        let best = null;
        let bestHits = 0;
        for (const row of rows) {
            const hay = `${row.name}`.toLowerCase();
            const hits = wanted.filter((t) => hay.includes(t)).length;
            if (hits > bestHits) { best = row; bestHits = hits; }
        }
        return best;
    }

    async function originsFromEntries(matched) {
        const out = [];
        for (const m of matched.slice(0, 3)) {
            let origin = null;
            try { origin = await s.db.maybe('SELECT * FROM meme_origins WHERE entry_id = $1', [m.id]); } catch { origin = null; }
            if (origin) out.push({ title: origin.title, url: origin.url, publisher: origin.publisher || null, year: origin.published_at ? new Date(origin.published_at).getUTCFullYear() : null, confidence: 0.8, why: `The entry “${m.title}” cites it.`, entry_slug: m.slug });
        }
        return out;
    }

    async function analyze({ url = null, mediaId = null, subject = null } = {}) {
        const hasUrl = typeof url === 'string' && url.trim() !== '';
        const hasMedia = typeof mediaId === 'string' && mediaId.trim() !== '';
        if (hasUrl === hasMedia) return { ok: false, status: 400, code: 'meme.invalid', message: 'Send exactly one of url or media_id.' };
        if (!ai.enabled) return { ok: false, status: 503, code: 'meme.ai_unavailable', message: 'OpenVibe.AI is not configured (OV_AI_INTERNAL_URL and OV_OAUTH_CLIENT_SECRET).' };

        let inputUrl = null;
        let media = null;
        let redditOut = null;
        let imageUrl = null;
        let title = '';
        if (hasUrl) {
            inputUrl = publicUrl(url);
            if (!inputUrl) return { ok: false, status: 400, code: 'meme.invalid', message: 'url must be a public http(s) URL.' };
            if (isReddit(inputUrl)) {
                if (!reddit.enabled) return { ok: false, status: 503, code: 'meme.reddit_unavailable', message: 'A Reddit URL is read through Reddit\'s official API; MEME_REDDIT_CLIENT_ID and MEME_REDDIT_CLIENT_SECRET are not set.' };
                try { redditOut = await reddit.read(inputUrl); } catch (err) {
                    const status = err.code === 'reddit.not_found' ? 404 : 502;
                    return { ok: false, status, code: 'meme.reddit_failed', message: `Reddit could not be read: ${clean(err.message, 200)}` };
                }
                if (!redditOut) return { ok: false, status: 400, code: 'meme.invalid', message: 'That is not a Reddit post URL.' };
                title = redditOut.title;
                imageUrl = redditOut.image_url;
            } else {
                imageUrl = inputUrl;
            }
        } else {
            media = String(mediaId).trim();
            if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(media)) return { ok: false, status: 400, code: 'meme.invalid', message: 'media_id must be a Media object id.' };
            imageUrl = `${String(mediaBaseUrl).replace(/\/+$/, '')}/o/${encodeURIComponent(media)}`;
        }

        const matched = await matchEntries(title || (inputUrl || '').replace(/[^a-zA-Z0-9]+/g, ' '));
        const known = await s.db.many('SELECT name FROM meme_templates ORDER BY box_count ASC, name ASC LIMIT 20');

        // Two calls: vision, then one structured extraction. Reserve both before the first, so a full day refuses
        // the request before any cost is incurred.
        const needed = imageUrl ? 2 : 1;
        const reserved = await ai.reserve(needed);
        if (!reserved.ok) return reserved;

        let vision = null;
        if (imageUrl) {
            const v = await ai.run('pics.describe_image', { image: { url: imageUrl }, ...(title ? { title: clean(title, 120) } : {}) }, { calls: 0 });
            if (!v.ok) return v;
            vision = { alt: clean(v.output.alt, 160), caption: clean(v.output.caption, 400), tags: Array.isArray(v.output.tags) ? v.output.tags.map((t) => clean(t, 30)).filter(Boolean).slice(0, 6) : [], costUsd: v.costUsd };
        }

        const comments = redditOut ? redditOut.comments.slice(0, 50).map((c) => `- (${c.score}) ${clean(c.body, 400)}`) : [];
        const context = [
            title ? `Reddit post title: ${title}` : '',
            redditOut ? `Subreddit: ${redditOut.spread.subreddit}; score ${redditOut.spread.score}; ${redditOut.spread.comments} comments.` : '',
            vision ? `Picture: ${vision.caption || vision.alt}\nAlt: ${vision.alt}\nTags: ${vision.tags.join(', ')}` : '',
            known.length ? `Known templates: ${known.map((t) => t.name).join('; ')}` : '',
            matched.length ? `Close entries: ${matched.map((m) => m.title).join('; ')}` : '',
            comments.length ? `Top comments:\n${comments.join('\n').slice(0, 12_000)}` : '',
        ].filter(Boolean).join('\n').slice(0, MAX_TEXT);
        const instructions = [
            'Identify the meme template and explain what it means and how people use it.',
            'template.name is the format\'s common name; known says whether it is a well-established template; closest_entry is an entry slug from the close entries when one matches.',
            `labels must be from: ${LABELS.join(', ')}. Use 18+ for adult content; do not invent labels.`,
            'origins are guesses at where the format started, each with a 0..1 confidence and a short why; a made-up origin is worse than none.',
            'comments_tone is the tone of the supplied Reddit comments (positive, negative, mixed, neutral or ironic) and a one-sentence summary; null when there are no comments.',
            'Output only JSON matching the schema. Do not describe the person in the picture; describe the format.',
        ].join(' ');
        const structured = await ai.run('ai.extract', { text: context, schema: STRUCTURE, instructions }, { calls: 0 });
        if (!structured.ok) return structured;
        const data = structured.output.data || {};

        let labels = Array.isArray(data.labels) ? data.labels.filter((l) => LABEL_SET.has(l)) : [];
        if (redditOut && redditOut.spread.over_18 && !labels.includes('18+')) labels.push('18+');
        labels = [...new Set(labels)];

        // The model names the format; match again with that name (and the vision tags) because the URL alone often
        // says nothing. The initial match on the title/URL is still useful when the model is vague.
        const refined = await matchEntries([data.template && data.template.name, title, ...(vision ? vision.tags : [])].filter(Boolean).join(' '));
        const seenEntries = new Set(matched.map((m) => m.id));
        const allMatched = [...matched, ...refined.filter((m) => !seenEntries.has(m.id))].slice(0, 8);

        const templateRow = await matchTemplate(data.template && data.template.name);
        let closest = null;
        if (data.template && data.template.closest_entry) {
            const row = await s.db.maybe('SELECT id, slug, title FROM meme_entries WHERE visibility = $1 AND slug = $2', ['public', String(data.template.closest_entry)]);
            if (row) closest = { id: row.id, slug: row.slug, title: row.title };
        }
        const template = {
            name: data.template && data.template.known ? clean(data.template.name, 160) : (data.template && data.template.name ? clean(data.template.name, 160) : null),
            known: Boolean(data.template && data.template.known),
            template_id: templateRow ? templateRow.id : null,
            template: templateRow || null,
            closest_entry: closest,
        };

        const entryOrigins = await originsFromEntries(allMatched);
        const aiOrigins = Array.isArray(data.origins) ? data.origins.map((o) => ({
            title: clean(o.title, 300), url: publicUrl(o.url || ''), year: o.year == null ? null : Number(o.year),
            confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)), why: o.why == null ? null : clean(o.why, 500), entry_slug: null,
        })).filter((o) => o.title && o.confidence > 0) : [];
        const seen = new Set();
        const origins = [...entryOrigins, ...aiOrigins].filter((o) => {
            const key = o.url || o.title.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).sort((a, b) => b.confidence - a.confidence).slice(0, 8);

        const tone = data.comments_tone && TONES.has(data.comments_tone.tone)
            ? { tone: data.comments_tone.tone, summary: clean(data.comments_tone.summary, 800) }
            : (redditOut ? { tone: 'neutral', summary: 'Not enough comment signal to call a tone.' } : null);

        const id = s.newId('anl');
        const result = {
            id,
            input: { url: inputUrl, media_id: media },
            template,
            matched_entries: allMatched,
            origins,
            meaning: clean(data.meaning, 2000) || null,
            usage: clean(data.usage, 2000) || null,
            labels,
            vision,
            reddit: redditOut ? { spread: redditOut.spread, post: { id: redditOut.id, title: clean(redditOut.title, 500), permalink: redditOut.spread.permalink }, comments_tone: tone, comments_sampled: redditOut.comments.length } : null,
            similar: Array.isArray(data.similar) ? data.similar.map((x) => clean(x, 300)).filter(Boolean).slice(0, 10) : [],
            cost_usd: Number((vision && vision.costUsd) || 0) + Number(structured.costUsd || 0),
            created_at: s.iso(),
        };
        const saved = await s.db.maybe(
            `INSERT INTO meme_analyses (id, subject, input_url, media_id, status, result, cost_usd, created_at)
             VALUES ($1, $2, $3, $4, 'succeeded', $5::jsonb, $6, now()) RETURNING id, created_at`,
            [id, subject || null, inputUrl, media, JSON.stringify(result), result.cost_usd],
        );
        result.created_at = saved && saved.created_at ? new Date(saved.created_at).toISOString() : result.created_at;
        return { ok: true, analysis: result };
    }

    return { analyze };
}

module.exports = { createAnalyzer, STRUCTURE, publicUrl, tokensOf, LABEL_SET, TONES };
