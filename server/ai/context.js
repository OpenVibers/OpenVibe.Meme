'use strict';

/**
 * The cited material a judge reads. A citation stores one verbatim line; a joke only makes sense with its
 * neighbours, so before the AI is asked anything, each citation is opened up: the chat lines around a chat message,
 * the transcript lines around a VOD second. Nothing new is created — every line comes from the same public API the
 * citation itself came from, and a citation whose context cannot be read is still cited, just without context.
 *
 * The block that reaches the model is the only place a quote is shown: the verbatim text and the lines around it.
 */
const { parseApiTime } = require('../upstreams');

const DAY = 86_400_000;

/** "2026-10-20 10:00:00" → the day it happened, in UTC. */
function utcDay(iso) {
    const s = String(iso || '');
    return s.length >= 10 ? s.slice(0, 10) : '';
}

function createContext({ config, upstreams, log = console }) {
    const lines = Math.max(1, Number(config.judge && config.judge.contextLines) || 6);

    /** The lines around one citation. Never throws: a missing context is an empty context. */
    async function around(citation) {
        try {
            if (citation.source_type === 'chat_message' || citation.source_service === 'chat') {
                return await upstreams.chatContext(citation, { lines });
            }
            if (citation.vod_id != null && citation.offset_seconds != null) {
                return await upstreams.vodContext(citation.vod_id, citation.offset_seconds, { lines });
            }
        } catch (err) {
            log.warn(`[OpenVibe.Meme] context for ${citation.source_type}:${citation.source_id}: ${err.message}`);
        }
        return [];
    }

    /** Every citation with its context, oldest first. */
    async function prepare(citations) {
        const out = [];
        for (const citation of citations || []) {
            out.push({ citation, context: await around(citation) });
        }
        return out;
    }

    /**
     * The block the judge reads: one numbered use per citation, with the quote and the lines around it.
     * The text is trimmed so a long transcript cannot push the question out of the model's window.
     */
    function render(prepared) {
        const parts = [];
        let n = 0;
        for (const { citation, context } of prepared || []) {
            n += 1;
            const when = utcDay(citation.observed_at);
            const where = citation.source_service === 'live' ? 'OpenVibe.Live'
                : citation.source_service === 'chat' ? 'OpenVibe.Chat'
                    : citation.source_service === 'community' ? 'OpenVibe.Community'
                        : citation.source_type === 'wikipedia' ? 'Wikipedia'
                            : citation.source_type === 'wikidata' ? 'Wikidata'
                                : citation.source_type === 'commons' ? 'Wikimedia Commons'
                                    : citation.source_service;
            const head = `Use ${n} (${where}, ${when || 'unknown date'}): "${String(citation.quote_text || '').slice(0, 600)}"`;
            const linesOut = [];
            for (const line of context || []) {
                if (line.who) linesOut.push(`  ${line.who}: ${String(line.text || '').slice(0, 400)}`);
                else linesOut.push(`  ${String(line.text || '').slice(0, 400)}`);
            }
            parts.push(linesOut.length ? `${head}\n${linesOut.join('\n')}` : head);
        }
        return parts.join('\n\n');
    }

    return { prepare, render, around, utcDay };
}

module.exports = { createContext, utcDay };
