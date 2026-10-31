'use strict';

/**
 * The fixed deny list: VOD 5709 and clip 483 are never cited, kept, cached or rendered by OpenVibe.Meme. Both answer
 * 404 anonymously; clip 483 is Live's AI auto-clip of sexual content (server/ai/explicit.js), and VOD 5709 has no
 * public row at all. A citation that would carry either id is dropped before it is written, and the seed script and
 * the importer both call this filter. No title, thumbnail or quote from either ever enters the database.
 *
 * The list also names the words no AI-written entry text may carry. A verbatim quote is never rewritten (that would
 * falsify the citation), but a title, a summary, an origin note and an example are the site's own words: they pass
 * this filter before they are stored, and an entry whose text carries one is never published.
 */
const DENIED_VOD_IDS = Object.freeze(new Set([5709]));
const DENIED_CLIP_IDS = Object.freeze(new Set([483]));
const DENIED_WORDS = Object.freeze(['nigger', 'faggot', 'retard', 'kys', 'rape', 'pedo', 'nazi']);

function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function isDeniedVod(vodId) {
    const n = num(vodId);
    return n != null && DENIED_VOD_IDS.has(n);
}

function isDeniedClip(clipId) {
    const n = num(clipId);
    return n != null && DENIED_CLIP_IDS.has(n);
}

/** True when a use names a denied VOD or clip. Accepts both wire and database column names. */
function isDenied({ vod_id, vodId, clip_id, clipId } = {}) {
    return isDeniedVod(vod_id != null ? vod_id : vodId) || isDeniedClip(clip_id != null ? clip_id : clipId);
}

/** The uses that may be cited: everything except the fixed deny list. */
function allowed(uses) {
    return (Array.isArray(uses) ? uses : []).filter((u) => !isDenied(u));
}

/** True when a text carries a word the deny list names. The word must stand on its own. */
function hasDeniedWord(text) {
    const s = String(text == null ? '' : text);
    if (!s) return false;
    return DENIED_WORDS.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, 'i').test(s));
}

/** The text of a field the site's own words carry: clean when it names nothing on the deny list. */
function isCleanText(text) {
    return !hasDeniedWord(text);
}

module.exports = { DENIED_VOD_IDS, DENIED_CLIP_IDS, DENIED_WORDS, isDenied, isDeniedVod, isDeniedClip, allowed, hasDeniedWord, isCleanText };
