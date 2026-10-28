'use strict';

/**
 * In-process stand-ins for OpenVibe.Chat, OpenVibe.Live and OpenVibe.Video on one HTTP server. The boot helper
 * points OV_CHAT_URL, OV_LIVE_URL and OV_VIDEO_URL at it.
 *
 * The default fixture is a small running joke ("the robot is offline"): two Chat lines on two days, a Rundown
 * quote and its VOD transcript segment on a third, and the joined-recording redirect `/v/9001?t=60` →
 * `/v/9002?t=120`. It also carries the Cozmo proof fixture (message 86957, VOD 6026 at 864.08 s) and a take that
 * names the fixed deny list (VOD 5709) so both scripts can be exercised without the network.
 *
 * A test changes state.video[<vod>] = { status: 404 } to make a citation's URL vanish, or reads state.requests.
 */
const http = require('http');

const DEFAULT_MESSAGES = [
    { id: 1001, stream_id: null, username: 'ada', message: 'the robot is offline again', message_type: 'chat', is_deleted: 0, timestamp: '2026-10-20 10:00:00' },
    { id: 1002, stream_id: null, username: 'bo', message: 'still the robot is offline, huh', message_type: 'chat', is_deleted: 0, timestamp: '2026-10-22 11:00:00' },
    { id: 86957, stream_id: null, username: 'Little_Buddy', message: 'o/ Maticus, you still got that same vibe. What’s good? The world’s still spinning, but your Cozmo ain’t online yet. (Or is it?)', message_type: 'chat', is_deleted: 0, timestamp: '2026-10-28 00:11:53' },
    { id: 86960, stream_id: null, username: 'ada', message: 'the robot is offline and the coffee is cold', message_type: 'chat', is_deleted: 0, timestamp: '2026-10-23 09:00:00' },
    { id: 86961, stream_id: null, username: 'bo', message: 'deleted line', message_type: 'chat', is_deleted: 1, timestamp: '2026-10-23 09:01:00' },
];

const DEFAULT_TIMELINE = [
    { id: 2598, ts: '2026-10-28 00:13:06', label: 'Robot offline bit continues', detail: 'Chat keeps the robot-offline joke going.' },
    { id: 2597, ts: '2026-10-28 00:12:06', label: 'Cozmo phones home — not online', detail: 'Conversation humour around Cozmo not being online.' },
];

const DEFAULT_TOPICS = [
    { slug: 'robot-test', title: 'ROBOT TEST', kind: 'games', headline: 'The robot test', summary: 'A robot test.', first_seen_at: '2026-10-20 09:00:00', last_seen_at: '2026-10-22 13:00:00' },
    { slug: 'looi-robot-test', title: 'LOOI ROBOT TEST', kind: 'games', headline: 'LOOI robot test', summary: 'A robot test.', first_seen_at: '2026-10-23 21:14:44', last_seen_at: '2026-10-26 21:30:52' },
];

const DEFAULT_TAKES = {
    'robot-test': [
        { type: 'segment', id: 501, title: 'The robot is offline', what: 'The robot is offline.', take: 'It stays offline.', quip: 'Offline again.', score: 3, quotes: [{ text: 'the robot is offline for good', sec: 60 }], stream_id: 7001, vod_id: 9001, sec: 60, said_at: '2026-10-21 12:00:00' },
        { type: 'segment', id: 590, title: 'A denied clip', what: 'Never cited.', take: 'No.', quip: 'No.', score: 1, quotes: [{ text: 'this line must never become a citation', sec: 12 }], stream_id: 7009, vod_id: 5709, sec: 12, said_at: '2026-10-21 12:05:00' },
    ],
    'looi-robot-test': [
        { type: 'segment', id: 1165, title: 'Maticus can drive robots', what: 'Cosmo needs Wi-Fi.', take: 'Robots.', quip: 'Wi-Fi.', score: 4, quotes: [{ text: 'Cosmo requires Wi-Fi.', sec: 1582.8 }], stream_id: 2795, vod_id: 6026, sec: 1524, said_at: '2026-10-26 21:30:52' },
    ],
};

const DEFAULT_VODS = {
    9001: { id: 9001, stream_id: 7001, title: 'Robot test', created_at: '2026-10-21T11:00:00.000Z', visibility: 'public' },
    9002: { id: 9002, stream_id: 7001, title: 'Robot test (joined)', created_at: '2026-10-21T11:00:00.000Z', visibility: 'public' },
    6025: { id: 6025, stream_id: 2795, title: 'Night stream', created_at: '2026-10-26T21:00:00.000Z', visibility: 'public' },
    6026: { id: 6026, stream_id: 2795, title: 'Night stream, part 2', created_at: '2026-10-26T21:00:00.000Z', visibility: 'public' },
};

