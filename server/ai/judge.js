'use strict';

/**
 * The judge. One AI run per candidate: it scores the candidate from 0 to 1 on whether it is a real meme, catchphrase
 * or inside joke rather than everyday words that happen to recur, and it writes the entry from the same cited
 * material: a title in natural case, a short summary, where it started, how people use it, and two or three example
 * uses.
 *
 * Two rules hold whatever the model says:
 *   - the text never names looks (openvibe-sdk/no-looks): a title that names them is not used, and every other
 *     field is repaired word by word; an entry whose text named them is never published;
 *   - the text never carries a word from the deny list (server/deny-list.js).
 *
 * The score and the reason are stored with the entry, so a staff person sees why a candidate was kept and the
 * history says what the AI decided.
 */
const { noLooks, hasLooks } = require('../text/no-looks');
const { isDenied, hasDeniedWord } = require('../deny-list');

const JUDGE_SYSTEM = [
    'You are the editor of OpenVibe.Meme, an open encyclopedia of memes: the running jokes of a streaming network and the memes of the internet.',
    'You judge one candidate at a time and you use only the cited material in front of you. If the citations do not show it, it is not there.',
    'You answer with one JSON object and nothing else.',
].join('\n');

const JUDGE_SCHEMA = Object.freeze({
    score: 'number from 0 to 1',
    reason: 'one or two sentences saying why you gave that score',
    title: 'the name people would actually say, in natural case',
    summary: 'one or two sentences on what it is',
    origin: 'where it started, from the cited uses',
    spread: 'how people use it: how it is deployed and who says it',
    examples: 'two or three short example uses, written the way people would say them',
});

const SCORE_LINE = [
    'Score it from 0 to 1:',
    '  1.00  a clear, shared joke people play off on purpose',
    '  0.75  the bar: recognisably a catchphrase, bit or meme with a shared meaning',
    '  0.50  maybe, but it could just be ordinary speech that happens to recur',
    '  0.00  everyday words; nothing shared, nothing to play off',
].join('\n');

const RULES = [
    'Rules:',
    '- Write only what the cited material shows. Never add a fact from outside it, and never invent a person.',
    '- Never describe anyone\'s body, clothing, hair, face or age, and never guess someone\'s gender.',
    '- Keep the title short, in natural case ("Cozmo\'s alive", not "COZMO S ALIVE").',
    '- If the material does not support a field, leave it an empty string rather than guessing.',
].join('\n');

const maxLen = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

/** The score the model gave, kept only when it is a number between 0 and 1. */
function readScore(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

/** The examples, as a list of short lines. */
function readExamples(value) {
    const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split('\n') : []);
    const out = [];
    for (const item of list) {
        const line = maxLen(item, 160);
        if (line) out.push(line);
        if (out.length >= 5) break;
    }
    return out;
}

/**
 * Clean the AI's own words: no looks, no denied word.
 *
 * A title that names looks is not used at all — it is not repaired word by word, it is dropped, and the entry keeps
 * the name it already had (the phrase it was found under, or the name the source gives it). Every other field is
 * repaired word by word; a field that still names looks after the repair is kept but marked, and an entry with such
 * a field is never published.
 */
function cleanFields({ title, summary, origin, spread, examples }) {
    const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
    const looksTitle = hasLooks(t);
    const fields = {
        title: looksTitle ? '' : maxLen(t, 160),
        summary: maxLen(noLooks(summary), 600),
        origin: maxLen(noLooks(origin), 600),
        spread: maxLen(noLooks(spread), 600),
        examples: (examples || []).map((e) => maxLen(noLooks(e), 200)).filter(Boolean),
    };
    const looks = looksTitle
        || hasLooks(fields.summary) || hasLooks(fields.origin) || hasLooks(fields.spread)
        || fields.examples.some((e) => hasLooks(e));
    const denied = hasDeniedWord(`${fields.title} ${fields.summary} ${fields.origin} ${fields.spread} ${fields.examples.join(' ')}`);
    return { ...fields, looks, denied };
}

/**
 * Judge one candidate or one classic. `kind` is 'candidate' (an OpenVibe running joke, cited to its own moments)
 * or 'classic' (an internet meme, cited to Wikipedia and Wikidata).
 */
function createJudge({ config, ai, context, log = console }) {
    /**
     * @param {object} subject  { title, kind, phrase }
     * @param {Array} prepared  the citations with their context, from server/ai/context.js
     */
    async function judge(subject, prepared) {
        if (!ai || !ai.enabled) throw new Error('OpenVibe.AI is not configured for OpenVibe.Meme.');
        const block = context.render(prepared);
        const isClassic = subject.kind === 'classic';
        const what = isClassic
            ? `Write the encyclopedia entry for the internet meme "${subject.title}".`
            : `Judge this candidate phrase from OpenVibe: "${subject.title}".`;
        const ask = isClassic
            ? [
                what,
                '',
                'Score it from 0 to 1 on how much it is a real, widely used meme rather than a one-off video, a product or a person:',
                '  1.00  a well-known meme with a shared meaning',
                '  0.75  the bar: a recognisable, reused meme',
                '  0.50  maybe, but it is niche or long forgotten',
                '  0.00  not a meme',
                '',
                'Then write the entry from the cited sources only: the title in natural case, a short summary, where it started, how it spread and how people use it, and two or three example uses.',
                '',
                'Cited sources:',
                block,
                '',
                RULES,
            ].join('\n')
            : [
                what,
                '',
                'Is it a real meme, catchphrase or inside joke — something people play off on purpose, with a shared meaning — or is it just everyday words that happen to recur?',
                '',
                SCORE_LINE,
                '',
                'Then write the entry from the cited uses only: the title in natural case, a short summary, where it started, how people use it, and two or three example uses.',
                '',
                'Cited uses:',
                block,
                '',
                RULES,
            ].join('\n');

        const out = await ai.json({
            prompt: ask,
            system: JUDGE_SYSTEM,
            schema: JUDGE_SCHEMA,
            temperature: 0.2,
            target: { service: 'meme', type: 'judgement', id: `judge_${String(subject.id || subject.title).slice(0, 100)}` },
        });

        const data = out.data || {};
        const score = readScore(data.score);
        if (score == null) throw new Error('the AI run did not give a score');
        const cleaned = cleanFields({
            title: data.title,
            summary: data.summary,
            origin: data.origin,
            spread: data.spread,
            examples: readExamples(data.examples),
        });
        const deniedCitation = (prepared || []).some(({ citation }) => isDenied(citation));
        return {
            score,
            reason: maxLen(data.reason, 600) || 'The AI gave no reason.',
            ...cleaned,
            denied: cleaned.denied || deniedCitation,
            looks: cleaned.looks,
            model: out.model,
            provider: out.provider,
            run_id: out.run_id,
        };
    }

    return { judge, cleanFields, readScore, readExamples, enabled: Boolean(ai && ai.enabled), JUDGE_SCHEMA, JUDGE_SYSTEM };
}

module.exports = { createJudge, cleanFields, readScore, readExamples, JUDGE_SCHEMA, JUDGE_SYSTEM };
