'use strict';

/**
 * /api/v1 — OpenVibe.Meme's JSON API.
 *
 *   GET    /entries?limit=&cursor=&kind=&status=  public entries, newest first, cursor-paged
 *   GET    /memes?scope=internet&q=&sort=top       internet meme library, defaults to internet scope
 *   GET    /memes/:slug                           one public internet meme with citations and timeline
 *   GET    /entries/:slug/series?days=30          uses per UTC day, zero-filled
 *   GET    /trending                              rising first
 *   GET    /week                                  this ISO week's candidates and vote counts
 *   POST   /week/vote                             one vote a week (signed in, same-origin)
 *   GET    /templates                             caption templates
 *   POST   /caption-ideas                         cheap OpenVibe.AI caption suggestions (signed out, rate-limited)
 *   POST   /templates/uploads                     submit a member template to Media for review
 *   GET    /staff/templates/uploads               list pending member template uploads (staff)
 *   POST   /staff/templates/:id/review            approve or reject a pending member template (staff)
 *   POST   /render                                render a caption as PNG, GIF, or MP4 without an AI call
 *   POST   /captions                              save text and editor state (signed in)
 *   GET    /captions/:id                          one saved caption
 *   GET    /captions/:id/render                   render a saved caption as PNG, GIF, or MP4
 *   POST   /entries/:slug/report                  a takedown/correction report (signed in)
 *   GET    /reports                               open reports (staff)
 *   GET    /staff/candidates                      the hidden candidates with the judge's score (staff)
 *   GET    /staff/candidates/:slug                one candidate: its judgement, citations and decisions (staff)
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
const { KINDS, STATUSES, SCOPES, LABELS, captionLines } = require('../store');
const { renderMeme, fallbackLayout } = require('../render-png');
const { renderStillVideo } = require('../render/video');
const sharp = require('sharp');

function renderOptions(template, editor) {
    if (!editor || typeof editor !== 'object') return { ok: true, layout: null, stickers: [], crop: null };
    const hex = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
    const size = Math.min(64, Math.max(10, Number(editor.font_size) || 30));
    const outlineWidth = Math.min(8, Math.max(0, Number(editor.outline_width) || 0));
    const style = ['impact', 'modern', 'soft'].includes(editor.font_style) ? editor.font_style : 'impact';
    const permitted = new Set(['✨', '😂', '🔥', '💀', '👀', '❤️', '🙌']);
    const stickers = Array.isArray(editor.stickers) ? editor.stickers.slice(0, 8).filter((x) => x && permitted.has(x.emoji) && Number.isFinite(Number(x.x)) && Number.isFinite(Number(x.y)) && Number(x.x) >= 0 && Number(x.x) <= 100 && Number(x.y) >= 0 && Number(x.y) <= 100).map((x) => ({ emoji: x.emoji, x: Number(x.x), y: Number(x.y), size: 34 })) : [];
    let crop = null;
    if (editor.crop_x != null || editor.crop_y != null) {
        crop = { x: editor.crop_x == null ? 50 : Number(editor.crop_x), y: editor.crop_y == null ? 50 : Number(editor.crop_y) };
        if (!Number.isFinite(crop.x) || crop.x < 0 || crop.x > 100 || !Number.isFinite(crop.y) || crop.y < 0 || crop.y > 100) return { ok: false, message: 'crop position must be from 0 to 100' };
    }
    const inputBoxes = Array.isArray(editor.boxes) ? editor.boxes : [];
    // Style, stickers and crop alone are a valid edit of the template's own layout.
    if (!inputBoxes.length) return { ok: true, layout: null, stickers, crop };
    if (inputBoxes.length > 4) return { ok: false, message: 'editor layout is invalid for this template' };
    const base = template.layout && typeof template.layout === 'object' && Array.isArray(template.layout.boxes) && template.layout.boxes.length
        ? template.layout : fallbackLayout(template.box_count);
    const width = Number(base.width) || 440, height = Number(base.height) || 280;
    const boxes = inputBoxes.map((box, index) => {
        const p = ['x', 'y', 'w', 'h'].map((key) => Number(box && box[key]));
        if (p.some((n) => !Number.isFinite(n)) || p[0] < 0 || p[1] < 0 || p[2] < 12 || p[3] < 8 || p[0] + p[2] > 100 || p[1] + p[3] > 100) return null;
        return { ...(base.boxes[index] || base.boxes[base.boxes.length - 1]), x: p[0] / 100 * width, y: p[1] / 100 * height, w: p[2] / 100 * width, h: p[3] / 100 * height,
            font: 'DejaVuSans-Bold', size, color: hex(editor.color, '#ffffff'), outline: hex(editor.outline, '#000000'), outline_width: outlineWidth,
            uppercase: style === 'impact', align: 'center', valign: 'middle', wrap: true };
    });
    if (boxes.some((box) => !box)) return { ok: false, message: 'editor text boxes must stay within the canvas' };
    return { ok: true, layout: { width, height, boxes }, stickers, crop };
}

function createApi(ctx) {
    const { config, s, principal, entries, trends, analyzer, research, generator, generateAi, media } = ctx;
    const r = asyncRouter();
    // Each person's daily share of the AI features (analyze, research, generate), on top of each one's budget for all.
    const personCap = require('../person-cap').createPersonCap({ config, s });

    r.use(express.json({ limit: '9mb' }));
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

    /** A merged slug or id answers 301 to the kept entry; null when there is no entry and no redirect. */
    async function bySlugOrRedirect(value, req, res, { suffix = '' } = {}) {
        const row = await entries.bySlug(value);
        if (row) return row;
        const redirect = await entries.redirectFor(value);
        if (!redirect) return null;
        const target = await entries.byId(redirect.to_entry_id);
        if (!target || (target.visibility === 'hidden' && !isStaff(req.principal))) return null;
        res.redirect(301, `/api/v1/entries/${encodeURIComponent(target.slug)}${suffix}`);
        return undefined;
    }

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
    r.get(['/entries', '/memes'], async (req, res) => {
        const limit = req.query.limit == null || req.query.limit === '' ? 20 : Number.parseInt(req.query.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) return invalid(res, 'limit must be from 1 to 50');
        const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
        if (kind && !KINDS.includes(kind)) return invalid(res, `kind must be one of ${KINDS.join(', ')}`);
        const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
        if (status && !STATUSES.includes(status)) return invalid(res, `status must be one of ${STATUSES.join(', ')}`);
        const scope = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : (req.path === '/memes' ? 'internet' : null);
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

    r.get(['/entries/:slug/series', '/memes/:slug/series'], async (req, res) => {
        const row = await bySlugOrRedirect(String(req.params.slug || ''), req, res, { suffix: '/series' });
        if (row === undefined) return;
        if (req.path.startsWith('/memes/') && row && row.scope !== 'internet') return problem(res, 404, 'meme.not_found', 'No such internet meme.');
        if (!row || (row.visibility === 'hidden' && !isStaff(req.principal))) return problem(res, 404, 'meme.not_found', 'No such meme.');
        const days = req.query.days == null || req.query.days === '' ? 30 : Number.parseInt(req.query.days, 10);
        if (!Number.isFinite(days) || days < 1 || days > 365) return invalid(res, 'days must be a whole number from 1 to 365');
        const out = await entries.series(row.id, { days });
        res.set('Cache-Control', row.visibility === 'public' ? 'public, max-age=60' : 'private, max-age=60');
        return res.json({ slug: row.slug, ...out });
    });

    // GET /entries/:slug — the origin, citations, spread, variations, Media examples, related memes and the
    // approved revision history. A pending proposal is visible to its author and staff only.
    r.get(['/entries/:slug', '/memes/:slug'], async (req, res) => {
        const row = await bySlugOrRedirect(String(req.params.slug || ''), req, res);
        if (row === undefined) return;
        if (req.path.startsWith('/memes/') && row && row.scope !== 'internet') return problem(res, 404, 'meme.not_found', 'No such internet meme.');
        const staff = isStaff(req.principal);
        const mine = Boolean(row && row.submitted_by && req.principal.kind === 'user' && req.principal.subject === row.submitted_by);
        if (!row || (row.visibility === 'hidden' && !staff && !mine)) return problem(res, 404, 'meme.not_found', 'No such meme.');
        const out = await entries.detail(row, { staff: staff || mine });
        const verdict = await entries.judgement(row.id);
        if (row.visibility === 'public') res.set('Cache-Control', 'public, max-age=60');
        else if (row.visibility === 'unlisted') res.set('Cache-Control', 'private, max-age=60');
        else res.set('Cache-Control', 'private, no-store');
        return res.json({
            ...out,
            // The judge's own words about the entry: where it started and how people use it.
            ...(verdict && verdict.origin ? { notes: { origin: verdict.origin, spread: verdict.spread, examples: verdict.examples } } : {}),
            ...(staff && verdict ? { judgement: { score: verdict.score, reason: verdict.reason, judged_at: verdict.judged_at, model: verdict.model, provider: verdict.provider } } : {}),
        });
    });

    // GET /entries/:slug/revisions — approved history for anyone; pending/rejected too for staff.
    r.get('/entries/:slug/revisions', async (req, res) => {
        const row = await bySlugOrRedirect(String(req.params.slug || ''), req, res, { suffix: '/revisions' });
        if (row === undefined) return;
        const staff = isStaff(req.principal);
        const mine = Boolean(row && row.submitted_by && req.principal.kind === 'user' && req.principal.subject === row.submitted_by);
        if (!row || (row.visibility === 'hidden' && !staff && !mine)) return problem(res, 404, 'meme.not_found', 'No such meme.');
        const revisions = await entries.revisionsOf(row.id, { staff: staff || mine });
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

    // GET /trends?window=day|week — rising Reddit posts (official API data) with upvote velocity, the templates
    // their pictures reveal, and the public entries used in the same window.
    r.get('/trends', async (req, res) => {
        const window = req.query.window == null || req.query.window === '' ? 'day' : String(req.query.window);
        if (!['day', 'week'].includes(window)) return invalid(res, 'window must be day or week');
        const limit = req.query.limit == null || req.query.limit === '' ? 50 : Number.parseInt(req.query.limit, 10);
        if (!Number.isFinite(limit) || limit < 1 || limit > 100) return invalid(res, 'limit must be from 1 to 100');
        const out = await trends.read({ window, limit });
        res.set('Cache-Control', 'public, max-age=120');
        return res.json(out);
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

    r.post('/caption-ideas', async (req, res) => {
        const ip = String(req.ip || 'unknown').slice(0, 80);
        if (!windowCount(`caption-ideas-day:${ip}`, 86_400_000, 60)) return problem(res, 429, 'meme.rate_limited', 'The daily caption-idea limit is used up; try again tomorrow.');
        if (!windowCount(`caption-ideas:${ip}`, 60_000, 8)) return problem(res, 429, 'meme.rate_limited', 'Too many caption requests. Try again in a minute.');
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const template = typeof b.template_id === 'string' ? await entries.templateById(b.template_id) : null;
        const format = String((template && template.name) || b.format || '').trim().slice(0, 120);
        const topic = String(b.topic || '').trim().slice(0, 300);
        if (!format || !topic) return invalid(res, 'choose a template and enter a topic or situation');
        if (!generateAi || !generateAi.run) return problem(res, 503, 'meme.ai_unavailable', 'OpenVibe.AI caption ideas are not configured.');
        const result = await generateAi.run('meme.caption', { format, topic }, { calls: 1 });
        if (!result.ok) return problem(res, result.status || 502, result.code || 'meme.ai_failed', result.message || 'Caption ideas are unavailable.');
        const raw = result.output && (result.output.ideas || result.output.output && result.output.output.ideas);
        const ideas = (Array.isArray(raw) ? raw : []).slice(0, 5).map((idea) => String(idea || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, 4)).filter((idea) => idea.length && captionLines(idea).ok);
        if (!ideas.length) return problem(res, 502, 'meme.ai_bad_answer', 'OpenVibe.AI returned no usable captions.');
        res.set('Cache-Control', 'private, no-store');
        return res.json({ ideas, cost_usd: Number(result.costUsd) || 0, objective: 'cheapest' });
    });

    r.post('/templates/uploads', requirePerson, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const match = typeof b.image === 'string' && b.image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!match) return invalid(res, 'image must be a PNG, JPEG, or WebP data URL');
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.length > 6 * 1024 * 1024 || bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) return invalid(res, 'image must be at most 6 MB');
        let meta;
        try { meta = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata(); } catch { return invalid(res, 'image file could not be decoded'); }
        if (meta.format !== match[1].slice(6) || !meta.width || !meta.height || meta.width < 128 || meta.height < 96) return invalid(res, 'image must be at least 128 by 96 pixels and match its file type');
        if (!media || !media.upload) return problem(res, 503, 'meme.media_unavailable', 'OpenVibe.Media uploads are not configured.');
        const uploaded = await media.upload(bytes, { mimeType: match[1], filename: 'member-meme-template', metadata: { purpose: 'meme-template-review' } });
        if (!uploaded || !uploaded.media_id) return problem(res, 503, 'meme.media_unavailable', 'The image could not be stored in OpenVibe.Media.');
        const out = await entries.submitTemplateUpload({ id: `tpl_upload_${s.newId('mcp').slice(-26)}`, name: typeof b.name === 'string' ? b.name : 'Member template', media_id: uploaded.media_id, media_url: uploaded.url, subject: req.principal.subject });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'Upload could not be submitted.');
        return res.status(202).json({ template: out.template, review_status: 'pending', message: 'Your template is in the moderation queue.' });
    });

    r.get('/staff/templates/uploads', requirePerson, async (req, res) => {
        if (!isStaff(req.principal)) return problem(res, 403, 'meme.forbidden', 'Staff access is required.');
        return res.json({ templates: await entries.pendingTemplateUploads() });
    });
    r.post('/staff/templates/:id/review', requirePerson, async (req, res) => {
        if (!isStaff(req.principal)) return problem(res, 403, 'meme.forbidden', 'Staff access is required.');
        const decision = req.body && req.body.decision;
        const out = await entries.reviewTemplateUpload(String(req.params.id || ''), decision);
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'Template could not be reviewed.');
        return res.json(out);
    });

    // Render user-supplied lines as PNG, GIF, or MP4 with the same licensed template and bundled fonts as the maker.
    // This path is deterministic and does not spend the AI research/generation budget.
    r.post('/render', requirePerson, async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const format = ['png', 'gif', 'mp4'].includes(body.format) ? body.format : 'png';
        const checked = captionLines(body.lines);
        if (!checked.ok) return problem(res, checked.status || 400, checked.code || 'meme.invalid', checked.message || 'Invalid caption lines.');
        const templateId = typeof body.template_id === 'string' ? body.template_id.trim() : '';
        if (!templateId || templateId.length > 80) return invalid(res, 'template_id is required and must be at most 80 characters');
        const template = await entries.templateById(templateId);
        if (!template) return problem(res, 404, 'meme.template_not_found', 'No such template.');
        try {
            const opts = renderOptions(template, body.editor);
            if (!opts.ok) return invalid(res, opts.message);
            const rendered = await renderMeme({ template, lines: checked.lines, ...opts, maxPixels: 1600 });
            const bytes = format === 'png' ? rendered.png : await renderStillVideo(rendered.png, format);
            const type = format === 'png' ? 'image/png' : format === 'gif' ? 'image/gif' : 'video/mp4';
            res.set({ 'Cache-Control': 'private, no-store', 'X-Image-Width': String(rendered.width), 'X-Image-Height': String(rendered.height) });
            return res.type(type).send(bytes);
        } catch (err) {
            return problem(res, 422, 'meme.render_failed', 'This template could not be rendered right now.');
        }
    });

    r.get('/captions/:id/render', async (req, res) => {
        const row = await entries.captionById(String(req.params.id || ''));
        if (!row) return problem(res, 404, 'meme.not_found', 'No such caption.');
        const mine = req.principal.kind === 'user' && req.principal.subject === row.subject;
        if (row.visibility !== 'public' && !mine && !isStaff(req.principal)) return problem(res, 404, 'meme.not_found', 'No such caption.');
        const format = ['png', 'gif', 'mp4'].includes(req.query.format) ? req.query.format : 'png';
        const template = await entries.templateById(row.template_id);
        if (!template) return problem(res, 404, 'meme.template_not_found', 'No such template.');
        try {
            const opts = renderOptions(template, row.editor);
            if (!opts.ok) return problem(res, 422, 'meme.render_failed', 'This caption has invalid editor settings.');
            const rendered = await renderMeme({ template, lines: row.lines, ...opts, maxPixels: 1600 });
            const bytes = format === 'png' ? rendered.png : await renderStillVideo(rendered.png, format);
            res.set('Cache-Control', row.visibility === 'public' ? 'public, max-age=60' : 'private, no-store');
            return res.type(format === 'png' ? 'image/png' : format === 'gif' ? 'image/gif' : 'video/mp4').send(bytes);
        } catch { return problem(res, 422, 'meme.render_failed', 'This caption could not be rendered right now.'); }
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

    // ── Analyse ─────────────────────────────────────────────
    // POST /analyze { url | media_id } — the vision call, the structured extraction, the matched entries/template,
    // origin guesses with confidence, meaning/usage, L1 labels, and a Reddit URL's spread and comments tone.
    // A person only: every analysis spends OpenVibe.AI calls, so a signed-out caller could spend the day's budget.
    r.post('/analyze', requirePerson, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const who = { subject: req.principal.subject, kind: 'analyze', staff: isStaff(req.principal) };
        const share = await personCap.check(who);
        if (!share.ok) return problem(res, share.status, share.code, share.message);
        const out = await analyzer.analyze({
            url: typeof b.url === 'string' ? b.url : null,
            mediaId: typeof b.media_id === 'string' ? b.media_id : null,
            subject: req.principal.subject,
        });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'that meme could not be analysed');
        await personCap.add(who);
        res.set('Cache-Control', 'private, no-store');
        return res.json(out.analysis);
    });

    // ── Deep dives (M5) ─────────────────────────────────────
    // POST /research { topic } — start the job; 202 with the id, then GET /research/:id until succeeded or failed.
    r.post('/research', requirePerson, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const who = { subject: req.principal.subject, kind: 'research', staff: isStaff(req.principal) };
        const share = await personCap.check(who);
        if (!share.ok) return problem(res, share.status, share.code, share.message);
        const out = await research.create({ topic: b.topic, subject: req.principal.subject });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'invalid research');
        await personCap.add(who);
        res.set('Location', `/api/v1/research/${out.research.id}`);
        return res.status(202).json(out.research);
    });

    // A succeeded read is public; a queued/running/failed one is visible to its author and staff only.
    r.get('/research/:id', async (req, res) => {
        const row = await research.get(String(req.params.id || ''));
        if (!row) return problem(res, 404, 'meme.not_found', 'No such research job.');
        const mine = req.principal.kind === 'user' && row.subject === req.principal.subject;
        if (row.status !== 'succeeded' && !mine && !isStaff(req.principal)) return problem(res, 404, 'meme.not_found', 'No such research job.');
        res.set('Cache-Control', row.status === 'succeeded' ? 'public, max-age=60' : 'private, no-store');
        const out = { ...row };
        if (!mine && !isStaff(req.principal)) delete out.subject;
        return res.json(out);
    });

    // Save a succeeded read as a public deep-dive entry (its full text stays in meme_deep_dives).
    r.post('/research/:id/entry', requirePerson, async (req, res) => {
        const row = await research.get(String(req.params.id || ''));
        if (!row) return problem(res, 404, 'meme.not_found', 'No such research job.');
        if (row.subject !== req.principal.subject && !isStaff(req.principal)) return problem(res, 403, 'meme.forbidden', 'This research job belongs to someone else.');
        const out = await research.save({ id: row.id, subject: req.principal.subject, staff: isStaff(req.principal) });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'the read could not be saved');
        res.set('Location', `/api/v1/entries/${out.entry.slug}`);
        return res.status(out.already ? 200 : 201).json({ entry: out.entry, already: Boolean(out.already) });
    });

    // The full text of a saved deep dive, for the entry page.
    r.get('/entries/:slug/deep-dive', async (req, res) => {
        const entry = await bySlugOrRedirect(String(req.params.slug || ''), req, res, { suffix: '/deep-dive' });
        if (entry === undefined) return;
        if (!entry || entry.visibility !== 'public') return problem(res, 404, 'meme.not_found', 'No such deep dive.');
        const dive = await research.deepDiveFor(entry.id);
        if (!dive) return problem(res, 404, 'meme.not_found', 'No deep dive for that entry.');
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ slug: entry.slug, title: entry.title, ...dive });    });

    // ── Generate (M6) ───────────────────────────────────────
    // POST /generate { template_slug | topic, lines? } — research current uses, write the captions, render the
    // template's own PNG with bundled fonts, store it in Media and save the caption with its labels.
    r.post('/generate', requirePerson, async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const who = { subject: req.principal.subject, kind: 'generate', staff: isStaff(req.principal) };
        const share = await personCap.check(who);
        if (!share.ok) return problem(res, share.status, share.code, share.message);
        const out = await generator.generate({
            templateSlug: typeof b.template_slug === 'string' ? b.template_slug : null,
            topic: typeof b.topic === 'string' ? b.topic : null,
            lines: b.lines === undefined ? null : b.lines,
            subject: req.principal.subject,
        });
        if (!out.ok) return problem(res, out.status || 400, out.code || 'meme.invalid', out.message || 'the meme could not be generated');
        await personCap.add(who);
        res.set('Location', `/api/v1/captions/${out.caption.id}`);
        return res.status(201).json({ media_id: out.media_id, media_url: out.media_url, captions: out.captions, template: out.template, labels: out.labels, caption: out.caption, cost_usd: out.cost_usd });
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
        const editor = b.editor && typeof b.editor === 'object' && !Array.isArray(b.editor) ? b.editor : {};
        if (Buffer.byteLength(JSON.stringify(editor)) > 8192) return invalid(res, 'editor state is too large');
        const out = await entries.createCaption({
            subject: req.principal.subject,
            templateId: b.template_id,
            lines: b.lines,
            visibility: b.visibility == null ? 'public' : String(b.visibility),
            editor,
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

    // ── The staff list: the candidates that stayed hidden ──
    r.get('/staff/candidates', requireStaff, async (req, res) => {
        const limit = asInt(req.query.limit, 100);
        const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
        if (kind && !KINDS.includes(kind)) return invalid(res, `kind must be one of ${KINDS.join(', ')}`);
        const list = await entries.listHidden({ limit, kind });
        return res.json({ count: list.length, candidates: list });
    });

    r.get('/staff/candidates/:slug', requireStaff, async (req, res) => {
        const row = await entries.bySlug(String(req.params.slug || ''));
        if (!row) return problem(res, 404, 'meme.not_found', 'No such meme.');
        const [citations, verdict, history] = await Promise.all([
            entries.citations(row.id),
            entries.judgement(row.id),
            entries.decisions(row.id),
        ]);
        return res.json({
            ...entries.wireEntry(row),
            score: verdict ? verdict.score : null,
            reason: verdict ? verdict.reason : null,
            judgement: verdict,
            citations,
            decisions: history,
        });
    });

    return r;
}

module.exports = { createApi };
