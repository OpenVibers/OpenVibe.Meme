#!/usr/bin/env node
'use strict';

/**
 * The first proof entry: "Cozmo is offline" (research §6.3), seeded from the live public APIs and left hidden for
 * a staff person to publish.
 *
 *   node scripts/seed-proof.js
 *
 * It reads three public things: the Chat global history around the known line (message 86957, 2026-10-28
 * 00:11:53), VOD 6026's transcript segment at 864.08 s, and OpenVibe.Video's own redirect for
 * `/v/6026?t=864` → `/v/6025?t=1541` so the stored citation is the canonical one. Nothing is invented: the quote
 * is verbatim, the hash is its sha256, and the entry is created `hidden`.
 *
 * Re-running is safe: an existing `cozmo-offline` entry is left as it is (a second run adds only a citation that is
 * not already there). The deny list (VOD 5709, clip 483) is enforced before anything is written.
 */
const { load } = require('../server/config');
const { openStore } = require('../server/db');
const { createUpstreams, parseApiTime } = require('../server/upstreams');
const { createStore } = require('../server/store');
const { cleanSummary } = require('../server/text/no-looks');
const { isDenied } = require('../server/deny-list');

const CHAT_MESSAGE_ID = 86957;
const SOURCE_VOD = 6026;
const SOURCE_SEC = 864.08;
const TITLE = 'Cozmo is offline';
const SLUG = 'cozmo-offline';

function short(s, n = 100) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

async function findChatLine(upstreams) {
    // The known before-page: one minute after the line, so the page ends just past it.
    for (const before of ['2026-10-28 00:12:00', null]) {
        const page = await upstreams.chatHistory({ before, limit: 200 });
        const byId = page.messages.find((m) => Number(m.id) === CHAT_MESSAGE_ID);
        if (byId && Number(byId.is_deleted) !== 1) return byId;
        const byText = page.messages.find((m) => Number(m.is_deleted) !== 1 && /\bcozmo\b/i.test(String(m.message)) && /\b(online|offline)\b/i.test(String(m.message)));
        if (byText) return byText;
    }
    return null;
}

async function findSegment(upstreams) {
    const all = await upstreams.transcripts([SOURCE_VOD]);
    const t = all[String(SOURCE_VOD)];
    const segments = t && Array.isArray(t.segments) ? t.segments : [];
    let best = null;
    for (const seg of segments) {
        const d = Math.abs(Number(seg.start) - SOURCE_SEC);
        if (!best || d < best.d) best = { seg, d };
    }
    if (!best || best.d > 5 || !/\b(cosmo|cozmo)\b/i.test(String(best.seg.text))) return null;
    return best.seg;
}

async function runSeed({ config, s, upstreams, log = console } = {}) {
    if (!config) config = load();
    if (!upstreams) upstreams = createUpstreams({ config, log });
    if (!s) s = await openStore(config, { log });
    const search = { sync: async () => null }; // a hidden entry writes no Search document
    const entries = createStore(s, { search });

    const msg = await findChatLine(upstreams);
    if (!msg) throw new Error('the public Chat history did not contain message 86957 (or another Cozmo line); nothing was written');
    const seg = await findSegment(upstreams);
    if (!seg) throw new Error(`VOD ${SOURCE_VOD}'s public transcript did not contain the Cozmo segment near ${SOURCE_SEC}s; nothing was written`);

    const canon = await upstreams.canonicalVideo(SOURCE_VOD, SOURCE_SEC);
    if (canon.denied || canon.gone || canon.hidden || !canon.url) {
        throw new Error(`OpenVibe.Video would not resolve VOD ${SOURCE_VOD}@${SOURCE_SEC} to a public URL (${canon.gone ? '404/gone' : canon.hidden ? 'hidden' : 'denied'}); nothing was written`);
    }
    if (isDenied({ vod_id: canon.vod_id })) throw new Error('the resolved VOD is on the fixed deny list; nothing was written');

    const chatAt = parseApiTime(msg.timestamp);
    let vodAt = null;
    try { const row = await upstreams.vod(SOURCE_VOD); vodAt = row ? parseApiTime(row.created_at || row.published_at || row.recorded_at || row.started_at) : null; } catch { /* the chat time is enough */ }
    if (!vodAt) {
        try { const row = await upstreams.vod(canon.vod_id); vodAt = row ? parseApiTime(row.created_at || row.published_at || row.recorded_at || row.started_at) : null; } catch { /* still fine */ }
    }
    const observedVod = vodAt || chatAt;

    const citations = [
        {
            role: 'origin', source_service: 'chat', source_type: 'chat_message', source_id: String(msg.id),
            chat_message_id: Number(msg.id), quote_text: String(msg.message), url: `${upstreams.base(config.upstreams.chat)}/`,
            observed_at: chatAt,
        },
        {
            role: 'use', source_service: 'live', source_type: 'vod', source_id: String(canon.vod_id),
            vod_id: canon.vod_id, offset_seconds: canon.offset_seconds, quote_text: String(seg.text), url: canon.url,
            observed_at: observedVod,
        },
    ].filter((c) => !isDenied(c));
    if (citations.length !== 2) throw new Error('a citation landed on the fixed deny list; nothing was written');

    const first = citations.reduce((m, c) => (Date.parse(c.observed_at) < Date.parse(m) ? c.observed_at : m), citations[0].observed_at);
    const last = citations.reduce((m, c) => (Date.parse(c.observed_at) > Date.parse(m) ? c.observed_at : m), citations[0].observed_at);
    const summary = cleanSummary(TITLE, 'Cozmo, the robot, is not online: a chat line and a stream moment about its Wi-Fi. The robot is offline, again.');

    const existing = await entries.bySlug(SLUG);
    if (existing) {
        const enriched = await entries.enrich(existing.id, { first_seen_at: first, last_seen_at: last, cites: citations });
        const added = enriched && enriched.added ? enriched.added : 0;
        log.log(`[seed-proof] ${SLUG} already exists (${existing.id}, ${existing.visibility}); ${added} new citation(s) added — left as it is`);
        return { created: false, entry: existing, citations, added };
    }

    const out = await entries.createCandidate({
        slug: SLUG, title: TITLE, kind: 'joke', summary, status: 'classic',
        first_seen_at: first, last_seen_at: last, visibility: 'hidden', citations,
    });
    log.log(`[seed-proof] created ${out.entry.id} /${SLUG} (${out.entry.visibility}, ${out.entry.status})`);
    log.log(`[seed-proof] origin: chat message ${msg.id} at ${msg.timestamp} — "${short(msg.message, 90)}"`);
    log.log(`[seed-proof] use:    VOD ${canon.vod_id} @${canon.offset_seconds}s (source part ${SOURCE_VOD} @${SOURCE_SEC}s) — "${short(seg.text, 90)}"`);
    log.log('[seed-proof] publish it with: POST /api/v1/entries/cozmo-offline/publish (Network role staff+)');
    return { created: true, entry: out.entry, citations: out.citations };
}

async function main() {
    const config = load();
    const s = await openStore(config, { log: console });
    try {
        const out = await runSeed({ config, s });
        process.exitCode = out && out.entry ? 0 : 1;
    } finally {
        await s.close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(`[seed-proof] ${err && err.message ? err.message : err}`);
        process.exitCode = 1;
    });
}

module.exports = { runSeed, findChatLine, findSegment, TITLE, SLUG, CHAT_MESSAGE_ID, SOURCE_VOD, SOURCE_SEC };
