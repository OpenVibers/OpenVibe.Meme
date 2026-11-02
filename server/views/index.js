'use strict';

/**
 * The Meme room's pages (plan 2026-10-28 §5.7). Server-rendered and whole without JavaScript: every action is a
 * plain form or link. public/js/meme.js is a one-comment placeholder the main session replaces; the preview and
 * the vote work without it.
 *
 *   home({ trending, week })                       trending, meme of the week, the generator teaser
 *   entry({ e, citations, signedIn, staff })       the origin with its citation link, the use timeline, examples
 *   week({ out, signedIn })                        this week's candidates and the vote form
 *   make({ templates, values, preview, signedIn }) the caption generator form
 *   caption({ caption, template, mine })           one saved caption, text over the image
 *   developers()                                   the API
 *   signIn({ title, text, next })                  a page that needs an account
 *   notFound()
 * Each returns HTML for the page body; server/http/pages.js sends it through the layout. Ids and classes are
 * stable and start with `mm-`.
 */
const { esc, time } = require('../render/html');
const kit = require('openvibe-shared/kit');
const sc = require('openvibe-shared/showcase');

const STATUS_LABEL = { rising: 'Rising', peaked: 'Peaked', classic: 'Classic', dead: 'Dead' };
const KIND_LABEL = { joke: 'Joke', catchphrase: 'Catchphrase', bit: 'Bit', meme: 'Meme', saga: 'Saga' };
const SOURCE_LABEL = { chat_message: 'Chat', vod: 'VOD', clip: 'Clip', rundown_segment: 'The Rundown', ai_paste: 'Community', stream_memory: 'Stream memory' };

const statusBadge = (s) => `<span class="mm-status mm-status-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const kindLabel = (k) => esc(KIND_LABEL[k] || k);

function clock(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return null;
    const s = Math.floor(n);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function citation(c, { role = null } = {}) {
    const label = SOURCE_LABEL[c.source_type] || c.source_type;
    const at = clock(c.offset_seconds);
    const place = c.source_type === 'chat_message' ? `message ${esc(c.source_id)}` : at ? `at ${esc(at)}` : null;
    const state = c.source_status === 'live' ? '' : `<span class="mm-cite-state is-${esc(c.source_status)}">${esc(c.source_status === 'gone' ? 'source gone' : 'source hidden')}</span>`;
    return `<blockquote class="mm-cite mm-cite-${esc(c.role)}"${role ? ` data-role="${esc(role)}"` : ''} cite="${esc(c.url)}">
<p class="mm-quote">${esc(c.quote_text)}</p>
<footer class="mm-cite-foot"><span class="mm-cite-source">${esc(label)}</span>${place ? ` · <span class="mm-cite-place">${place}</span>` : ''} · <time datetime="${esc(c.observed_at)}">${esc(String(c.observed_at || '').slice(0, 10))}</time> · <a class="mm-cite-link" href="${esc(c.url)}" rel="nofollow noopener">the moment</a>${state}</footer>
</blockquote>`;
}

function card(e) {
    return `<li class="mm-entry-card" data-entry="${esc(e.slug)}">
<a class="mm-entry-link" href="/m/${esc(e.slug)}">
<span class="mm-entry-title">${esc(e.title)}</span>
<span class="mm-entry-meta">${kindLabel(e.kind)} · ${statusBadge(e.status)}${e.votes != null ? ` · <strong class="mm-votes">${Number(e.votes)}</strong> ${Number(e.votes) === 1 ? 'vote' : 'votes'}` : ''}</span>
<span class="mm-entry-when">last use <time datetime="${esc(e.last_seen_at)}">${esc(String(e.last_seen_at || '').slice(0, 10))}</time></span>
</a></li>`;
}

function empty(text, href = '/week', label = 'This week’s ballot') {
    return `<div class="mm-empty"><p>${esc(text)}</p><a class="mm-btn mm-btn-quiet" href="${esc(href)}">${esc(label)}</a></div>`;
}

/** The room's picture: a meme's family tree growing from its first moment, stickers fanning off the branches. */
function treeMotif() {
    return `<div class="mm-tree" aria-hidden="true">
