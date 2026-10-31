'use strict';

/**
 * L24 (the light rules): AI text is stored as written. The owner retired the looks filter on 2026-10-31 ("there
 * should be no reason it can't describe people … remove all that crap"), so there is no `noLooks` call here any
 * more; a summary that describes a person's body, clothing or hair is kept. Labels describe content; they never
 * ban it. Verbatim quotes were never passed through a filter and still are not.
 *
 * The module keeps its old name so existing callers and scripts do not break; `cleanSummary` now only trims and
 * falls back to the title for an empty summary.
 */
function cleanSummary(title, summary) {
    const t = String(title || '').trim() || 'Untitled meme';
    const s = String(summary == null ? '' : summary).replace(/\s+/g, ' ').trim();
    return s || t;
}

module.exports = { cleanSummary };
