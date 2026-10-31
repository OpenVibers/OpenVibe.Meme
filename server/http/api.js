'use strict';

/**
 * /api/v1 — OpenVibe.Meme's JSON API.
 *
 *   GET    /entries?limit=&cursor=&kind=&status=  public entries, newest first, cursor-paged
 *   GET    /entries/:slug                         one entry with citations and the use timeline
 *   GET    /entries/:slug/series?days=30          uses per UTC day, zero-filled
 *   GET    /trending                              rising first
 *   GET    /week                                  this ISO week's candidates and vote counts
 *   POST   /week/vote                             one vote a week (signed in, same-origin)
 *   GET    /templates                             caption templates
 *   POST   /captions                              save a caption (signed in; text only)
 *   GET    /captions/:id                          one saved caption
 *   POST   /entries/:slug/report                  a takedown/correction report (signed in)
 *   GET    /reports                               open reports (staff)
 *   POST   /entries/:slug/publish|hide            staff
 *   PATCH  /entries/:slug                         staff: title, kind, status
 *
 * Errors are application/problem+json with a `code`. A person is the meme_at session cookie or a Network user
 * token as a Bearer; a session write must come from openvibe.meme itself (403 meme.cross_site).
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const { isStaff } = require('../identity/staff');
const { currentWeek } = require('../week');
const { KINDS, STATUSES, SCOPES, LABELS } = require('../store');

function createApi(ctx) {
    const { config, s, principal, entries } = ctx;
    const r = asyncRouter();

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // Per-actor limits, on top of the per-address limit in server/app.js: a signed-in person gets the minute and
    // hour budget from config, and an app or anonymous caller is left to the address limiter. A second process
    // has its own counters; VALKEY_URL would make them shared (the readiness check says so).
    const buckets = new Map();
    function windowCount(key, windowMs, limit) {
        const now = Date.now();
        let b = buckets.get(key);
        if (!b || now - b.start >= windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
        b.n += 1;
        return b.n <= limit;
    }
    r.use((req, res, next) => {
        if (req.principal && req.principal.kind === 'user' && req.principal.subject) {
            const who = `user:${req.principal.subject}`;
            const okMinute = windowCount(`${who}:m`, 60_000, config.limits.minute);
            const okHour = windowCount(`${who}:h`, 60 * 60_000, config.limits.hour);
            if (!okMinute || !okHour) return problem(res, 429, 'meme.rate_limited', 'too many requests from this account; retry shortly');
            if (buckets.size > 20_000) {
                for (const [k, b] of buckets) if (Date.now() - b.start > 2 * 60 * 60_000) buckets.delete(k);
            }
        }
        return next();
    });

    const problem = (res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: res.req && res.req.ov });
    const invalid = (res, detail) => problem(res, 400, 'meme.invalid', detail);

    function person(req, res) {
        const p = req.principal;
        if (p.kind === 'anonymous') { problem(res, 401, 'meme.sign_in_required', 'Sign in at openvibe.meme, or send a person\'s Network token as a Bearer.'); return null; }
        if (p.kind !== 'user') { problem(res, 403, 'meme.person_required', 'This route is for a person, not an app.'); return null; }
        if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config.baseUrl)) {
            problem(res, 403, 'meme.cross_site', 'A signed-in request that changes something must come from openvibe.meme itself.');
            return null;
        }
        return p;
    }
    const requirePerson = (req, res, next) => (person(req, res) ? next() : undefined);
    const requireStaff = (req, res, next) => {
        if (!person(req, res)) return undefined;
        if (!isStaff(req.principal)) return problem(res, 403, 'meme.staff_required', 'This route is for OpenVibe staff (Network role global_mod or above).');
        return next();
    };

    const asInt = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);

    r.get('/ping', (_req, res) => res.json({ ok: true, service: config.service }));

    // ── Public reads ────────────────────────────────────────
    // GET /entries?scope=&q=&status=&label=&kind=&sort=newest|top&window=day|week|month|all&channel=
    // `scope=openvibe` is Live's "Memes" page: `sort=top&window=week&channel=<stream_id>` gives the top this week,
    // `sort=newest` the newest; `label` and `q` search the encyclopedia.
    r.get('/entries', async (req, res) => {
        const limit = req.query.limit == null || req.query.limit === '' ? 20 : Number.parseInt(req.query.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) return invalid(res, 'limit must be from 1 to 50');
        const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
        if (kind && !KINDS.includes(kind)) return invalid(res, `kind must be one of ${KINDS.join(', ')}`);
        const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
        if (status && !STATUSES.includes(status)) return invalid(res, `status must be one of ${STATUSES.join(', ')}`);
        const scope = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : null;
        if (scope && !SCOPES.includes(scope)) return invalid(res, `scope must be one of ${SCOPES.join(', ')}`);
        const label = typeof req.query.label === 'string' && req.query.label ? req.query.label.toLowerCase() : null;
        if (label && !LABELS.includes(label)) return invalid(res, `label must be one of ${LABELS.join(', ')}`);
        const sort = req.query.sort == null || req.query.sort === '' ? 'newest' : String(req.query.sort);
        if (sort !== 'newest' && sort !== 'top') return invalid(res, 'sort must be newest or top');
        const window = req.query.window == null || req.query.window === '' ? null : String(req.query.window);
        if (window && !['day', 'week', 'month', 'all'].includes(window)) return invalid(res, 'window must be day, week, month or all');
        const channel = req.query.channel == null || req.query.channel === '' ? null : req.query.channel;
        const checkout = await entries.list({
            limit, kind, status, scope, label, sort, window,
            q: typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null,
            channel,
            cursor: typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null,
        });
        if (checkout.error === 'cursor') return invalid(res, 'cursor is not a cursor this API handed out');
        if (checkout.error === 'scope') return invalid(res, `scope must be one of ${SCOPES.join(', ')}`);
        if (checkout.error === 'label') return invalid(res, `label must be one of ${LABELS.join(', ')}`);
        if (checkout.error === 'sort') return invalid(res, 'sort must be newest or top');
        if (checkout.error === 'window') return invalid(res, 'window must be day, week, month or all');
        if (checkout.error === 'channel') return invalid(res, 'channel must be a stream id');
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ count: checkout.entries.length, entries: checkout.entries, next_cursor: checkout.next_cursor });
    });

    r.get('/entries/:slug/series', async (req, res) => {
        const row = await entries.bySlug(String(req.params.slug || ''));
        if (!row || (row.visibility === 'hidden' && !isStaff(req.principal))) return problem(res, 404, 'meme.not_found', 'No such meme.');
        const days = req.query.days == null || req.query.days === '' ? 30 : Number.parseInt(req.query.days, 10);
        if (!Number.isFinite(days) || days < 1 || days > 365) return invalid(res, 'days must be a whole number from 1 to 365');
        const out = await entries.series(row.id, { days });
        res.set('Cache-Control', row.visibility === 'public' ? 'public, max-age=60' : 'private, max-age=60');
        return res.json({ slug: row.slug, ...out });
    });

    // GET /entries/:slug — the origin, citations, spread, variations, Media examples, related memes and the
    // approved revision history. A pending proposal is visible to its author and staff only.
    r.get('/entries/:slug', async (req, res) => {
        const row = await entries.bySlug(String(req.params.slug || ''));
        const staff = isStaff(req.principal);
        const mine = Boolean(row && row.submitted_by && req.principal.kind === 'user' && req.principal.subject === row.submitted_by);
        if (!row || (row.visibility === 'hidden' && !staff && !mine)) return problem(res, 404, 'meme.not_found', 'No such meme.');
        const out = await entries.detail(row, { staff });
        if (row.visibility === 'public') res.set('Cache-Control', 'public, max-age=60');
        else if (row.visibility === 'unlisted') res.set('Cache-Control', 'private, max-age=60');
        else res.set('Cache-Control', 'private, no-store');
        return res.json(out);
    });

    // GET /entries/:slug/revisions — approved history for anyone; pending/rejected too for staff.
    r.get('/entries/:slug/revisions', async (req, res) => {
        const row = await entries.bySlug(String(req.params.slug || ''));
        const staff = isStaff(req.principal);
        if (!row || (row.visibility === 'hidden' && !staff)) return problem(res, 404, 'meme.not_found', 'No such meme.');
        const revisions = await entries.revisionsOf(row.id, { staff });
        if (row.visibility === 'public') res.set('Cache-Control', 'public, max-age=60');
        else res.set('Cache-Control', 'private, no-store');
        return res.json({ slug: row.slug, count: revisions.length, revisions });
    });

    r.get('/trending', async (req, res) => {
        const limit = req.query.limit == null || req.query.limit === '' ? 20 : Number.parseInt(req.query.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) return invalid(res, 'limit must be from 1 to 50');
        const rows = await entries.trending({ limit });
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ count: rows.length, entries: rows });
    });

    r.get('/week', async (req, res) => {
        const { week } = currentWeek(s.now());
        const subject = req.principal.kind === 'user' ? req.principal.subject : null;
        const out = await entries.week({ week, subject });
        res.set('Cache-Control', subject ? 'private, no-store' : 'public, max-age=60');
        return res.json(out);
    });

    r.get('/templates', async (_req, res) => {
        const list = await entries.templates();
        const counted = await Promise.all(list.map(async (t) => ({ ...t, captions: await entries.captionCountForTemplate(t.id) })));
        res.set('Cache-Control', 'public, max-age=300');
        return res.json({ count: counted.length, templates: counted });
    });

    r.get('/captions/:id', async (req, res) => {
        const row = await entries.captionById(String(req.params.id || ''));
        if (!row) return problem(res, 404, 'meme.not_found', 'No such caption.');
        const mine = req.principal.kind === 'user' && req.principal.subject === row.subject;
        if (row.visibility === 'hidden' && !mine && !isStaff(req.principal)) return problem(res, 404, 'meme.not_found', 'No such caption.');
        const template = await entries.templateById(row.template_id);
        const staff = isStaff(req.principal);
        // A response that names the owner (or is the owner's own) must never sit in a shared cache.
        res.set('Cache-Control', row.visibility === 'public' && !mine && !staff ? 'public, max-age=60' : 'private, no-store');
        const out = { ...row, template, mine };
        if (!mine && !staff) delete out.subject;
        return res.json(out);
    });

    // ── Signed-in writes ────────────────────────────────────
    r.post('/week/vote', requirePerson, async (req, res) => {
        const entryId = req.body && typeof req.body.entry_id === 'string' ? req.body.entry_id.trim() : '';
        if (!entryId || entryId.length > 40) return invalid(res, 'entry_id is required');
        const { week } = currentWeek(s.now());
        const out = await entries.castVote({ subject: req.principal.subject, entryId, week });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'invalid vote');
        return res.json({ week, ...out });
    });

    r.post('/captions', requirePerson, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const out = await entries.createCaption({
            subject: req.principal.subject,
            templateId: b.template_id,
            lines: b.lines,
            visibility: b.visibility == null ? 'public' : String(b.visibility),
        });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'invalid caption');
        res.set('Location', `/api/v1/captions/${out.caption.id}`);
        return res.status(201).json(out.caption);
    });

    r.post('/entries/:slug/report', requirePerson, async (req, res) => {
        const row = await entries.bySlug(String(req.params.slug || ''));
        if (!row || row.visibility !== 'public') return problem(res, 404, 'meme.not_found', 'No such public meme.');
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const kind = b.kind === 'takedown' || b.kind === 'correction' ? b.kind : null;
        if (!kind) return invalid(res, 'kind must be takedown or correction');
        const reason = String(b.reason == null ? '' : b.reason).replace(/\s+/g, ' ').trim();
        if (reason.length < 3 || reason.length > 2000) return invalid(res, 'reason must be 3 to 2000 characters');
        const note = b.note == null || b.note === '' ? null : String(b.note).trim().slice(0, 4000);
        const out = await entries.createReport({ entryId: row.id, subject: req.principal.subject, kind, reason, note });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'invalid report');
        res.set('Location', `/api/v1/reports`);
        return res.status(201).json({ id: out.report.id, status: out.report.status, created_at: out.report.created_at });
    });

    // ── The encyclopedia: proposals and wiki-style revisions ──
    // POST /entries — a signed-in person proposes an entry (born hidden, revision 1 pending). Staff proposals are
    // approved and public at once. The body is the entry plus origin, spread, variations, examples and related.
    r.post('/entries', requirePerson, async (req, res) => {
        const out = await entries.createProposal({
            body: req.body || {},
            author: req.principal.subject,
            staff: isStaff(req.principal),
        });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'invalid entry', out.field);
        res.set('Location', `/api/v1/entries/${out.entry.slug}`);
        return res.status(out.entry.visibility === 'public' ? 201 : 202).json({
            entry: out.entry, revision: out.revision, review: out.revision ? out.revision.moderation_state : null,
        });
    });

    // POST /entries/:slug/revisions — a proposed edit. A person's waits for review; staff's applies at once.
    r.post('/entries/:slug/revisions', requirePerson, async (req, res) => {
        const out = await entries.addRevision(String(req.params.slug || ''), {
            body: req.body || {},
            author: req.principal.subject,
            staff: isStaff(req.principal),
        });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'invalid revision', out.field);
        res.set('Location', `/api/v1/entries/${out.entry.slug}/revisions`);
        return res.status(out.revision && out.revision.moderation_state === 'approved' ? 201 : 202).json({
            entry: out.entry, revision: out.revision,
        });
    });

    r.post('/entries/:slug/revisions/:revision/review', requireStaff, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const out = await entries.reviewRevision(String(req.params.slug || ''), req.params.revision, {
            state: b.state,
            reviewedBy: req.principal.subject,
            note: b.note == null || b.note === '' ? null : String(b.note).trim().slice(0, 1000),
        });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'invalid review');
        return res.json(out);
    });

    r.get('/moderation/revisions', requireStaff, async (req, res) => {
        const revisions = await entries.pendingRevisions({ limit: asInt(req.query.limit, 50) });
        return res.json({ count: revisions.length, revisions });
    });

    // ── Staff ───────────────────────────────────────────────
    r.post('/entries/:slug/publish', requireStaff, async (req, res) => {
        const out = await entries.publish(String(req.params.slug || ''), { changedBy: req.principal.subject });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'cannot publish');
        return res.json(out.entry);
    });

    r.post('/entries/:slug/hide', requireStaff, async (req, res) => {
        const out = await entries.hide(String(req.params.slug || ''), { changedBy: req.principal.subject });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'cannot hide');
        return res.json(out.entry);
    });

    r.patch('/entries/:slug', requireStaff, async (req, res) => {
        const out = await entries.patch(String(req.params.slug || ''), { body: req.body || {}, changedBy: req.principal.subject });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'invalid change');
        return res.json(out.entry);
    });

    r.get('/reports', requireStaff, async (req, res) => {
        const reports = await entries.listOpenReports({ limit: asInt(req.query.limit, 100) });
        return res.json({ count: reports.length, reports });
    });

    return r;
}

module.exports = { createApi };
