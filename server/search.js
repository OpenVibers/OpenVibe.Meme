'use strict';

/**
 * OpenVibe.Meme's Search Fabric feed. Every public entry is one `search.index-document@1` (owner `meme`, type
 * `entry`, page `/m/<slug>`), written to `meme_outbox` in the same transaction as the entry change; a hidden
 * entry writes a tombstone, which wins over any older revision. The document carries the entry's AI-cleaned
 * summary, the verbatim quotes as plain-text body, facets `kind`/`status`/`source`, authorship `ai_assisted` and
 * one provenance reference per citation — the same shape Work, Help and the other record products send.
 *
 * No service grant is needed to queue the rows: they wait in the outbox until OpenVibe.Search's document writer
 * is configured for `meme` (research §6.2). The relay is deliberately not part of v1.
 */
const { ids } = require('openvibe-contracts');

const OWNER = 'meme';
const TYPE = 'entry';
const EVENT_UPSERTED = 'meme.index_document.upserted';
const EVENT_DELETED = 'meme.index_document.deleted';

const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));
const pagePath = (entry) => `/m/${entry.slug}`;

function provenanceOf(citations) {
    const seen = new Set();
    const out = [];
    for (const c of citations || []) {
        const key = `${c.source_service}:${c.source_type}:${c.source_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            service: c.source_service,
            type: c.source_type,
            id: String(c.source_id).slice(0, 128),
            ...(c.url ? { url: String(c.url).slice(0, 2048) } : {}),
            ...(c.captured_at || c.observed_at ? { retrieved_at: iso(c.captured_at || c.observed_at) } : {}),
        });
        if (out.length >= 50) break;
    }
    return out;
}

/** One entry + its live citations + its internet origin → the Search document (or a tombstone). */
function documentOf(entry, citations = [], { baseUrl = 'https://openvibe.meme', origin = null } = {}) {
    const revision = Math.max(1, Number(entry.revision) || 1);
    if (!entry || entry.visibility !== 'public') return { owner: OWNER, type: TYPE, id: entry.id, revision, deleted: true };
    const live = (citations || []).filter((c) => c.source_status === 'live');
    const sources = [...new Set(live.map((c) => c.source_service))];
    const body = [entry.title, entry.summary || '', entry.meaning || '', entry.usage || '',
        ...(origin && origin.title ? [origin.title] : []), ...live.map((c) => c.quote_text)]
        .filter(Boolean).join('\n').slice(0, 48_000);
    const provenance = [
        ...(origin ? [{ service: 'memes', type: 'origin', id: String(origin.url).slice(0, 128), url: origin.url, ...(origin.retrieved_at ? { retrieved_at: iso(origin.retrieved_at) } : {}) }] : []),
        ...provenanceOf(live),
    ].slice(0, 50);
    return {
        owner: OWNER,
        type: TYPE,
        id: entry.id,
        revision,
        deleted: false,
        visibility: 'public',
        canonical_url: `${String(baseUrl).replace(/\/+$/, '')}${pagePath(entry)}`,
        title: entry.title,
        ...(entry.summary ? { summary: entry.summary } : {}),
        body,
        facets: { kind: entry.kind, status: entry.status, scope: entry.scope || 'openvibe', labels: entry.labels || [], source: sources },
        authorship: entry.submitted_by || (origin && origin.author) ? 'human' : 'ai_assisted',
        provenance,
        publication_state: 'published',
        published_at: iso(entry.created_at),
        updated_at: iso(entry.updated_at),
        indexability: { decision: 'index' },
    };
}

function createSearchIndex({ config, s, baseUrl = config.baseUrl }) {
    const nowIso = () => new Date(s.now()).toISOString();

    async function enqueue(topic, payload, t = null) {
        const db = t || s.db;
        const eventId = ids.newId('event', s.now());
        await db.exec(
            `INSERT INTO meme_outbox (event_id, topic, payload, created_at, next_attempt_at)
             VALUES ($1, $2, $3::jsonb, $4::timestamptz, $4::timestamptz)`,
            [eventId, topic, JSON.stringify(payload), nowIso()],
        );
        return eventId;
    }

    /** Queue the current document on the caller's transaction (upsert when public, tombstone otherwise). */
    async function sync(t, entry, citations) {
        const db = t || s.db;
        const origin = entry && entry.visibility === 'public'
            ? await db.maybe('SELECT * FROM meme_origins WHERE entry_id = $1', [entry.id])
            : null;
        const doc = documentOf(entry, citations, { baseUrl, origin });
        return await enqueue(doc.deleted ? EVENT_DELETED : EVENT_UPSERTED, doc, t);
    }

    /** Tombstone an id that no longer exists or is now hidden. */
    async function remove(t, id, revision) {
        return await enqueue(EVENT_DELETED, { owner: OWNER, type: TYPE, id, revision: Math.max(1, Number(revision) || 1), deleted: true }, t);
    }

    async function pending() {
        return Number(await s.db.value('SELECT COUNT(*)::int AS n FROM meme_outbox WHERE published_at IS NULL'));
    }

    return { sync, remove, enqueue, documentOf, pending, baseUrl: String(baseUrl).replace(/\/+$/, '') };
}

module.exports = { createSearchIndex, documentOf, provenanceOf, pagePath, OWNER, TYPE, EVENT_UPSERTED, EVENT_DELETED };
