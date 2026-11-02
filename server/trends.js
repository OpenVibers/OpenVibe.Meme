'use strict';

/**
 * M3's trends read: the rising posts of the requested window, the templates their pictures reveal, and the public
 * entries that were used in the same window. Velocity comes from the score samples, never from one number:
 * with two or more samples it is (last − first) / hours; with one it is score / age in hours, and `basis` says so.
 */
const WINDOWS = Object.freeze({ day: 86_400_000, week: 7 * 86_400_000 });

const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const num = (v) => (v == null ? 0 : Number(v) || 0);

/** Score change per hour for one post's samples (oldest → newest). */
function velocityOf(samples, post, now) {
    const list = (samples || []).map((x) => ({ at: Date.parse(x.observed_at), score: num(x.score) }))
        .filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
    if (list.length >= 2) {
        const first = list[0];
        const last = list[list.length - 1];
        const hours = Math.max((last.at - first.at) / 3_600_000, 1 / 60);
        return { velocity: Math.max(0, (last.score - first.score) / hours), basis: 'samples', samples: list.length, delta: last.score - first.score };
    }
    const created = Date.parse(post.created_at);
    const hours = Number.isFinite(created) ? Math.max((now - created) / 3_600_000, 1 / 60) : null;
    return { velocity: hours ? Math.max(0, num(post.score) / hours) : 0, basis: 'score_age', samples: list.length, delta: null };
}

function createTrends({ s }) {
    async function read({ window = 'day', limit = 50 } = {}) {
        const span = WINDOWS[window];
        if (!span) return { error: 'window' };
        const n = Math.min(100, Math.max(1, Number(limit) || 50));
        const now = s.now();
        const since = new Date(now - span).toISOString();
        const posts = await s.db.many(
            `SELECT * FROM meme_reddit_posts WHERE last_seen_at >= $1::timestamptz AND removed = false ORDER BY score DESC, last_seen_at DESC LIMIT 500`,
            [since],
        );
        const ids = posts.map((p) => p.id);
        const samples = ids.length
            ? await s.db.many(`SELECT * FROM meme_reddit_samples WHERE post_id = ANY($1::text[]) AND observed_at >= $2::timestamptz ORDER BY observed_at ASC`, [ids, since])
            : [];
        const byPost = new Map();
        for (const sample of samples) {
            if (!byPost.has(sample.post_id)) byPost.set(sample.post_id, []);
            byPost.get(sample.post_id).push(sample);
        }
        const rising = posts.map((p) => {
            const v = velocityOf(byPost.get(p.id), p, now);
            return {
                id: p.id, subreddit: p.subreddit, title: p.title, author: p.author, permalink: p.permalink,
                url: p.url, image_url: p.image_url, media_id: p.media_id, phash: p.phash,
                score: num(p.score), comments: num(p.comments), over_18: Boolean(p.over_18),
                created_at: iso(p.created_at), first_seen_at: iso(p.first_seen_at), last_seen_at: iso(p.last_seen_at),
                velocity: Math.round(v.velocity * 100) / 100, velocity_basis: v.basis, velocity_samples: v.samples, score_delta: v.delta,
            };
        }).sort((a, b) => b.velocity - a.velocity || b.score - a.score).slice(0, n);

        const templates = (await s.db.many(
            `SELECT * FROM meme_reddit_templates WHERE last_seen_at >= $1::timestamptz ORDER BY post_count DESC, last_seen_at DESC LIMIT $2`,
            [since, n],
        )).map((t) => ({
            id: t.id, label: t.label, phash: t.phash, image_url: t.image_url, media_id: t.media_id,
            post_count: num(t.post_count), first_seen_at: iso(t.first_seen_at), last_seen_at: iso(t.last_seen_at),
        }));

        const entries = (await s.db.many(
            `SELECT * FROM meme_entries WHERE visibility = 'public' AND last_seen_at >= $1::timestamptz
             ORDER BY CASE status WHEN 'rising' THEN 0 WHEN 'peaked' THEN 1 WHEN 'classic' THEN 2 WHEN 'dead' THEN 3 ELSE 4 END,
                      last_seen_at DESC, id DESC LIMIT $2`,
            [since, n],
        )).map((e) => ({
            id: e.id, slug: e.slug, title: e.title, kind: e.kind, status: e.status,
            first_seen_at: iso(e.first_seen_at), last_seen_at: iso(e.last_seen_at),
        }));

        const bySubreddit = {};
        for (const p of posts) {
            const key = p.subreddit;
            const b = bySubreddit[key] || (bySubreddit[key] = { subreddit: key, posts: 0, score: 0, top: null });
            b.posts++;
            b.score += num(p.score);
            if (!b.top || num(p.score) > num(b.top.score)) b.top = { id: p.id, title: p.title, score: num(p.score) };
        }
        return {
            window, from: since, to: new Date(now).toISOString(),
            rising, templates, entries,
            subreddits: Object.values(bySubreddit).sort((a, b) => b.score - a.score),
        };
    }
    return { read, WINDOWS };
}

module.exports = { createTrends, velocityOf, WINDOWS };
