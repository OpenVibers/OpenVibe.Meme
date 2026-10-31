'use strict';

/**
 * The publish rule. A judged candidate is published only when it clears every bar:
 *
 *   - the AI scored it 0.75 or more on "is this a real meme, catchphrase or inside joke";
 *   - it was used at least three times, across at least two days or at least two channels;
 *   - nothing it cites is on the deny list, and its own text carries no denied word;
 *   - its text names nobody's looks;
 *   - it is complete: a title, a summary, where it started and how people use it;
 *   - it has a live origin citation (an entry without an origin is not an entry).
 *
 * Everything else stays hidden for staff, with its score. The reasons are returned, not just a yes or a no, so the
 * staff list can say why.
 */
const { utcDay } = require('./context');
const { hasLooks } = require('../text/no-looks');

/** The uses that count: the live origin and use citations. An example is an illustration, not a use. */
function countUses(citations) {
    const live = (citations || []).filter((c) => c.source_status === 'live' && (c.role === 'origin' || c.role === 'use'));
    const days = new Set(live.map((c) => utcDay(c.observed_at)).filter(Boolean)).size;
    const channels = new Set(live.map((c) => c.source_service).filter(Boolean)).size;
    const hasOrigin = live.some((c) => c.role === 'origin');
    return { uses: live.length, days, channels, hasOrigin };
}

function evaluate({ entry = null, citations = [], judgement = null, gate = {} } = {}) {
    const minScore = Number.isFinite(Number(gate.minScore)) ? Number(gate.minScore) : 0.75;
    const minUses = Math.max(1, Number(gate.minUses) || 3);
    const minDays = Math.max(1, Number(gate.minDays) || 2);
    const minChannels = Math.max(1, Number(gate.minChannels) || 2);

    const { uses, days, channels, hasOrigin } = countUses(citations);
    const reasons = [];

    if (!judgement) reasons.push('not judged yet');
    else {
        const score = Number(judgement.score);
        if (!Number.isFinite(score)) reasons.push('no score');
        else if (score < minScore) reasons.push(`scored ${score.toFixed(2)}, under ${minScore.toFixed(2)}`);
        if (judgement.denied) reasons.push('a denied source');
        if (judgement.looks) reasons.push('the text names looks');
        if (!judgement.title) reasons.push('no title');
        if (!judgement.summary) reasons.push('no summary');
        if (!judgement.origin) reasons.push('no origin');
        if (!judgement.spread) reasons.push('no spread');
        if (!Array.isArray(judgement.examples) || judgement.examples.length < 2) reasons.push('fewer than two examples');
    }
    if (entry && entry.title && hasLooks(entry.title)) reasons.push('the title names looks');
    if (uses < minUses) reasons.push(`used ${uses} time${uses === 1 ? '' : 's'}, needs ${minUses}`);
    if (days < minDays && channels < minChannels) {
        reasons.push(`used on ${days} day${days === 1 ? '' : 's'} in ${channels} channel${channels === 1 ? '' : 's'}, needs ${minDays} days or ${minChannels} channels`);
    }
    if (!hasOrigin) reasons.push('no live origin citation');

    return {
        publish: reasons.length === 0,
        reasons,
        uses,
        days,
        channels,
        score: judgement ? Number(judgement.score) : null,
        minScore,
    };
}

/**
 * The encyclopedia's rule. A classic has no uses to count: it is published when the AI scored it as a real, widely
 * used meme and its own text is clean (no looks, no denied word, nothing denied in what it cites).
 */
function evaluateClassic({ judgement = null, minScore = 0.75, entry = null } = {}) {
    const reasons = [];
    if (!judgement) reasons.push('not judged yet');
    else {
        const score = Number(judgement.score);
        if (!Number.isFinite(score)) reasons.push('no score');
        else if (score < minScore) reasons.push(`scored ${score.toFixed(2)}, under ${minScore.toFixed(2)}`);
        if (judgement.denied) reasons.push('a denied source');
        if (judgement.looks) reasons.push('the text names looks');
        if (!judgement.title) reasons.push('no title');
        if (!judgement.summary) reasons.push('no summary');
        if (!judgement.origin) reasons.push('no origin');
        if (!judgement.spread) reasons.push('no spread');
        if (!Array.isArray(judgement.examples) || judgement.examples.length < 2) reasons.push('fewer than two examples');
    }
    if (entry && entry.title && hasLooks(entry.title)) reasons.push('the title names looks');
    return {
        publish: reasons.length === 0,
        reasons,
        uses: 0,
        days: 0,
        channels: 0,
        score: judgement ? Number(judgement.score) : null,
        minScore,
    };
}

module.exports = { evaluate, evaluateClassic, countUses };