<svg class="mm-tree-lines" viewBox="0 0 400 280" preserveAspectRatio="none"><path d="M200 78 C200 128 92 118 92 176"/><path d="M200 78 L200 176"/><path d="M200 78 C200 128 308 118 308 176"/><path d="M92 206 C92 236 52 232 52 258"/><path d="M92 206 C92 236 132 232 132 258"/><path d="M308 206 C308 236 348 232 348 258"/></svg>
<span class="mm-node mm-node-root"><b>Cozmo is offline</b><small>chat · the first time</small></span>
<span class="mm-node mm-n1">VOD · 25:41</span><span class="mm-node mm-n2">a clip</span><span class="mm-node mm-n3">the Rundown</span>
<span class="mm-sticker mm-s1">classic</span><span class="mm-sticker mm-s2">lol</span><span class="mm-sticker mm-s3">rising</span>
</div>`;
}

function home({ trending = [], week = null, counts = {} } = {}) {
    const candidates = week ? week.candidates.slice(0, 3) : [];
    // Real first (the owner, 10-31: empty sections made the rooms look unfinished). Trending and the week's teaser show only
    // when they have entries; while neither does, one short "be the first" row sits below the scenes instead.
    const trendingSec = trending.length ? `<section class="mm-section" id="mm-trending" aria-labelledby="mm-trending-h">
<div class="mm-head-row"><h2 id="mm-trending-h">Trending</h2><span class="mm-count">${Number(counts.entries) || trending.length} public ${Number(counts.entries) === 1 ? 'entry' : 'entries'}</span></div>
<ol class="mm-entries">${trending.slice(0, 8).map(card).join('')}</ol>
</section>` : '';
    const weekSec = candidates.length ? `<section class="mm-section" id="mm-week-teaser" aria-labelledby="mm-week-teaser-h">
