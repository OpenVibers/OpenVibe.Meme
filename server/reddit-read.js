'use strict';

/**
 * A Reddit post for M4's analyzer, through Reddit's official API only. It mints the same OAuth2 client-credentials
 * token as the trends importer and reads the post plus its top comments; no page, login or captcha wall is touched.
 * Off without MEME_REDDIT_CLIENT_ID/SECRET, in which case a Reddit URL is refused with `meme.reddit_unavailable`.
 */
const decodeEntities = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function redditPostId(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'redd.it') {
        const m = u.pathname.match(/^\/([a-z0-9]{4,12})(?:\/|$)/i);
        return m ? m[1].toLowerCase() : null;
    }
    if (host !== 'reddit.com' && !host.endsWith('.reddit.com')) return null;
    const m = u.pathname.match(/\/comments\/([a-z0-9]{4,12})(?:\/|$)/i);
    return m ? m[1].toLowerCase() : null;
}

function imageUrlOf(post) {
    const dest = post.url_overridden_by_dest || post.url;
    if (dest && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(String(dest))) return decodeEntities(dest);
    const p = post.preview && Array.isArray(post.preview.images) ? post.preview.images[0] : null;
    if (p && p.source && p.source.url) return decodeEntities(p.source.url);
    if (post.thumbnail && /^https?:\/\//i.test(String(post.thumbnail))) return decodeEntities(post.thumbnail);
    return null;
}

function createRedditReader({ config, fetchImpl = globalThis.fetch, tokenUrl = 'https://www.reddit.com/api/v1/access_token', apiBase = 'https://oauth.reddit.com' }) {
    const cfg = config.reddit || {};
    const enabled = Boolean(cfg.clientId && cfg.clientSecret);
    let token = null;

    async function accessToken() {
        if (token && token.until > Date.now() + 30_000) return token.value;
        const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
        const res = await fetchImpl(tokenUrl, {
            method: 'POST',
            headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': cfg.userAgent },
            body: 'grant_type=client_credentials',
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw Object.assign(new Error(`Reddit token answered ${res.status}`), { code: 'reddit.token' });
        const data = await res.json().catch(() => ({}));
        if (!data || !data.access_token) throw Object.assign(new Error('Reddit token returned no access_token'), { code: 'reddit.token' });
        token = { value: data.access_token, until: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 };
        return token.value;
    }

    async function get(path) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const at = await accessToken();
            const res = await fetchImpl(`${apiBase}${path}`, {
                headers: { Authorization: `Bearer ${at}`, Accept: 'application/json', 'User-Agent': cfg.userAgent },
                signal: AbortSignal.timeout(15_000),
            });
            if (res.status === 401 && attempt === 0) { token = null; continue; }
            if (res.status === 429) throw Object.assign(new Error('Reddit rate limited'), { code: 'reddit.rate_limited' });
            if (!res.ok) throw Object.assign(new Error(`Reddit answered ${res.status}`), { code: 'reddit.status', status: res.status });
            return await res.json();
        }
        throw Object.assign(new Error('Reddit token was refused twice'), { code: 'reddit.token' });
    }

    /** → { id, post, comments, spread } or null when the URL is not a Reddit post. */
    async function read(url) {
        const id = redditPostId(url);
        if (!id) return null;
        if (!enabled) {
            const err = new Error('Reddit credentials are not configured');
            err.code = 'reddit.unavailable';
            throw err;
        }
        const data = await get(`/comments/${id}?limit=100&raw_json=1&sort=top`);
        const listing = Array.isArray(data) ? data[0] : null;
        const post = listing && listing.data && listing.data.children && listing.data.children[0] && listing.data.children[0].data;
        if (!post) throw Object.assign(new Error('Reddit returned no post'), { code: 'reddit.not_found', status: 404 });
        const commentListing = Array.isArray(data) ? data[1] : null;
        const raw = commentListing && commentListing.data && Array.isArray(commentListing.data.children) ? commentListing.data.children : [];
        const comments = raw
            .filter((c) => c && c.kind === 't1' && c.data && !c.data.stickied && c.data.body)
            .slice(0, 80)
            .map((c) => ({ id: c.data.id, author: c.data.author || null, score: Number(c.data.score) || 0, body: String(c.data.body).slice(0, 1000) }));
        const created = new Date(Number(post.created_utc) * 1000);
        return {
            id,
            post,
            comments,
            spread: {
                subreddit: post.subreddit || null,
                score: Number(post.score) || 0,
                upvote_ratio: Number(post.upvote_ratio) || 0,
                comments: Number(post.num_comments) || 0,
                created_at: Number.isNaN(created.getTime()) ? null : created.toISOString(),
                permalink: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
                crossposts: Number(post.num_crossposts) || 0,
                over_18: Boolean(post.over_18),
            },
            title: String(post.title || ''),
            image_url: imageUrlOf(post),
        };
    }

    return { enabled, read, get, redditPostId, imageUrlOf };
}

module.exports = { createRedditReader, redditPostId, imageUrlOf, decodeEntities };
