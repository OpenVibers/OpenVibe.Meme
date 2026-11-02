'use strict';
/**
 * Each person's share of the AI features (analyze, research, generate): a cap a day per person, on top of each
 * feature's daily budget for everyone, so one account cannot spend the whole day's budget. Staff are not capped.
 * The count is meme_person_usage (migration 0008), one row per UTC day, person and feature.
 *
 *   check({ subject, kind, staff }) → { ok: true } or the 429 refusal, before any work starts
 *   add({ subject, kind, staff })   counts one use, after the feature succeeded (a refused or failed try is free)
 *
 * Two requests at the same moment can both pass the check; the cap is a fair share, not an exact meter.
 */
const WORDS = { analyze: 'analyses', research: 'deep dives', generate: 'generated memes' };

function createPersonCap({ config, s }) {
    const day = () => new Date(s.now()).toISOString().slice(0, 10);
    const limitOf = (kind) => Number((config.perPerson || {})[kind]) || 0;
    const counted = ({ subject, kind, staff }) => !staff && typeof subject === 'string' && subject !== '' && limitOf(kind) > 0;

    async function check({ subject, kind, staff = false }) {
        if (!counted({ subject, kind, staff })) return { ok: true };
        const row = await s.db.maybe('SELECT uses FROM meme_person_usage WHERE day = $1::date AND subject = $2 AND kind = $3', [day(), subject, kind]);
        const used = row ? Number(row.uses) || 0 : 0;
        const limit = limitOf(kind);
        if (used >= limit) {
            return { ok: false, status: 429, code: 'meme.person_cap', message: `You have used today's ${limit} ${WORDS[kind] || kind}. More tomorrow (the day turns at midnight UTC).` };
        }
        return { ok: true, used, limit };
    }

    async function add({ subject, kind, staff = false }) {
        if (!counted({ subject, kind, staff })) return;
        await s.db.exec(
            `INSERT INTO meme_person_usage (day, subject, kind, uses, updated_at) VALUES ($1::date, $2, $3, 1, now())
             ON CONFLICT (day, subject, kind) DO UPDATE SET uses = meme_person_usage.uses + 1, updated_at = now()`,
            [day(), subject, kind],
        );
    }

    return { check, add };
}

module.exports = { createPersonCap };