<div class="mm-head-row"><h2 id="mm-week-teaser-h">Meme of the week</h2><a class="mm-more" href="/week">The ballot${kit.icon('chevron')}</a></div>
<ol class="mm-entries mm-entries-week">${candidates.map(card).join('')}</ol>
</section>` : '';
    const firsts = [
        !trending.length && ['The first entries are on their way', 'Each one is checked against the chat line or VOD second it started from before it is public.', '/developers', 'How entries are built'],
        !candidates.length && ['Make the first caption', 'Pick a template, write the lines, and it is saved as text anyone can remix.', '/make', 'Open the generator'],
    ].filter(Boolean);
    const beFirst = firsts.length ? `<section class="mm-section mm-first" aria-labelledby="mm-first-h"><h2 id="mm-first-h">Be the first</h2><ul class="mm-first-list">${firsts.map(([title, text, href, label]) => `<li><b>${esc(title)}</b><span>${esc(text)}</span><a href="${esc(href)}">${esc(label)}</a></li>`).join('')}</ul></section>` : '';
    const live = `${trendingSec}${weekSec}`;
    const room = sc.room({
        room: 'meme',
        hero: {
            title: 'Every joke has a first time',
            lede: 'The open meme database. Each running joke is written down with the moment it happened, a chat line, a VOD second, a Rundown segment, and every later use. People vote for meme of the week, and anyone can caption a template.',
            start: { href: '/week', label: 'Vote for meme of the week' },
            chips: [{ label: 'Make a caption', href: '/make' }, ...(trending.length ? [{ label: 'Trending', href: '#mm-trending' }] : []), { label: 'The API', href: '/developers' }],
            proof: Number(counts.entries) ? [{ value: Number(counts.entries), label: Number(counts.entries) === 1 ? 'entry' : 'entries' }] : [],
            motif: treeMotif(),
        },
        scenes: [
            { title: 'A stream moment becomes an entry', text: 'An entry starts where the joke did: the chat line or the second of the VOD, quoted word for word and linked. A source that disappears is marked, and an entry without its origin goes back into hiding.',
                html: `<blockquote class="mm-cite mm-cite-origin mm-demo-cite"><p class="mm-quote">but yeah and Cosmo is broken now</p><footer class="mm-cite-foot"><span class="mm-cite-source">VOD</span> · at 25:41 · Oct 26 · <span class="mm-cite-link">the moment</span></footer></blockquote>`,
                action: { href: '/developers', label: 'How entries are built' } },
            { title: 'Watch a joke rise', text: 'Every use is dated, so you can see a joke catch on, peak and become a classic. Rising first on the trending list.',
                html: `<div class="mm-demo-rise"><span class="mm-status mm-status-rising">Rising</span><span class="mm-demo-bars">${[2, 3, 2, 4, 6, 5, 8, 11, 9, 14].map((h) => `<i style="--h:${h}"></i>`).join('')}</span><small>uses per day, last 10 days</small></div>`,
                action: { href: '/week', label: 'See this week\'s ballot' } },
            { title: 'Caption it', text: 'Pick a template, type up to four lines and see them over the picture. A caption is saved as text, so anyone can remix it.',
                html: `<figure class="mm-caption-card mm-demo-caption"><img src="/img/template-classic.svg" alt=""><figcaption><span>when the robot is offline</span><span>and chat has to cope</span></figcaption></figure>`,
                action: { href: '/make', label: 'Open the generator' } },
        ],
        faq: { items: [
            ['Where do the entries come from?', 'From OpenVibe itself: the Rundown, VOD transcripts and the public chat. An importer proposes a candidate when a phrase comes back on more than one day; a person checks it against its source before it is public.'],
            ['Can I get something taken down?', 'Yes. Every entry has a takedown and correction form for signed-in people, and staff answer it. VOD 5709 and clip 483 are never cited.'],
            ['Is the database open?', 'Yes: every public entry and citation is in the API, and in OpenVibe\'s Search.'],
        ] },
    });
    // What is real goes above the scenes; what is still missing goes after them.
    const at = room.indexOf('<section class="sc-room-scenes"');
    const end = at < 0 ? -1 : room.indexOf('</section>', at) + '</section>'.length;
    const page = at < 0 ? live + room + beFirst : room.slice(0, at) + live + room.slice(at, end) + beFirst + room.slice(end);
    return `<div class="mm-wrap mm-home" id="mm-home">${page}</div>`;
}

function entry({ e, citations = [], signedIn = false, staff = false, reported = false, problem = null } = {}) {
    const origin = citations.find((c) => c.role === 'origin') || citations[0] || null;
    const uses = citations.filter((c) => c !== origin);
    const examples = citations.filter((c) => c.role === 'example');
    const others = uses.filter((c) => c.role !== 'example');
    return `<div class="mm-wrap" id="mm-entry" data-entry="${esc(e.slug)}">
<article class="mm-entry">
<header class="mm-entry-h">
<p class="mm-kicker">${kindLabel(e.kind)} · ${statusBadge(e.status)}${staff ? ' · <span class="mm-staff">staff view</span>' : ''}</p>
<h1>${esc(e.title)}</h1>
${e.summary ? `<p class="mm-summary">${esc(e.summary)}</p>` : ''}
<dl class="mm-facts">
<div><dt>First seen</dt><dd><time datetime="${esc(e.first_seen_at)}">${esc(String(e.first_seen_at || '').slice(0, 10))}</time></dd></div>
<div><dt>Last seen</dt><dd><time datetime="${esc(e.last_seen_at)}">${esc(String(e.last_seen_at || '').slice(0, 10))}</time></dd></div>
<div><dt>Uses cited</dt><dd>${citations.length}</dd></div>
<div><dt>Revision</dt><dd>${Number(e.revision) || 1}</dd></div>
</dl>
</header>

<section class="mm-origin" id="mm-origin" aria-labelledby="mm-origin-h">
<h2 id="mm-origin-h">Where it started</h2>
${origin ? citation(origin) : '<p class="mm-muted">No origin citation is attached yet.</p>'}
</section>

