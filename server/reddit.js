'use strict';

/**
 * M3's Reddit trends, through Reddit's official API only (OAuth2 client credentials → oauth.reddit.com). No page
 * is scraped, no login/captcha wall is touched, and the User-Agent names this app. The importer is off when
 * MEME_REDDIT_CLIENT_ID / MEME_REDDIT_CLIENT_SECRET are missing (tests inject a local Reddit and call runOnce()).
 *
 * Each run reads the day's top posts of the permitted subreddits, records a score sample per post (the API
 * computes velocity from samples rather than trusting one number), hashes the picture with a dHash, and groups
 * equal-enough hashes. A hash that recurs in `MEME_REDDIT_MIN_TEMPLATE_POSTS` distinct posts is a new template;
 * its picture is uploaded to OpenVibe.Media when that is configured, and the source URL is kept either way.
 */
const { dHash, hamming, PHASH_RE } = require('./phash');
const { fetchImage } = require('./fetch-image');

const DAY = 86_400_000;
const TEMPLATE_DISTANCE = 10;
const MAX_IMAGES_PER_RUN = 48;
const ALLOWED_DEFAULT = ['memes', 'dankmemes', 'MemeEconomy', 'wholesomememes'];

const decodeEntities = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function imageUrlOf(post) {
    const dest = post.url_overridden_by_dest || post.url;
    if (dest && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(String(dest))) return decodeEntities(dest);
    const p = post.preview && Array.isArray(post.preview.images) ? post.preview.images[0] : null;
    if (p && p.source && p.source.url) return decodeEntities(p.source.url);
    if (post.thumbnail && /^https?:\/\//i.test(String(post.thumbnail))) return decodeEntities(post.thumbnail);
    return null;
}

function createRedditTrends({ config, s, media = null, fetchImpl = globalThis.fetch, log = console, sharpImpl = null, fetchImageImpl = fetchImage,
    tokenUrl = 'https://www.reddit.com/api/v1/access_token', apiBase = 'https://oauth.reddit.com' }) {
    const cfg = config.reddit || {};
    const subreddits = (cfg.subreddits && cfg.subreddits.length ? cfg.subreddits : ALLOWED_DEFAULT)
        .map((x) => String(x).replace(/^\/?r\//i, '')).filter(Boolean);
    const enabled = Boolean(cfg.clientId && cfg.clientSecret && subreddits.length);
    let token = null;
    let timers = [];
    const stats = { runs: 0, subreddits: 0, posts: 0, samples: 0, hashed: 0, uploaded: 0, templates: 0, errors: 0, last_run_at: null, last_error: null };

    async function accessToken() {
        if (token && token.until > Date.now() + 30_000) return token.value;
        const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
        const res = await fetchImpl(tokenUrl, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': cfg.userAgent,
            },
            body: 'grant_type=client_credentials',
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw Object.assign(new Error(`Reddit token answered ${res.status}`), { code: 'reddit.token', status: res.status });
        const data = await res.json().catch(() => ({}));
        if (!data || !data.access_token) throw Object.assign(new Error('Reddit token returned no access_token'), { code: 'reddit.token' });
        token = { value: data.access_token, until: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 };
        return token.value;
    }

    async function api(path) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const at = await accessToken();
            const res = await fetchImpl(`${apiBase}${path}`, {
                headers: { Authorization: `Bearer ${at}`, Accept: 'application/json', 'User-Agent': cfg.userAgent },
                signal: AbortSignal.timeout(15_000),
            });
            if (res.status === 401 && attempt === 0) { token = null; continue; }
            if (res.status === 429) throw Object.assign(new Error('Reddit rate limited'), { code: 'reddit.rate_limited', retryAfter: res.headers.get('retry-after') });
            if (!res.ok) throw Object.assign(new Error(`Reddit ${path} answered ${res.status}`), { code: 'reddit.status', status: res.status });
            return await res.json();
        }
        throw Object.assign(new Error('Reddit token was refused twice'), { code: 'reddit.token' });
    }

    function topPath(sub, t) {
        return `/r/${encodeURIComponent(sub)}/top?t=${encodeURIComponent(t)}&limit=${Math.min(100, Math.max(1, cfg.maxPosts || 100))}&raw_json=1`;
    }

    async function upsertPost(post, observedAt, budget) {
        const id = `t3_${String(post && post.id || '')}`;
        if (!/^t3_[a-z0-9]{1,16}$/.test(id)) return null;
        const created = new Date(Number(post.created_utc) * 1000);
        if (Number.isNaN(created.getTime())) return null;
        const score = Math.max(0, Math.floor(Number(post.score) || 0));
        const comments = Math.max(0, Math.floor(Number(post.num_comments) || 0));
        const permalink = post.permalink ? `https://www.reddit.com${decodeEntities(post.permalink)}` : `https://www.reddit.com/comments/${id.slice(3)}`;
        const imageUrl = imageUrlOf(post);
        const row = await s.db.maybe(
            `INSERT INTO meme_reddit_posts (id, subreddit, title, permalink, url, image_url, author, score, comments, over_18, created_at, first_seen_at, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, $12::timestamptz)
             ON CONFLICT (id) DO UPDATE SET score = EXCLUDED.score, comments = EXCLUDED.comments,
                last_seen_at = EXCLUDED.last_seen_at, image_url = COALESCE(EXCLUDED.image_url, meme_reddit_posts.image_url),
                over_18 = EXCLUDED.over_18, removed = false
             RETURNING *`,
            [id, String(post.subreddit || '').slice(0, 80), String(post.title || '').slice(0, 500), permalink,
                post.url ? decodeEntities(post.url) : null, imageUrl, post.author ? String(post.author).slice(0, 120) : null,
                score, comments, Boolean(post.over_18), created.toISOString(), observedAt],
        );
        await s.db.exec('INSERT INTO meme_reddit_samples (post_id, observed_at, score, comments) VALUES ($1, $2::timestamptz, $3, $4)',
            [id, observedAt, score, comments]);
        stats.samples++;
        if (imageUrl && !row.phash && budget.images > 0) {
            budget.images--;
            const pic = await fetchImageImpl(imageUrl, { fetchImpl, maxBytes: cfg.maxImageBytes, timeoutMs: 10_000 });
            if (pic.bytes) {
                const phash = await dHash(pic.bytes, sharpImpl ? { sharpImpl } : {});
                if (phash) {
                    let mediaId = null;
                    if (media && media.enabled) {
                        const up = await media.upload(pic.bytes, { mimeType: pic.mime, filename: `${id}.img` });
                        if (up && up.media_id) { mediaId = up.media_id; stats.uploaded++; }
                    }
                    await s.db.exec('UPDATE meme_reddit_posts SET phash = $2, media_id = COALESCE($3, media_id) WHERE id = $1', [id, phash, mediaId]);
                    row.phash = phash;
                    row.media_id = mediaId || row.media_id;
                    stats.hashed++;
                }
            }
        }
        return row;
    }

    /** Link one phash to an existing template, or create a cluster when at least minTemplatePosts agree. */
    async function assignTemplates(rows) {
        const templates = await s.db.many('SELECT * FROM meme_reddit_templates ORDER BY last_seen_at DESC LIMIT 500');
        const unmatched = [];
        for (const row of rows) {
            if (!row || !PHASH_RE.test(String(row.phash || ''))) continue;
            let best = null;
            let bestDistance = 65;
            for (const tpl of templates) {
                const d = hamming(row.phash, tpl.phash);
                if (d <= TEMPLATE_DISTANCE && d < bestDistance) { best = tpl; bestDistance = d; }
            }
            if (best) {
                const inserted = await s.db.maybe(
                    'INSERT INTO meme_reddit_template_posts (template_id, post_id, distance) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING post_id',
                    [best.id, row.id, bestDistance],
                );
                if (inserted) {
                    await s.db.exec('UPDATE meme_reddit_templates SET post_count = (SELECT COUNT(*) FROM meme_reddit_template_posts WHERE template_id = $1), last_seen_at = now() WHERE id = $1', [best.id]);
                }
            } else {
                unmatched.push(row);
            }
        }
        // Greedy clusters among the hashes not yet known.
        const clusters = [];
        for (const row of unmatched) {
            let cluster = clusters.find((c) => hamming(c.rep.phash, row.phash) <= TEMPLATE_DISTANCE);
            if (!cluster) { cluster = { rep: row, rows: [] }; clusters.push(cluster); }
            cluster.rows.push(row);
        }
        let newTemplates = 0;
        for (const cluster of clusters) {
            if (cluster.rows.length < Math.max(2, cfg.minTemplatePosts || 3)) continue;
            const id = s.newId('tpl');
            const rep = cluster.rep;
            const tpl = await s.db.maybe(
                `INSERT INTO meme_reddit_templates (id, phash, label, image_url, media_id, post_count, first_seen_at, last_seen_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, 0, now(), now(), now()) RETURNING *`,
                [id, rep.phash, String(rep.title || '').slice(0, 200), rep.image_url || null, rep.media_id || null],
            );
            for (const row of cluster.rows) {
                await s.db.exec('INSERT INTO meme_reddit_template_posts (template_id, post_id, distance) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                    [tpl.id, row.id, hamming(tpl.phash, row.phash)]);
            }
            await s.db.exec('UPDATE meme_reddit_templates SET post_count = (SELECT COUNT(*) FROM meme_reddit_template_posts WHERE template_id = $1) WHERE id = $1', [tpl.id]);
            newTemplates++;
            stats.templates++;
        }
        return newTemplates;
    }

    async function runOnce() {
        const runAt = new Date(s.now()).toISOString();
        if (!enabled) {
            return { ok: false, disabled: true, reason: 'MEME_REDDIT_CLIENT_ID / MEME_REDDIT_CLIENT_SECRET are not set', posts: 0, templates: 0, errors: [] };
        }
        const errors = [];
        const rows = [];
        const budget = { images: MAX_IMAGES_PER_RUN };
        let subs = 0;
        for (const sub of subreddits) {
            try {
                const data = await api(topPath(sub, 'day'));
                const children = data && data.data && Array.isArray(data.data.children) ? data.data.children : [];
                subs++;
                for (const child of children) {
                    if (!child || !child.data) continue;
                    const row = await upsertPost(child.data, runAt, budget);
                    if (row) rows.push(row);
                }
            } catch (err) {
                errors.push(`${sub}: ${err.message}`);
                log.warn(`[OpenVibe.Meme] reddit ${sub}: ${err.message.slice(0, 200)}`);
            }
        }
        let templates = 0;
        try { templates = await assignTemplates(rows); } catch (err) {
            errors.push(`templates: ${err.message}`);
            log.warn(`[OpenVibe.Meme] reddit templates: ${err.message.slice(0, 200)}`);
        }
        stats.runs++;
        stats.subreddits += subs;
        stats.posts += rows.length;
        stats.errors += errors.length;
        stats.last_run_at = runAt;
        stats.last_error = errors[0] || null;
        const out = { ok: errors.length === 0, disabled: false, subreddits: subs, posts: rows.length, templates, errors };
        log.log(`[OpenVibe.Meme] reddit: ${rows.length} posts from ${subs} subreddits, ${templates} template(s)${errors.length ? `, ${errors.length} errors` : ''}`);
        return out;
    }

    function start() {
        if (!enabled || config.drill || timers.length) return false;
        const quiet = () => runOnce().catch((err) => log.warn(`[OpenVibe.Meme] reddit tick failed: ${err.message}`));
        const kick = setTimeout(quiet, 45_000);
        const tick = setInterval(quiet, cfg.intervalMs || 15 * 60_000);
        if (kick.unref) kick.unref();
        if (tick.unref) tick.unref();
        timers = [kick, tick];
        return true;
    }
    function stop() { for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); } }

    return { enabled, subreddits, runOnce, start, stop, stats: () => ({ ...stats, running: timers.length > 0 }), imageUrlOf };
}

module.exports = { createRedditTrends, imageUrlOf, decodeEntities, MAX_IMAGES_PER_RUN, TEMPLATE_DISTANCE, ALLOWED_DEFAULT, DAY };
