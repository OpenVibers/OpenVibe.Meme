'use strict';

/**
 * Citation re-verification, once a day (MEME_REVERIFY_INTERVAL_MS; off under MEME_DRILL). Every citation's public
 * URL is read again: a 404/410 (a private VOD, a deleted clip) marks it gone; a 401/403 marks it hidden. A Chat
 * citation is re-read from the public history page because v1 has no per-message permalink API. An entry whose
 * origin citation is no longer live is hidden (revision +1, Search tombstone) — the plan's rule.
 *
 * The job is small and sequential on purpose: a handful of reads per citation, and a failing upstream leaves that
 * citation as it was (a transient 503 must not erase a real citation).
 */
const { parseApiTime } = require('./upstreams');
const { isDenied } = require('./deny-list');

function createReverifier({ config, s, entries, upstreams, log = console }) {
    let timers = [];
    const stats = { runs: 0, checked: 0, gone: 0, hidden: 0, entries_hidden: 0, errors: 0, last_run_at: null, last_error: null };

    async function verifyOne(citation) {
        if (isDenied({ vod_id: citation.vod_id, clip_id: citation.clip_id })) return { status: 'gone', denied: true };
        if (citation.source_type === 'chat_message') {
            const r = await upstreams.chatMessage(citation);
            return { status: r.status, text: r.text || null };
        }
        const r = await upstreams.citationUrl(citation.url);
        const out = { status: r.status };
        if (r.finalUrl && r.finalUrl !== citation.url) {
            try {
                const u = new URL(r.finalUrl);
                const m = u.pathname.match(/\/v\/(\d+)\/?$/);
                if (m) {
                    out.vod_id = Number(m[1]);
                    const t = u.searchParams.get('t');
                    if (t != null && t !== '') out.offset_seconds = Number(t);
                }
                out.url = u.toString();
            } catch { /* keep the stored URL */ }
        }
        return out;
    }

    async function runOnce({ limit = 500 } = {}) {
        const runAt = new Date(s.now()).toISOString();
        const rows = await s.db.many(
            "SELECT * FROM meme_citations WHERE source_status <> 'gone' ORDER BY captured_at ASC, id ASC LIMIT $1",
            [Math.min(5000, Math.max(1, Number(limit) || 500))],
        );
        let checked = 0;
        let gone = 0;
        let hidden = 0;
        const toHide = new Set();
        const toReindex = new Set();
        const errors = [];
        for (const row of rows) {
            checked++;
            try {
                const r = await verifyOne(row);
                const status = r.status === 'live' ? 'live' : r.status === 'hidden' ? 'hidden' : 'gone';
                if (status === 'gone') gone++;
                if (status === 'hidden') hidden++;
                if (status !== row.source_status || r.url || r.vod_id != null || r.offset_seconds != null) {
                    if (status !== 'live') toHide.add(row.entry_id);
                    else toReindex.add(row.entry_id);
                    await s.db.exec(
                        `UPDATE meme_citations SET source_status = $2,
                            url = COALESCE($3, url),
                            vod_id = COALESCE($4, vod_id),
                            offset_seconds = COALESCE($5, offset_seconds),
                            captured_at = now()
                         WHERE id = $1`,
                        [row.id, status, r.url || null, r.vod_id == null ? null : r.vod_id, r.offset_seconds == null ? null : r.offset_seconds],
                    );
                } else {
                    await s.db.exec('UPDATE meme_citations SET captured_at = now() WHERE id = $1', [row.id]);
                }
            } catch (err) {
                errors.push(`citation ${row.id}: ${err.message}`);
                log.warn(`[OpenVibe.Meme] re-verify ${row.id} failed: ${err.message}`);
            }
        }

        let entryHides = 0;
        for (const entryId of toHide) {
            try {
                const originGone = await s.db.maybe(
                    "SELECT id FROM meme_citations WHERE entry_id = $1 AND role = 'origin' AND source_status <> 'live' LIMIT 1",
                    [entryId],
                );
                if (!originGone) { toReindex.add(entryId); continue; }
                const row = await entries.byId(entryId);
                if (!row || row.visibility === 'hidden') continue;
                const r = await entries.hide(row.slug, { changedBy: 'service:meme:reverify' });
                if (r && r.ok && !r.unchanged) entryHides++;
            } catch (err) {
                errors.push(`entry ${entryId}: ${err.message}`);
                log.warn(`[OpenVibe.Meme] re-verify entry ${entryId} failed: ${err.message}`);
            }
        }
        // A live use that came back, or a joined-VOD URL that moved, changes the public document without hiding it.
        for (const entryId of toReindex) {
            try { await entries.reindex(entryId); } catch (err) {
                errors.push(`entry ${entryId}: ${err.message}`);
                log.warn(`[OpenVibe.Meme] re-index entry ${entryId} failed: ${err.message}`);
            }
        }

        stats.runs++;
        stats.checked += checked;
        stats.gone += gone;
        stats.hidden += hidden;
        stats.entries_hidden += entryHides;
        stats.errors += errors.length;
        stats.last_run_at = runAt;
        stats.last_error = errors[0] || null;
        log.log(`[OpenVibe.Meme] re-verify: ${checked} citations, ${gone} gone, ${hidden} hidden, ${entryHides} entries hidden${errors.length ? `, ${errors.length} errors` : ''}`);
        return { checked, gone, hidden, entries_hidden: entryHides, errors };
    }

    function start() {
        if (config.drill || timers.length) return false;
        const quiet = () => runOnce().catch((err) => log.warn(`[OpenVibe.Meme] re-verify tick failed: ${err.message}`));
        const kick = setTimeout(quiet, 60_000);
        const tick = setInterval(quiet, config.reverify.intervalMs);
        if (kick.unref) kick.unref();
        if (tick.unref) tick.unref();
        timers = [kick, tick];
        return true;
    }
    function stop() {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
    }

    return { runOnce, verifyOne, start, stop, stats: () => ({ ...stats, running: timers.length > 0 }) };
}

module.exports = { createReverifier, parseApiTime };