<section class="mm-timeline-sec" id="mm-timeline" aria-labelledby="mm-timeline-h">
<h2 id="mm-timeline-h">The use timeline</h2>
${others.length ? `<ol class="mm-timeline">${others.map((c) => `<li class="mm-timeline-item"><time class="mm-timeline-when" datetime="${esc(c.observed_at)}">${esc(String(c.observed_at || '').slice(0, 10))}</time>${citation(c)}</li>`).join('')}</ol>` : '<p class="mm-muted">No later use is cited yet. The timeline grows as the importer finds repeats.</p>'}
</section>

${examples.length ? `<section class="mm-examples" id="mm-examples" aria-labelledby="mm-examples-h"><h2 id="mm-examples-h">Examples</h2>${examples.map((c) => citation(c)).join('')}</section>` : '<section class="mm-examples" id="mm-examples" aria-labelledby="mm-examples-h"><h2 id="mm-examples-h">Examples</h2><p class="mm-muted">No example is attached yet.</p></section>'}

<footer class="mm-entry-foot">
${reported ? '<p class="mm-note" role="status">Thank you. Staff will look at the report.</p>' : ''}
${problem ? `<p class="mm-note is-bad" role="alert">${esc(problem)}</p>` : ''}
${signedIn ? `<details class="mm-report"><summary>Report a correction or takedown</summary>
<form method="post" action="/m/${esc(e.slug)}/report" class="mm-form mm-form-inline">
<label class="mm-field"><span>What is wrong?</span><select name="kind"><option value="takedown">A takedown</option><option value="correction">A correction</option></select></label>
<label class="mm-field"><span>Reason</span><input name="reason" type="text" maxlength="2000" required placeholder="The source is gone, the quote is wrong…"></label>
<label class="mm-field"><span>Note (optional)</span><textarea name="note" rows="2" maxlength="4000"></textarea></label>
<button class="mm-btn mm-btn-quiet" type="submit">Send the report</button>
</form></details>` : `<p class="mm-muted"><a href="/auth/login?next=${encodeURIComponent(`/m/${e.slug}`)}">Sign in</a> to report a correction or takedown.</p>`}
</footer>
</article>
</div>`;
}

function week({ out, signedIn = false, voted = false, error = false } = {}) {
    const candidates = out ? out.candidates : [];
    return `<div class="mm-wrap" id="mm-week">
<header class="mm-page-h"><p class="mm-kicker">Meme of the week</p><h1>The ballot</h1>
<p class="mm-lede">One vote a week, per person. A vote can change until the week ends; the week is ${esc(out ? out.week : '')} (Monday to Sunday, UTC).</p></header>
${voted ? '<p class="mm-note" role="status">Your vote is counted.</p>' : ''}
${error ? '<p class="mm-note is-bad" role="alert">That vote could not be counted. Try again from the ballot.</p>' : ''}
${signedIn ? '' : '<p class="mm-note">You can read the ballot without an account. <a href="/auth/login?next=%2Fweek">Sign in</a> to vote.</p>'}
${candidates.length ? `<ol class="mm-candidates">${candidates.map((c) => `<li class="mm-candidate${c.mine ? ' is-mine' : ''}" data-entry="${esc(c.slug)}">
<div class="mm-candidate-body"><a class="mm-candidate-title" href="/m/${esc(c.slug)}">${esc(c.title)}</a><span class="mm-candidate-meta">${kindLabel(c.kind)} · ${statusBadge(c.status)}</span></div>
<div class="mm-candidate-vote"><strong class="mm-vote-count">${Number(c.votes) || 0}</strong><span>${Number(c.votes) === 1 ? 'vote' : 'votes'}</span>
${signedIn ? `<form method="post" action="/week/vote" class="mm-inline"><input type="hidden" name="entry_id" value="${esc(c.id)}"><button class="mm-btn mm-btn-small${c.mine ? ' is-mine' : ''}" type="submit">${c.mine ? 'Your vote' : 'Vote'}</button></form>` : ''}
</div></li>`).join('')}</ol>` : empty('No candidate has a use this week yet.')}
<p class="mm-fine">A candidate is a public entry with at least one live use in this ISO week. The count is the number of people who chose it, not a score you can buy.</p>
</div>`;
}

const LINES = [1, 2, 3, 4];

function make({ templates = [], values = {}, preview = null, signedIn = false, problem = null } = {}) {
    const v = { template_id: templates[0] ? templates[0].id : '', visibility: 'public', ...values };
    const lines = LINES.map((i) => v[`line${i}`] || '');
    return `<div class="mm-wrap" id="mm-make">
