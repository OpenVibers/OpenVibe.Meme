'use strict';

/**
 * The public reads OpenVibe.Meme makes: OpenVibe.Chat's global history and AI timeline, OpenVibe.Live's Rundown,
 * VOD rows and VOD transcripts, and OpenVibe.Video's canonical `?t=` redirect. No service grant is used in v1;
 * every call here is the same anonymous read a visitor can make, and a private or missing object answers 404
 * (Live and Chat both use 404, never 403). Nothing about a failed call is cached.
 */
const { isDenied } = require('./deny-list');

/** "2026-10-28 00:11:53" (Live/Chat's shape) → an ISO instant, read as UTC when it carries no zone. */
function parseApiTime(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    let s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** UTC "YYYY-MM-DD HH:mm:ss", the shape Chat's history `before` takes. */
function chatBefore(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function createUpstreams({ config, fetchImpl = globalThis.fetch, log = console }) {
    const { chat, live, video, timeoutMs } = config.upstreams;
    const base = (u) => String(u).replace(/\/+$/, '');

    async function call(url, { method = 'GET', redirect = 'follow' } = {}) {
        let res;
        try {
            res = await fetchImpl(url, {
                method, redirect,
                headers: { Accept: 'application/json, text/plain;q=0.5', 'User-Agent': 'OpenVibe.Meme/0.1 (+https://openvibe.meme)' },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw Object.assign(new Error(`upstream unreachable: ${url}`), { code: 'upstream.unreachable', cause: err });
        }
        return res;
    }

    async function json(url) {
        const res = await call(url);
        if (res.status === 404) return { notFound: true, status: 404 };
        if (!res.ok) throw Object.assign(new Error(`upstream ${res.status}: ${url}`), { code: 'upstream.status', status: res.status });
        const data = await res.json().catch(() => null);
        if (data == null) throw Object.assign(new Error(`upstream answered no JSON: ${url}`), { code: 'upstream.body' });
        return data;
    }

    async function chatHistory({ before = null, limit = 200 } = {}) {
        const q = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, limit))) });
        if (before) q.set('before', before);
        const data = await json(`${base(chat)}/api/chat/global/history?${q.toString()}`);
        if (data.notFound) return { messages: [], latest_id: null };
        return { messages: Array.isArray(data.messages) ? data.messages : [], latest_id: data.latest_id == null ? null : data.latest_id };
    }

    async function chatTimeline({ limit = 60 } = {}) {
        const q = new URLSearchParams({ limit: String(Math.min(60, Math.max(1, limit))) });
        const data = await json(`${base(chat)}/api/chat/ai/timeline?${q.toString()}`);
        if (data.notFound) return { events: [] };
        return { events: Array.isArray(data.events) ? data.events : [], hasMore: Boolean(data.hasMore) };
    }

    async function rundownTopics({ limit = 12 } = {}) {
        const q = new URLSearchParams({ limit: String(Math.max(1, limit)) });
        const data = await json(`${base(live)}/api/rundown/topics?${q.toString()}`);
        if (data.notFound) return [];
        return Array.isArray(data.topics) ? data.topics : [];
    }

    async function rundownTopic(slug) {
        const data = await json(`${base(live)}/api/rundown/t/${encodeURIComponent(slug)}`);
        if (data.notFound) return null;
        return { topic: data.topic || null, takes: Array.isArray(data.takes) ? data.takes : [] };
    }

    async function vod(id) {
        const data = await json(`${base(live)}/api/vods/${encodeURIComponent(id)}`);
        if (data.notFound) return null;
        return data.vod || null;
    }

    async function transcripts(ids) {
        const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
        if (!wanted.length) return {};
        const q = new URLSearchParams({ ids: wanted.join(',') });
        const data = await json(`${base(live)}/api/chat-ai/vod-transcripts?${q.toString()}`);
        if (data.notFound) return {};
        const all = data.transcripts && typeof data.transcripts === 'object' ? data.transcripts : {};
        return Object.fromEntries(Object.entries(all).filter(([id]) => wanted.includes(String(id))));
    }

    /**
     * The canonical public URL for a VOD second: follow OpenVibe.Video's own redirect (a joined multi-part recording
     * redirects `/v/6026?t=864` → `/v/6025?t=1541`, and the citation stores the target). A 404 means the VOD is
     * private or gone and must not be cited.
     */
    async function canonicalVideo(vodId, sec) {
        if (isDenied({ vod_id: vodId })) return { denied: true, gone: true };
        const offset = Number.isFinite(Number(sec)) ? Number(sec) : 0;
        const res = await call(`${base(video)}/v/${encodeURIComponent(vodId)}?t=${Math.max(0, Math.round(offset))}`, { redirect: 'manual' });
        if (res.status === 404 || res.status === 410) return { gone: true, status: res.status };
        if (res.status === 401 || res.status === 403) return { hidden: true, status: res.status };
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
            let u = null;
            try { u = new URL(loc, `${base(video)}/`); } catch { u = null; }
            if (!u) return { gone: true, status: res.status };
            const m = u.pathname.match(/\/v\/(\d+)\/?$/);
            const t = u.searchParams.get('t');
            const targetId = m ? Number(m[1]) : Number(vodId);
            const targetSec = t != null && t !== '' ? Number(t) : offset;
            if (isDenied({ vod_id: targetId })) return { denied: true, gone: true };
            return { url: u.toString(), vod_id: targetId, offset_seconds: Number.isFinite(targetSec) ? targetSec : offset, redirected: true };
        }
        if (res.ok) return { url: `${base(video)}/v/${encodeURIComponent(vodId)}?t=${Math.max(0, Math.round(offset))}`, vod_id: Number(vodId), offset_seconds: offset, redirected: false };
        throw Object.assign(new Error(`video ${vodId}@${offset} answered ${res.status}`), { code: 'upstream.status', status: res.status });
    }

    /** A citation URL's current state: live, gone (404/410) or hidden (401/403). Other answers are an error. */
    async function citationUrl(url) {
        const res = await call(String(url), { redirect: 'follow' });
        if (res.status === 404 || res.status === 410) return { status: 'gone', http: res.status };
        if (res.status === 401 || res.status === 403) return { status: 'hidden', http: res.status };
        if (res.ok) return { status: 'live', http: res.status, finalUrl: res.url || null };
        throw Object.assign(new Error(`citation ${url} answered ${res.status}`), { code: 'upstream.status', status: res.status });
    }

    /**
     * A chat line has no permalink API in v1 (research §2.1), so it is re-verified against the same public history
     * page: the message id must still be there and not deleted. Not finding it marks it gone; the message id is
     * what the citation stores.
     */
    async function chatMessage(citation) {
        const at = new Date(citation.observed_at).getTime();
        if (!Number.isFinite(at)) return { status: 'gone' };
        const wanted = String(citation.chat_message_id != null ? citation.chat_message_id : citation.source_id);
        // A public history page holds at most 500 lines, so walk back towards the citation's minute (a few pages
        // at most) rather than declaring a line gone just because a busy channel has moved it off page one.
        let before = chatBefore(at + 60_000);
        for (let page = 0; page < 5; page++) {
            const h = await chatHistory({ before, limit: 500 });
            const msg = h.messages.find((m) => String(m.id) === wanted);
            if (msg) return Number(msg.is_deleted) === 1 ? { status: 'hidden' } : { status: 'live', text: msg.message };
            const oldest = h.messages.length ? parseApiTime(h.messages[h.messages.length - 1].timestamp) : null;
            if (!oldest || Date.parse(oldest) <= at - 86_400_000) break;
            before = chatBefore(Date.parse(oldest) - 1000);
        }
        return { status: 'gone' };
    }

    return {
        chatHistory, chatTimeline, rundownTopics, rundownTopic, vod, transcripts, canonicalVideo, citationUrl, chatMessage,
        base,
    };
}

module.exports = { createUpstreams, parseApiTime, chatBefore };
