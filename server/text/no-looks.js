'use strict';

/**
 * No looks in public AI text (the network rule, openvibe-sdk/no-looks, shared with Live, Community and MediaHub):
 * an AI-written summary never describes a person's body, clothing, hair, face or guessed gender. A summary that
 * names looks at all is not repaired word by word — it is replaced by the entry's title, as Meme's plan says.
 * Verbatim quotes are never passed through this: rewriting a quote would falsify the citation.
 */
const { noLooks, hasLooks } = require('openvibe-sdk/no-looks');

/** The summary to store for an AI-written entry summary. */
function cleanSummary(title, summary) {
    const t = String(title || '').trim() || 'Untitled meme';
    const s = String(summary == null ? '' : summary).trim();
    if (!s) return t;
    if (hasLooks(s)) return t;
    const cleaned = String(noLooks(s) || '').trim();
    return cleaned || t;
}

module.exports = { cleanSummary, noLooks, hasLooks };
