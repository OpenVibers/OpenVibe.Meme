'use strict';

/**
 * The fixed deny list: VOD 5709 and clip 483 are never cited, kept, cached or rendered by OpenVibe.Meme. Both answer
 * 404 anonymously; clip 483 is Live's AI auto-clip of sexual content (server/ai/explicit.js), and VOD 5709 has no
 * public row at all. A citation that would carry either id is dropped before it is written, and the seed script and
 * the importer both call this filter. No title, thumbnail or quote from either ever enters the database.
 */
const DENIED_VOD_IDS = Object.freeze(new Set([5709]));
const DENIED_CLIP_IDS = Object.freeze(new Set([483]));

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

module.exports = { DENIED_VOD_IDS, DENIED_CLIP_IDS, isDenied, isDeniedVod, isDeniedClip, allowed };
