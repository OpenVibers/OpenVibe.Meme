'use strict';

/**
 * The judge's job. It takes the candidates the importer left hidden, asks OpenVibe.AI to judge each one from its
 * own citations, stores the score and the written entry, and then applies the publish rule: what clears the bar is
 * published, everything else stays hidden for staff with its score and the reasons it did not clear.
 *
 * Every decision is a status event, so the history of an entry says what the AI decided and why. The job is safe to
 * run twice: a candidate that already has a judgement is only re-judged when it is asked for (a re-judge round), and
 * publishing an entry that is already public changes nothing.
 *
 *   runOnce()                  judge the candidates nobody has judged yet
 *   runOnce({ force: true })   judge every hidden candidate again (the re-judge round)
 *   runOnce({ only: [slug] })  judge these entries and nothing else
 */
const { evaluate } = require('../ai/gate');

function createJudgeJob({ config, s, entries, judge, context, log = console }) {
    const stats = { runs: 0, judged: 0, published: 0, kept: 0, errors: 0, last_run_at: null, last_error: null };
    let timers = [];

    /** The entry's own citations, oldest first: the judge reads them in the order they happened. */
    async function citationsOf(entry) {
        const cites = await entries.citations(entry.id);
        return cites
            .filter((c) => c.source_status === 'live')
            .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
    }

    /**
     * Judge one entry and act on the verdict. Returns { entry, judgement, decision }.
     */
    async function judgeEntry(entry) {
        const citations = await citationsOf(entry);
        const prepared = await context.prepare(citations);
        const verdict = await judge.judge({ id: entry.id, title: entry.title, kind: entry.kind, phrase: entry.title }, prepared);
        const saved = await entries.saveJudgement(entry.id, verdict);
        // The AI's title and summary are the entry's own words; the slug never changes.
        await entries.applyJudgement(entry.id, { title: verdict.title, summary: verdict.summary });
        const fresh = await entries.byId(entry.id);
        const decision = evaluate({
            entry: fresh,
            citations,
            judgement: { ...saved, denied: verdict.denied, looks: verdict.looks },
            gate: config.judge,
        });
        return { entry: fresh, judgement: saved, decision, citations };
    }

    /** Publish an entry that cleared the bar, and say so in the history. */
    async function publishJudged(entry, decision, verdict) {
        const out = await entries.publish(entry.slug, { changedBy: 'service:meme:judge' });
        if (!out.ok) {
            await entries.logDecision({
                entryId: entry.id, decision: 'keep_hidden', fromStatus: entry.status, toStatus: entry.status,
                fromVisibility: 'hidden', toVisibility: 'hidden', score: decision.score,
                reason: `not published: ${out.code || out.message || 'refused'}`,
            });
            return { published: false, out };
        }
        await entries.logDecision({
            entryId: entry.id, decision: 'publish', fromStatus: entry.status, toStatus: out.entry.status,
            fromVisibility: 'hidden', toVisibility: 'public', score: decision.score,
            reason: `the AI scored it ${Number(decision.score).toFixed(2)}: ${verdict.reason || ''}`.slice(0, 500),
        });
        return { published: true, out };
    }

    /** Keep an entry hidden, and say why in the history. */
    async function keepHidden(entry, decision, verdict) {
        await entries.logDecision({
            entryId: entry.id, decision: 'keep_hidden', fromStatus: entry.status, toStatus: entry.status,
            fromVisibility: entry.visibility, toVisibility: 'hidden', score: decision.score,
            reason: `kept hidden: ${decision.reasons.join('; ')}${verdict && verdict.reason ? ` — ${verdict.reason}` : ''}`.slice(0, 500),
        });
        return { published: false };
    }

    async function runOnce({ limit = null, force = false, only = null, publish = true } = {}) {
        const runAt = new Date(s.now()).toISOString();
        if (!judge || !judge.enabled) {
            const message = 'OpenVibe.AI is not configured: nothing was judged.';
            stats.last_error = message;
            log.warn(`[OpenVibe.Meme] judge: ${message}`);
            return { ok: false, judged: 0, published: 0, kept: 0, error: message };
        }
        const max = Math.min(50, Math.max(1, Number(limit) || config.judge.maxPerRun));
        const errors = [];
        let candidates = [];
        if (only && only.length) {
            for (const slug of only) {
                const row = await entries.bySlug(String(slug));
                if (row) candidates.push(row);
            }
        } else if (force) {
            candidates = await entries.listHidden({ limit: max });
        } else {
            candidates = await entries.unjudged({ limit: max });
        }

        let published = 0;
        let kept = 0;
        for (const candidate of candidates) {
            try {
                const { entry, decision, judgement: verdict } = await judgeEntry(candidate);
                if (decision.publish && publish) {
                    const r = await publishJudged(entry, decision, verdict);
                    if (r.published) published++;
                    else kept++;
                } else if (decision.publish) {
                    // A dry run: the judgement is stored, the entry stays where it is.
                    await entries.logDecision({
                        entryId: entry.id, decision: 'judge', fromStatus: entry.status, toStatus: entry.status,
                        fromVisibility: entry.visibility, toVisibility: entry.visibility, score: decision.score,
                        reason: `judged ${Number(decision.score).toFixed(2)}: ${verdict.reason || ''}`.slice(0, 500),
                    });
                    kept++;
                } else {
                    await keepHidden(entry, decision, verdict);
                    kept++;
                }
            } catch (err) {
                errors.push(`${candidate.slug}: ${err.message}`);
                log.warn(`[OpenVibe.Meme] judge ${candidate.slug} failed: ${err.message}`);
            }
        }
        stats.runs++;
        stats.judged += candidates.length - errors.length;
        stats.published += published;
        stats.kept += kept;
        stats.errors += errors.length;
        stats.last_run_at = runAt;
        stats.last_error = errors[0] || null;
        const out = { ok: errors.length === 0, judged: candidates.length - errors.length, published, kept, errors };
        log.log(`[OpenVibe.Meme] judge: ${candidates.length} judged, ${published} published, ${kept} kept hidden${errors.length ? `, ${errors.length} errors` : ''}`);
        return out;
    }

    function start() {
        if (config.drill || timers.length) return false;
        const quiet = () => runOnce().catch((err) => log.warn(`[OpenVibe.Meme] judge tick failed: ${err.message}`));
        const kick = setTimeout(quiet, 45_000);
        const tick = setInterval(quiet, config.judge.intervalMs);
        if (kick.unref) kick.unref();
        if (tick.unref) tick.unref();
        timers = [kick, tick];
        return true;
    }
    function stop() {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
    }

    return { runOnce, start, stop, judgeEntry, stats: () => ({ ...stats, running: timers.length > 0 }) };
}

module.exports = { createJudgeJob };