<header class="mm-page-h"><p class="mm-kicker">The caption generator</p><h1>Put words on a template</h1>
<p class="mm-lede">Pick a template and type up to four lines, ${LINES.length * 120} characters at most. The preview is HTML text over the image; saving stores the lines, never a picture.</p></header>
${problem ? `<p class="mm-note is-bad" role="alert">${esc(problem)}</p>` : ''}
<div class="mm-make-grid">
<form id="mm-caption-form" class="mm-form mm-card" method="post" action="/make">
<fieldset class="mm-templates"><legend>Template</legend>
${templates.map((t) => `<label class="mm-template${t.id === v.template_id ? ' is-chosen' : ''}"><input type="radio" name="template_id" value="${esc(t.id)}"${t.id === v.template_id ? ' checked' : ''} required><img src="${esc(t.image_url)}" alt="" width="220" height="140" loading="lazy"><span><b>${esc(t.name)}</b><small>${Number(t.box_count)} ${Number(t.box_count) === 1 ? 'box' : 'boxes'} · ${esc(t.license)}</small></span></label>`).join('')}
</fieldset>
${LINES.map((i) => `<label class="mm-field"><span>Line ${i}</span><input name="line${i}" type="text" maxlength="120" value="${esc(lines[i - 1])}" placeholder="${i === 1 ? 'when the robot is offline' : ''}"></label>`).join('')}
<label class="mm-field"><span>Who can see it?</span><select name="visibility"><option value="public"${v.visibility === 'public' ? ' selected' : ''}>Anyone</option><option value="unlisted"${v.visibility === 'unlisted' ? ' selected' : ''}>Anyone with the link</option><option value="hidden"${v.visibility === 'hidden' ? ' selected' : ''}>Only me</option></select></label>
<div class="mm-actions"><button class="mm-btn" type="submit">Save the caption</button><button class="mm-btn mm-btn-quiet" type="submit" formaction="/make" formmethod="get">Preview</button></div>
${signedIn ? '' : '<p class="mm-fine">You can preview without signing in. <a href="/auth/login?next=%2Fmake">Sign in</a> to save a caption.</p>'}
</form>
<aside class="mm-preview" id="mm-preview" aria-labelledby="mm-preview-h"><h2 id="mm-preview-h">Preview</h2>
${preview ? `<figure class="mm-caption-card"><img src="${esc(preview.template.image_url)}" alt=""><figcaption>${preview.lines.map((l) => `<span>${esc(l)}</span>`).join('')}</figcaption></figure><p class="mm-fine">Text only, over ${esc(preview.template.name)}. Nothing is saved until you press Save.</p>` : '<p class="mm-muted">Press Preview to see your lines over the template.</p>'}
</aside>
</div>
</div>`;
}

function caption({ caption: c, template, mine = false } = {}) {
    return `<div class="mm-wrap" id="mm-caption" data-caption="${esc(c.id)}">
<header class="mm-page-h"><p class="mm-kicker">A saved caption</p><h1>${esc(template ? template.name : 'Caption')}</h1>
<p class="mm-lede">${mine ? 'Yours. ' : ''}Text over the template image, saved as lines — never as a rendered picture.</p></header>
<figure class="mm-caption-card mm-caption-large">
${template ? `<img src="${esc(template.image_url)}" alt="">` : ''}
<figcaption>${c.lines.map((l) => `<span>${esc(l)}</span>`).join('')}</figcaption>
</figure>
<dl class="mm-facts"><div><dt>Saved</dt><dd>${time(c.created_at)}</dd></div><div><dt>Visibility</dt><dd>${esc(c.visibility)}</dd></div><div><dt>Caption</dt><dd><code>${esc(c.id)}</code></dd></div></dl>
<div class="mm-actions"><a class="mm-btn" href="/make">Make another</a><a class="mm-btn mm-btn-quiet" href="/">Back to the memes</a></div>
</div>`;
}

function signIn({ title, text, next }) {
    return `<div class="mm-wrap mm-page-pad mm-narrow"><div class="mm-empty"><h1>${esc(title)}</h1><p>${esc(text)}</p><a class="mm-btn" href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a></div></div>`;
}

function developers() {
    const ep = (m, p, d) => `<div><dt><code>${esc(m)} ${esc(p)}</code></dt><dd>${d}</dd></div>`;
    return `<div class="mm-wrap" id="mm-developers">