const DEFAULT_TRANSCRIPTS = {
    9001: { transcript: 'the robot is offline for good', segments: [{ start: 60, end: 64, text: 'the robot is offline for good' }, { start: 120, end: 124, text: 'something else entirely' }] },
    9002: { transcript: 'the robot is offline for good', segments: [{ start: 120, end: 124, text: 'the robot is offline for good' }] },
    6026: { transcript: 'but yeah and Cosmo is broken now', segments: [{ start: 864.08, end: 869.84, text: 'but yeah and Cosmo is broken now, so I have to get little buddy back' }, { start: 1581.2, end: 1583.92, text: 'Cosmo requires Wi-Fi.' }] },
    6025: { transcript: 'but yeah and Cosmo is broken now', segments: [{ start: 1541, end: 1546, text: 'but yeah and Cosmo is broken now, so I have to get little buddy back' }] },
};

const DEFAULT_VIDEO = {
    9001: { status: 301, location: '/v/9002?t=120' },
    9002: { status: 200 },
    6026: { status: 301, location: '/v/6025?t=1541' },
    6025: { status: 200 },
};

function listen(handler) {
    return new Promise((resolve) => {
        const sockets = new Set();
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj, headers = {}) => {
                    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
                    res.end(JSON.stringify(obj));
                };
                Promise.resolve(handler(req, raw, json, res)).catch((err) => json(500, { error: String(err && err.message) }));
            });
        });
        server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
        server.listen(0, '127.0.0.1', () => resolve({
            server, url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
        }));
    });
}

async function startUpstreams() {
    const state = {
        messages: DEFAULT_MESSAGES.map((m) => ({ ...m })),
        timeline: DEFAULT_TIMELINE.map((e) => ({ ...e })),
        topics: DEFAULT_TOPICS.map((t) => ({ ...t })),
        takes: JSON.parse(JSON.stringify(DEFAULT_TAKES)),
        vods: { ...DEFAULT_VODS },
        transcripts: JSON.parse(JSON.stringify(DEFAULT_TRANSCRIPTS)),
        video: { ...DEFAULT_VIDEO },
        requests: [],
    };

    const srv = await listen(async (req, raw, json, res) => {
        const url = new URL(req.url, 'http://x');
        const p = url.pathname;
        state.requests.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: { ...req.headers } });

        if (p === '/api/chat/global/history') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 200)));
            const before = url.searchParams.get('before');
            const list = state.messages
                .filter((m) => !before || m.timestamp <= before)
                .sort((a, b) => b.id - a.id)
                .slice(0, limit);
            return json(200, { messages: list, latest_id: list[0] ? list[0].id : null });
        }
        if (p === '/api/chat/ai/timeline') {
            const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit') || 60)));
            return json(200, { events: state.timeline.slice(0, limit), hasMore: false });
        }
        if (p === '/api/rundown/topics') {
            return json(200, { topics: state.topics, kinds: [] });
        }
        const topic = p.match(/^\/api\/rundown\/t\/([^/]+)$/);
        if (topic) {
            const slug = decodeURIComponent(topic[1]);
            const found = state.topics.find((t) => t.slug === slug);
            if (!found) return json(404, { error: 'not_found' });
            return json(200, { topic: found, takes: state.takes[slug] || [] });
        }
        const vod = p.match(/^\/api\/vods\/(\d+)$/);
        if (vod) {
            const row = state.vods[vod[1]];
            if (!row) return json(404, { error: 'not_found' });
            return json(200, { vod: row, clips: [] });
        }
        if (p === '/api/chat-ai/vod-transcripts') {
            const ids = String(url.searchParams.get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
            const out = {};
            for (const id of ids) if (state.transcripts[id]) out[id] = state.transcripts[id];
            return json(200, { transcripts: out });
        }
        const video = p.match(/^\/v\/(\d+)$/);
        if (video) {
            const conf = state.video[video[1]];
            if (!conf || conf.status === 404) return json(404, { error: 'not_found' });
            if (conf.status >= 400) return json(conf.status, { error: 'video unavailable' });
            if (conf.status >= 300 && conf.status < 400) {
                res.writeHead(conf.status, { Location: conf.location, 'Content-Type': 'text/plain' });
                return res.end('redirect');
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('<!doctype html><title>VOD</title>');
        }
        return json(404, { error: 'not found' });
    });

    return {
        url: srv.url,
        state,
        close: srv.close,
        requestsFor(path) { return state.requests.filter((r) => r.path === path); },
        lastFor(path) { return state.requests.filter((r) => r.path === path).pop() || null; },
        setVideo(id, conf) { state.video[String(id)] = conf; },
        addMessage(m) { state.messages.push(m); },
    };
}

module.exports = { startUpstreams, DEFAULT_MESSAGES, DEFAULT_TIMELINE, DEFAULT_TOPICS, DEFAULT_TAKES, DEFAULT_VODS, DEFAULT_TRANSCRIPTS, DEFAULT_VIDEO };