<header class="mm-page-h"><p class="mm-kicker">Developers</p><h1>The Meme API</h1>
<p class="mm-lede">JSON under <code>/api/v1</code>, with <code>application/problem+json</code> errors. A person is the <code>meme_at</code> session cookie or a Network user token as a Bearer.</p></header>
<section><h2>Read</h2><dl class="mm-eps">
${ep('GET', '/api/v1/entries?limit=&cursor=&kind=&status=', 'Public entries, newest first, cursor-paged (at most 50).')}
${ep('GET', '/api/v1/entries/:slug', 'One entry with every citation and the use timeline. A hidden one is 404 unless you are staff.')}
${ep('GET', '/api/v1/entries/:slug/series?days=30', 'Uses per UTC day, zero-filled (1–365 days).')}
${ep('GET', '/api/v1/trending', 'Public entries, rising first.')}
${ep('GET', '/api/v1/week', 'This ISO week’s candidates and their vote counts.')}
${ep('GET', '/api/v1/templates', 'Caption templates: image, box count, source and license.')}
${ep('GET', '/api/v1/captions/:id', 'One saved caption (a hidden one is 404 unless it is yours or you are staff).')}
</dl></section>
<section><h2>Write (signed in)</h2><dl class="mm-eps">
${ep('POST', '/api/v1/week/vote', '<code>{ entry_id }</code>. One vote a week per person; a second call changes the choice. Same-origin.')}
${ep('POST', '/api/v1/captions', '<code>{ template_id, lines, visibility? }</code>: 1–4 lines, each at most 120 characters, text only, blocked words refused.')}
${ep('POST', '/api/v1/entries/:slug/report', '<code>{ kind: "takedown"|"correction", reason, note? }</code> for staff review.')}
</dl></section>
<section><h2>Staff (Network role <code>global_mod</code> or above)</h2><dl class="mm-eps">
${ep('POST', '/api/v1/entries/:slug/publish', 'Make a hidden candidate public. Refused when its origin citation is gone (409).')}
${ep('POST', '/api/v1/entries/:slug/hide', 'Remove it from public lists and tombstone its Search document.')}
${ep('PATCH', '/api/v1/entries/:slug', '<code>{ title, kind, status }</code>: change an entry; status history is kept.')}
${ep('GET', '/api/v1/reports', 'The open takedown/correction reports.')}
</dl></section>
<section id="mm-search"><h2>Search</h2><p class="mm-fine">Each public entry is one <code>search.index-document@1</code> (owner <code>meme</code>, type <code>entry</code>, canonical page <code>/m/&lt;slug&gt;</code>) queued in <code>meme_outbox</code>; hiding or deleting an entry queues a tombstone. The importer reads only public APIs and never publishes: a candidate stays hidden until a staff person publishes it.</p></section>
</div>`;
}

function notFound() {
    return `<div class="mm-wrap mm-page-pad mm-narrow"><div class="mm-empty" id="mm-not-found"><p class="mm-kicker">404</p><h1>This meme is not here</h1><p>It may have been hidden, its origin source may be gone, or the address was never an entry.</p><a class="mm-btn" href="/">Back to the memes</a></div></div>`;
}

module.exports = { home, entry, week, make, caption, signIn, developers, notFound, statusBadge, kindLabel, citation, clock, STATUS_LABEL, KIND_LABEL, SOURCE_LABEL };
