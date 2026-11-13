'use strict';

/**
 * The Meme room's pages (plan 2026-10-28 §5.7). Server-rendered and whole without JavaScript: every action is a
 * plain form or link. public/js/meme.js upgrades the template search, live preview, and PNG export without becoming
 * a requirement for reading the library or submitting the server-rendered form.
 *
 *   home({ trending, week })                       internet-meme discovery, meme of the week, and the maker
 *   entry({ e, citations, signedIn, staff })       the origin with its citation link, the use timeline, examples
 *   week({ out, signedIn })                        this week's candidates and the vote form
 *   browse({ entries, filters })                   searchable public internet-meme library
 *   make({ templates, values, preview, signedIn }) the caption editor form
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
// classic: an internet meme from the encyclopedia (Wikidata), whose status is Classic too; its own word avoids "classic · Classic".
const KIND_LABEL = { joke: 'Joke', catchphrase: 'Catchphrase', bit: 'Bit', meme: 'Meme', saga: 'Saga', classic: 'Internet meme' };
const SOURCE_LABEL = { chat_message: 'Chat', vod: 'VOD', clip: 'Clip', rundown_segment: 'The Rundown', ai_paste: 'Community', stream_memory: 'Stream memory' };

const statusBadge = (s) => `<span class="mm-status mm-status-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

/** The entry's Share button, built by the shared kit (openvibe-shared 4.114.0 kit.share): the same quiet button with
 *  the same share icon on every OpenVibe site. It sits right under the title's meta line, beside it when there is
 *  room, so on a phone it never stands alone on a line of its own. */
const shareButton = (e, share) => kit.share({ title: e.title, url: share.url, text: e.summary || '', image: share.image || null });
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
function treeMotif(feature = null) {
    const root = "A meme's origin";
    const moment = 'first format';
    return `<div class="mm-tree" aria-hidden="true">
<svg class="mm-tree-lines" viewBox="0 0 400 280" preserveAspectRatio="none"><path d="M200 78 C200 128 92 118 92 176"/><path d="M200 78 L200 176"/><path d="M200 78 C200 128 308 118 308 176"/><path d="M92 206 C92 236 52 232 52 258"/><path d="M92 206 C92 236 132 232 132 258"/><path d="M308 206 C308 236 348 232 348 258"/></svg>
<span class="mm-node mm-node-root"><b>${root}</b><small>traced to sources</small></span>
<span class="mm-node mm-n1">${moment}</span><span class="mm-node mm-n2">new variations</span><span class="mm-node mm-n3">shared culture</span>
<span class="mm-sticker mm-s1">origin</span><span class="mm-sticker mm-s2">remix</span><span class="mm-sticker mm-s3">history</span>
</div>`;
}

/** The origin scene: the first real entry's own cited moment — quote, source, its second and date, linked. */
function homeCitation(feature) {
    const cites = feature && Array.isArray(feature.citations) ? feature.citations : [];
    const c = cites.find((x) => x.role === 'origin') || cites[0] || null;
    if (!c) {
        return `<div class="mm-empty"><p>No cited moment yet.</p><a class="mm-btn mm-btn-quiet" href="/developers">How entries are built</a></div>`;
    }
    const at = clock(c.offset_seconds);
    const when = String(c.observed_at || '').slice(0, 10);
    return `<blockquote class="mm-cite mm-cite-origin mm-demo-cite"><p class="mm-quote">${esc(c.quote_text)}</p><footer class="mm-cite-foot"><span class="mm-cite-source">${esc(SOURCE_LABEL[c.source_type] || c.source_type)}</span>${at ? ` · at ${esc(at)}` : ''}${when ? ` · ${esc(when)}` : ''} · <a class="mm-cite-link" href="${esc(c.url)}" rel="noopener">the moment</a></footer></blockquote>`;
}

/** The rise scene: the first real entry's own cited uses per day, scaled to its busiest day in the last ten. */
function homeRise(feature) {
    const rows = feature && feature.series && Array.isArray(feature.series.series) ? feature.series.series : [];
    const max = Math.max(0, ...rows.map((r) => Number(r.uses) || 0));
    if (!rows.length || max === 0) {
        return `<div class="mm-empty"><p>No uses cited in the last 10 days.</p><a class="mm-btn mm-btn-quiet" href="/week">This week's ballot</a></div>`;
    }
    const bars = rows.map((r) => `<i style="--h:${Math.max(1, Math.round((Number(r.uses) || 0) / max * 14))}" title="${Number(r.uses) || 0} on ${esc(r.day)}"></i>`).join('');
    return `<div class="mm-demo-rise"><span class="mm-status mm-status-${esc(feature.entry.status)}">${esc(STATUS_LABEL[feature.entry.status] || feature.entry.status)}</span><span class="mm-demo-bars">${bars}</span><small>uses per day, last ${rows.length} days · <a href="/m/${esc(feature.entry.slug)}">${esc(feature.entry.title)}</a></small></div>`;
}

function home({ trending = [], week = null, counts = {}, feature = null, templatesToday = [] } = {}) {
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
    const templateSec = templatesToday.length ? `<section class="mm-section mm-template-today" aria-labelledby="mm-template-today-h"><div class="mm-head-row"><h2 id="mm-template-today-h">Templates to try today</h2><a class="mm-more" href="/make">Make one${kit.icon('chevron')}</a></div><ol class="mm-entries">${templatesToday.slice(0, 6).map((t) => `<li class="mm-entry-card"><a class="mm-entry-link" href="/make?template_id=${encodeURIComponent(t.id)}"><img class="mm-template-thumb" src="${esc(t.image_url)}" alt="" loading="lazy"><span class="mm-entry-title">${esc(t.name)}</span><span class="mm-entry-meta">${Number(t.uses_today) || 0} captions today · ${esc(t.license)}</span></a></li>`).join('')}</ol></section>` : '';
    const firsts = [
        !trending.length && ['Start with a classic', 'Browse the internet meme encyclopedia and follow a format from its first trace to its latest variations.', '/browse?scope=internet', 'Explore internet memes'],
        !candidates.length && ['Make a meme', 'Choose a reusable template, write a caption, and export a PNG or save a remixable link.', '/make', 'Open the meme maker'],
    ].filter(Boolean);
    const beFirst = firsts.length ? `<section class="mm-section mm-first" aria-labelledby="mm-first-h"><h2 id="mm-first-h">Be the first</h2><ul class="mm-first-list">${firsts.map(([title, text, href, label]) => `<li><b>${esc(title)}</b><span>${esc(text)}</span><a href="${esc(href)}">${esc(label)}</a></li>`).join('')}</ul></section>` : '';
    const live = `${trendingSec}${weekSec}${templateSec}`;
    const room = sc.room({
        room: 'meme',
        hero: {
            title: 'Know the meme. Make it yours.',
            lede: 'An open encyclopedia of internet memes: what each one means, where it began, how it spread, and the formats people still remix.',
            start: { href: '/make', label: 'Make a meme' },
            chips: [{ label: 'Explore memes', href: '/browse?scope=internet' }, ...(trending.length ? [{ label: 'Trending', href: '#mm-trending' }] : []), { label: 'The API', href: '/developers' }],
            proof: Number(counts.entries) ? [{ value: Number(counts.entries), label: Number(counts.entries) === 1 ? 'entry' : 'entries' }] : [],
            motif: treeMotif(feature),
        },
        scenes: [
            { title: 'Find the format behind the joke', text: 'Start with the name or a phrase you remember. Each entry explains the format in plain language and connects its origin, spread, variations, examples, and related memes.',
                html: `<form class="mm-library-search" action="/browse" method="get" role="search"><label for="mm-home-q">Search memes and formats</label><div><input id="mm-home-q" name="q" type="search" maxlength="120" placeholder="Distracted Boyfriend, Rickroll…"><button class="mm-btn" type="submit">Search</button></div><p><a href="/browse?scope=internet">Browse internet memes</a> · <a href="/browse?sort=top">Most used</a></p></form>`,
                action: { href: '/browse?scope=internet', label: 'Browse the encyclopedia' } },
            { title: 'See how a meme changes', text: 'Origins and spread are cited, variations show how a format mutates, and related entries connect the larger family of memes.',
                html: `<ol class="mm-history-strip"><li><b>Origin</b><span>Find the earliest traceable example</span></li><li><b>Spread</b><span>Follow how the format traveled</span></li><li><b>Remix</b><span>See what people made from it</span></li></ol>`,
                action: { href: '/browse?scope=internet', label: 'Explore researched entries' } },
            { title: 'Make a meme in seconds', text: 'Choose a reusable template, add your own caption, preview it instantly, and save a link others can remix.',
                html: `<div class="mm-rise-card"><span class="mm-rise-mark" aria-hidden="true"><i data-ov-icon="open"></i></span><div><b>Fresh formats, lasting classics</b><p>Find new entries and familiar favorites in one searchable library.</p></div></div>`,
                action: { href: '/make', label: 'Open the meme maker' } },
            { title: 'Made for remixing', text: 'Captions stay editable as text. Templates carry their source and reuse licence, and uploaded examples go through moderation.',
                html: `<div><p class="mm-kicker">Example caption</p><figure class="mm-caption-card mm-demo-caption"><img src="/img/template-classic.svg" alt="An example caption on a template"><figcaption><span>when you find the original meme</span><span>the repost has a million views</span></figcaption></figure></div>`,
                action: { href: '/make', label: 'Make your own' } },
        ],
        faq: { items: [
            ['What is in the meme library?', 'Internet memes and formats, documented with original sources, clear explanations, examples, variations, and links to related entries. Stream appearances are shown only when a known meme is named in a transcript.'],
            ['Can I get something corrected or removed?', 'Yes. Every entry has a correction and takedown report path. Example uploads are reviewed before publication.'],
            ['Can I reuse templates?', 'Each template page names its source and licence. Use licensed templates or artwork you have permission to upload.'],
        ] },
    });
    // What is real goes above the scenes; what is still missing goes after them.
    const at = room.indexOf('<section class="sc-room-scenes"');
    const end = at < 0 ? -1 : room.indexOf('</section>', at) + '</section>'.length;
    const page = at < 0 ? live + room + beFirst : room.slice(0, at) + live + room.slice(at, end) + beFirst + room.slice(end);
    return `<div class="mm-wrap mm-home" id="mm-home">${page}</div>`;
}

function entry({ e, citations = [], signedIn = false, staff = false, reported = false, problem = null, share = null } = {}) {
    const origin = citations.find((c) => c.role === 'origin') || citations[0] || null;
    const uses = citations.filter((c) => c !== origin);
    const examples = citations.filter((c) => c.role === 'example');
    const others = uses.filter((c) => c.role !== 'example');
    const liveUses = citations.filter((c) => c.source_service === 'live');
    const mediaExamples = Array.isArray(e.examples) ? e.examples.filter((x) => x && x.media_id) : [];
    return `<div class="mm-wrap" id="mm-entry" data-entry="${esc(e.slug)}">
<article class="mm-entry">
<header class="mm-entry-h">
<p class="mm-kicker">${kindLabel(e.kind)} · ${statusBadge(e.status)}${staff ? ' · <span class="mm-staff">staff view</span>' : ''}</p>
<h1>${esc(e.title)}</h1>
${e.summary ? `<p class="mm-summary">${esc(e.summary)}${share && share.url ? ' ' + shareButton(e, share) : ''}</p>` : (share && share.url ? shareButton(e, share) : '')}
<dl class="mm-facts">
<div><dt>First seen</dt><dd><time datetime="${esc(e.first_seen_at)}">${esc(String(e.first_seen_at || '').slice(0, 10))}</time></dd></div>
<div><dt>Last seen</dt><dd><time datetime="${esc(e.last_seen_at)}">${esc(String(e.last_seen_at || '').slice(0, 10))}</time></dd></div>
<div><dt>Uses cited</dt><dd>${citations.length}</dd></div>
<div><dt>Revision</dt><dd>${Number(e.revision) || 1}</dd></div>
</dl>
</header>

<section class="mm-origin" id="mm-origin" aria-labelledby="mm-origin-h">
<h2 id="mm-origin-h">Where it started</h2>
${origin ? citation(origin) : (e.origin && e.origin.url ? `<p class="mm-origin-source"><a href="${esc(e.origin.url)}" rel="nofollow noopener">${esc(e.origin.title || e.origin.url)}</a>${e.origin.publisher ? ` · ${esc(e.origin.publisher)}` : ''}${e.origin.published_at ? ` · <time datetime="${esc(e.origin.published_at)}">${esc(String(e.origin.published_at).slice(0, 10))}</time>` : ''}</p>${e.origin.quote ? `<p class="mm-origin-quote"><q>${esc(e.origin.quote)}</q></p>` : ''}` : '<p class="mm-muted">No origin citation is attached yet.</p>')}
</section>

<section class="mm-timeline-sec" id="mm-timeline" aria-labelledby="mm-timeline-h">
<h2 id="mm-timeline-h">The use timeline</h2>
${others.length ? `<ol class="mm-timeline">${others.map((c) => `<li class="mm-timeline-item"><time class="mm-timeline-when" datetime="${esc(c.observed_at)}">${esc(String(c.observed_at || '').slice(0, 10))}</time>${citation(c)}</li>`).join('')}</ol>` : '<p class="mm-muted">No later use is cited yet. The timeline grows as the importer finds repeats.</p>'}
</section>

${examples.length ? `<section class="mm-examples" id="mm-examples" aria-labelledby="mm-examples-h"><h2 id="mm-examples-h">Examples</h2>${examples.map((c) => citation(c)).join('')}</section>` : '<section class="mm-examples" id="mm-examples" aria-labelledby="mm-examples-h"><h2 id="mm-examples-h">Examples</h2><p class="mm-muted">No example is attached yet.</p></section>'}
${mediaExamples.length ? `<section class="mm-example-gallery" aria-labelledby="mm-gallery-h"><h2 id="mm-gallery-h">Remixes from the community</h2><div class="mm-gallery">${mediaExamples.map((x) => `<figure><a href="https://openvibe.media/o/${encodeURIComponent(x.media_id)}"><img src="https://openvibe.media/o/${encodeURIComponent(x.media_id)}" loading="lazy" alt="${esc(x.caption || e.title)}"></a>${x.caption ? `<figcaption>${esc(x.caption)}</figcaption>` : ''}${x.source_url ? `<p><a rel="nofollow noopener" href="${esc(x.source_url)}">Source</a></p>` : ''}</figure>`).join('')}</div></section>` : ''}
${e.spread && e.spread.length ? `<section class="mm-spread" aria-labelledby="mm-spread-h"><h2 id="mm-spread-h">How it spread</h2><ol class="mm-timeline">${e.spread.map((x) => `<li class="mm-timeline-item"><time class="mm-timeline-when" datetime="${esc(x.observed_at)}">${esc(String(x.observed_at || '').slice(0, 10))}</time><div><b>${esc(x.place)}</b>${x.note ? `<p>${esc(x.note)}</p>` : ''}${x.url ? ` <a rel="nofollow noopener" href="${esc(x.url)}">Source</a>` : ''}</div></li>`).join('')}</ol></section>` : ''}
${e.variations && e.variations.length ? `<section class="mm-variations" aria-labelledby="mm-variations-h"><h2 id="mm-variations-h">Variations</h2><ol class="mm-entries">${e.variations.map((x) => `<li class="mm-entry-card"><div class="mm-entry-link"><span class="mm-entry-title">${esc(x.name)}</span>${x.description ? `<span class="mm-entry-summary">${esc(x.description)}</span>` : ''}${x.source_url ? `<a href="${esc(x.source_url)}" rel="nofollow noopener">See source</a>` : ''}</div></li>`).join('')}</ol></section>` : ''}
${e.related && e.related.length ? `<nav class="mm-related" aria-labelledby="mm-related-h"><h2 id="mm-related-h">Related memes</h2><ul class="mm-entries">${e.related.map((x) => `<li class="mm-entry-card"><a class="mm-entry-link" href="/m/${esc(x.slug)}"><span class="mm-entry-title">${esc(x.title)}</span>${x.summary ? `<span class="mm-entry-summary">${esc(x.summary)}</span>` : ''}</a></li>`).join('')}</ul></nav>` : ''}
${liveUses.length ? `<section class="mm-live-mentions" aria-labelledby="mm-live-h"><h2 id="mm-live-h">Seen on OpenVibe.Live</h2><p class="mm-muted">This meme was named in a stream transcript.</p>${liveUses.map((c) => citation(c)).join('')}</section>` : ''}
<details class="mm-entry-faq"><summary>How was this page documented?</summary><p>The entry summarizes cited origins, dated appearances, and community supplied examples. To request a correction or removal, use the report form below.</p></details>

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

function browse({ entries = [], filters = {}, error = null } = {}) {
    const q = filters.q || '';
    const scope = filters.scope || '';
    const sort = filters.sort || 'newest';
    const kinds = [['', 'All types'], ['classic', 'Internet memes'], ['format', 'Formats'], ['meme', 'Memes']];
    return `<div class="mm-wrap" id="mm-browse">
<header class="mm-page-h"><p class="mm-kicker">The open meme encyclopedia</p><h1>Explore memes</h1><p class="mm-lede">Search meme names and formats, follow their origins and variations, and find a template to remix.</p></header>
<form class="mm-browse-filters mm-card" action="/browse" method="get" role="search"><label class="mm-field"><span>Search</span><input type="search" name="q" value="${esc(q)}" maxlength="120" placeholder="Try a meme name or phrase"></label>
<label class="mm-field"><span>Collection</span><select name="scope"><option value="">All collections</option><option value="internet"${scope === 'internet' ? ' selected' : ''}>Internet memes</option></select></label>
<label class="mm-field"><span>Type</span><select name="kind">${kinds.map(([value, label]) => `<option value="${value}"${filters.kind === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
<label class="mm-field"><span>Order</span><select name="sort"><option value="newest"${sort === 'newest' ? ' selected' : ''}>Recently added</option><option value="top"${sort === 'top' ? ' selected' : ''}>Most used</option></select></label><button class="mm-btn" type="submit">Find memes</button></form>
${error ? '<p class="mm-note is-bad" role="alert">Choose a supported filter and try again.</p>' : ''}
<section class="mm-section" aria-live="polite"><div class="mm-head-row"><h2>${q ? `Results for “${esc(q)}”` : scope === 'internet' ? 'Internet memes' : 'The library'}</h2><span class="mm-count">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span></div>
${entries.length ? `<ol class="mm-entries">${entries.map((e) => `<li class="mm-entry-card"><a class="mm-entry-link" href="/m/${esc(e.slug)}"><span class="mm-entry-title">${esc(e.title)}</span><span class="mm-entry-summary">${esc(e.summary || e.meaning || 'Explore the origin, spread, and examples.')}</span><span class="mm-entry-meta">${kindLabel(e.kind)} · ${statusBadge(e.status)}</span></a></li>`).join('')}</ol>` : empty(q ? 'No matching memes yet. Try a shorter name or browse the full library.' : 'No public entries match these filters yet.', '/make', 'Make a meme')}
</section><p class="mm-fine">Entries cite their sources. Images appear only when their licence permits reuse or a member supplied them.</p>
</div>`;
}

function make({ templates = [], values = {}, preview = null, signedIn = false, problem = null } = {}) {
    const v = { template_id: templates[0] ? templates[0].id : '', visibility: 'public', ...values };
    const lines = LINES.map((i) => v[`line${i}`] || '');
    const chosenTemplate = (preview && preview.template) || templates.find((t) => t.id === v.template_id) || templates[0] || null;
    const layout = (chosenTemplate && chosenTemplate.layout) || {};
    const baseBoxes = Array.isArray(layout.boxes) ? layout.boxes : [];
    const boxCount = baseBoxes.length ? baseBoxes.length : Math.max(1, Math.min(4, Number(chosenTemplate && chosenTemplate.box_count) || 4));
    const shownLines = lines.slice(0, Math.min(4, boxCount));
    const stageText = shownLines.map((line, i) => {
        const b = baseBoxes[i] || { x: 20, y: i * 60 + 8, w: 400, h: 48 };
        const x = Number(layout.width) ? Number(b.x) / Number(layout.width) * 100 : 5;
        const y = Number(layout.height) ? Number(b.y) / Number(layout.height) * 100 : i * 20;
        const w = Number(layout.width) ? Number(b.w) / Number(layout.width) * 100 : 90;
        const h = Number(layout.height) ? Number(b.h) / Number(layout.height) * 100 : 18;
        return `<span class="mm-editor-box mm-font-impact" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%;font-size:clamp(12px,6vw,30px);color:#fff;-webkit-text-stroke:3px #000">${esc(line)}</span>`;
    }).join('');
    return `<div class="mm-wrap" id="mm-make">
<header class="mm-page-h"><p class="mm-kicker">Meme maker</p><h1>Make a meme</h1>
<p class="mm-lede">Pick a format, add text, drag it into place, and download your meme. Uploads are reviewed before anyone else can use them.</p></header>
${problem ? `<p class="mm-note is-bad" role="alert">${esc(problem)}</p>` : ''}
<div class="mm-make-grid">
<form id="mm-caption-form" class="mm-form mm-card" method="post" action="/make">
<input type="hidden" name="editor_state" value="${esc(v.editor_state || '')}">
<fieldset class="mm-words"><legend>Your words</legend>
${LINES.map((i) => `<label class="mm-field"${i > boxCount ? ' hidden' : ''}><span>Line ${i}</span><input name="line${i}" type="text" maxlength="120" value="${esc(lines[i - 1])}" placeholder="${i === 1 ? 'when you recognize the format' : ''}"></label>`).join('')}
</fieldset>
<p class="mm-tpl-h" aria-hidden="true">Template</p>
<div class="mm-tpl-bar"><label class="mm-field mm-tpl-find"><span class="mm-sr">Find a template</span><input id="mm-template-filter" type="search" placeholder="Find a template" aria-controls="mm-template-grid" autocomplete="off"></label>
<details class="mm-upload"><summary class="ovk-btn ovk-btn--quiet">Upload your own</summary>
<div id="mm-template-upload" data-template-upload></div>
<p class="mm-fine" data-template-upload-status role="status" aria-live="polite"></p></details></div>
<p class="mm-fine mm-tpl-note">PNG, JPEG or WebP up to 6 MB. New uploads go to moderation before others can use them.</p>
<fieldset class="mm-templates" id="mm-template-grid"><legend class="mm-sr">Template</legend>
${templates.map((t) => `<label class="mm-template${t.id === v.template_id ? ' is-chosen' : ''}" data-template="${esc(t.id)}" data-boxes="${Number(t.box_count) || 1}" data-layout="${esc(JSON.stringify(t.layout || {}))}"><input type="radio" name="template_id" value="${esc(t.id)}"${t.id === v.template_id ? ' checked' : ''} required><img src="${esc(t.image_url)}" alt="" width="220" height="140" loading="lazy"><span><b>${esc(t.name)}</b><small>${Number(t.box_count)} ${Number(t.box_count) === 1 ? 'box' : 'boxes'} · ${esc(t.license)}</small></span></label>`).join('')}
</fieldset>
<fieldset class="mm-editor-tools"><legend>Style and place</legend>
<label class="mm-field"><span>Type style</span><select name="font_style"><option value="impact">Classic Impact</option><option value="modern">Modern</option><option value="soft">Soft</option></select></label>
<label class="mm-field"><span>Text size</span><input name="font_size" type="range" min="12" max="64" value="30"></label>
<label class="mm-field"><span>Text color</span><input name="text_color" type="color" value="#ffffff"></label>
<label class="mm-field"><span>Outline</span><input name="outline_color" type="color" value="#000000"></label>
<label class="mm-field"><span>Outline width</span><input name="outline_width" type="range" min="0" max="8" value="3"></label>
<label class="mm-field"><span>Crop left / right</span><input name="crop_x" type="range" min="0" max="100" value="50"></label>
<label class="mm-field"><span>Crop top / bottom</span><input name="crop_y" type="range" min="0" max="100" value="50"></label>
<button class="mm-btn mm-btn-quiet" type="button" data-add-sticker>＋ Add emoji sticker</button>
<label class="mm-field mm-ai-idea"><span>Get caption ideas</span><input name="idea_topic" type="text" maxlength="300" placeholder="what are you making a meme about?"><button class="mm-btn" type="button" data-caption-ideas>Make it with AI</button><small data-ai-status aria-live="polite">Available without signing in · cheapest OpenVibe.AI route by default</small></label>
</fieldset>
<label class="mm-field"><span>Who can see it?</span><select name="visibility"><option value="public"${v.visibility === 'public' ? ' selected' : ''}>Anyone</option><option value="unlisted"${v.visibility === 'unlisted' ? ' selected' : ''}>Anyone with the link</option><option value="hidden"${v.visibility === 'hidden' ? ' selected' : ''}>Only me</option></select></label>
<div class="mm-actions"><button class="mm-btn" type="submit" data-ov-guide="meme.caption">Save the caption</button><button class="mm-btn mm-btn-quiet" type="submit" formaction="/make" formmethod="get">Preview</button></div>
${signedIn ? '' : '<p class="mm-fine">You can preview without signing in. <a href="/auth/login?next=%2Fmake">Sign in</a> to save a caption.</p>'}
</form>
<aside class="mm-preview" id="mm-preview" aria-labelledby="mm-preview-h"><h2 id="mm-preview-h">Your canvas</h2>
<div class="mm-editor-stage mm-caption-card" data-stage tabindex="0" aria-label="Meme canvas. Drag caption boxes to move them."><img data-canvas-image src="${esc(chosenTemplate ? chosenTemplate.image_url : '')}" alt=""><div data-caption-boxes>${stageText}</div><div data-stickers></div></div>
<p class="mm-fine">Drag text to place it. Use the lower corner to resize. <span data-editor-status aria-live="polite"></span></p>
${signedIn ? '<label class="mm-field"><span>Export format</span><select data-export-format><option value="png">PNG image</option><option value="gif">GIF loop</option><option value="mp4">MP4 clip</option></select></label><button class="mm-btn mm-btn-quiet" type="button" data-render-png>Download</button><p class="mm-fine" data-render-status aria-live="polite"></p>' : '<p class="mm-fine">Sign in to download PNG, GIF, or MP4. Your preview is free to use.</p>'}
</aside>
</div>
</div>`;
}

function caption({ caption: c, template, mine = false, share = null } = {}) {
    const editor = c.editor && typeof c.editor === 'object' ? c.editor : {};
    const fontStyle = ['impact', 'modern', 'soft'].includes(editor.font_style) ? editor.font_style : 'impact';
    const fontSize = Math.min(64, Math.max(12, Number(editor.font_size) || 30));
    const color = /^#[0-9a-f]{6}$/i.test(String(editor.color || '')) ? editor.color : '#ffffff';
    const outline = /^#[0-9a-f]{6}$/i.test(String(editor.outline || '')) ? editor.outline : '#000000';
    const outlineWidth = Math.min(8, Math.max(0, Number(editor.outline_width) || 0));
    const boxes = Array.isArray(editor.boxes) ? editor.boxes : [];
    const boxCount = boxes.length ? boxes.length : Math.max(1, Math.min(4, Number(template && template.box_count) || c.lines.length));
    const shownLines = c.lines.slice(0, Math.min(4, boxCount));
    const boxHtml = shownLines.map((line, i) => {
        const b = boxes[i] || [[5, 7, 90, 24], [5, 68, 90, 24], [5, 37, 90, 20], [5, 43, 90, 18]][i] || [5, 7 + i * 20, 90, 18];
        const x = Math.min(95, Math.max(0, Number(b.x) || 0)), y = Math.min(95, Math.max(0, Number(b.y) || 0));
        const w = Math.min(100 - x, Math.max(12, Number(b.w) || 90)), h = Math.min(100 - y, Math.max(8, Number(b.h) || 20));
        return `<span class="mm-editor-box mm-font-${fontStyle}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%;font-size:${fontSize}px;color:${color};-webkit-text-stroke:${outlineWidth}px ${outline}">${esc(line)}</span>`;
    }).join('');
    const stickerHtml = (Array.isArray(editor.stickers) ? editor.stickers : []).filter((x) => x && ['✨', '😂', '🔥', '💀', '👀', '❤️', '🙌'].includes(x.emoji)).slice(0, 8).map((x) => `<span class="mm-editor-sticker" style="left:${Math.min(100, Math.max(0, Number(x.x) || 50))}%;top:${Math.min(100, Math.max(0, Number(x.y) || 50))}%">${x.emoji}</span>`).join('');
    return `<div class="mm-wrap" id="mm-caption" data-caption="${esc(c.id)}">
<header class="mm-page-h"><p class="mm-kicker">A saved caption</p><h1>${esc(template ? template.name : 'Caption')}</h1>
<p class="mm-lede">${mine ? 'Yours. ' : ''}Text over the template image, saved as lines — never as a rendered picture.</p></header>
<div class="mm-editor-stage mm-caption-card mm-caption-large">${template ? `<img src="${esc(template.image_url)}" alt="">` : ''}<div>${boxHtml}${stickerHtml}</div></div>
<dl class="mm-facts"><div><dt>Saved</dt><dd>${time(c.created_at)}</dd></div><div><dt>Visibility</dt><dd>${esc(c.visibility)}</dd></div><div><dt>Caption</dt><dd><code>${esc(c.id)}</code></dd></div></dl>
<div class="mm-actions">${share && share.url ? `${kit.share({ title: template ? template.name : 'Caption', url: share.url, text: c.lines.join(' / '), image: (template && template.image_url) || null })}<button class="mm-btn mm-btn-quiet" type="button" data-copy-link="${esc(share.url)}">Copy link</button><button class="mm-btn mm-btn-quiet" type="button" data-native-share="${esc(share.url)}" data-share-title="${esc(template ? template.name : 'My meme') }" data-share-text="${esc(c.lines.join(' / '))}">Share…</button><a class="mm-btn mm-btn-quiet" href="https://openvibe.community/forum/discuss?title=${encodeURIComponent(template ? template.name : 'My meme')}&amp;body=${encodeURIComponent(c.lines.join(' / ') + ' — ' + share.url)}" target="_blank" rel="noopener">Post to Feed</a><a class="mm-btn mm-btn-quiet" href="https://openvibe.pics/" target="_blank" rel="noopener">Upload to Pics</a><a class="mm-btn mm-btn-quiet" href="https://openvibe.chat/" target="_blank" rel="noopener">Share in Chat</a><a class="mm-btn mm-btn-quiet" href="/api/v1/captions/${encodeURIComponent(c.id)}/render?format=png" download>Download PNG</a><a class="mm-btn mm-btn-quiet" href="/api/v1/captions/${encodeURIComponent(c.id)}/render?format=gif" download>Download GIF</a><a class="mm-btn mm-btn-quiet" href="/api/v1/captions/${encodeURIComponent(c.id)}/render?format=mp4" download>Download MP4</a>` : ''}<a class="mm-btn" href="/make">Make another</a><a class="mm-btn mm-btn-quiet" href="/">Back to the memes</a></div>
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
${ep('GET', '/api/v1/memes?scope=internet&q=&sort=top&window=week', 'Meme-library alias for public entries with collection, search, and usage filters.')}
${ep('GET', '/api/v1/entries/:slug', 'One entry with every citation and the use timeline. A hidden one is 404 unless you are staff.')}
${ep('GET', '/api/v1/memes/:slug', 'Meme-library alias for an entry, including its citations and timeline.')}
${ep('GET', '/api/v1/entries/:slug/series?days=30', 'Uses per UTC day, zero-filled (1–365 days).')}
${ep('GET', '/api/v1/trending', 'Public entries, rising first.')}
${ep('GET', '/api/v1/week', 'This ISO week’s candidates and their vote counts.')}
${ep('GET', '/api/v1/templates', 'Caption templates: image, box count, source and license.')}
${ep('POST', '/api/v1/caption-ideas', 'Signed-out safe caption suggestions using the cheapest OpenVibe.AI route by default; at most 8 requests per minute per address.')}
${ep('POST', '/api/v1/render', 'Render a caption as PNG, GIF or MP4 from a licensed template, 1–4 lines and optional editor geometry.')}
${ep('GET', '/api/v1/captions/:id/render?format=png|gif|mp4', 'Download the rendered public caption; private captions require their owner or staff.')}
${ep('GET', '/api/v1/captions/:id', 'One saved caption (a hidden one is 404 unless it is yours or you are staff).')}
</dl></section>
<section><h2>Write (signed in)</h2><dl class="mm-eps">
${ep('POST', '/api/v1/week/vote', '<code>{ entry_id }</code>. One vote a week per person; a second call changes the choice. Same-origin.')}
${ep('POST', '/api/v1/captions', '<code>{ template_id, lines, visibility? }</code>: 1–4 lines, each at most 120 characters, text only, blocked words refused.')}
${ep('POST', '/api/v1/templates/uploads', '<code>{ name, image }</code> (PNG/JPEG/WebP data URL, at most 6 MB), stored in Media and held for staff review.')}
${ep('POST', '/api/v1/entries/:slug/report', '<code>{ kind: "takedown"|"correction", reason, note? }</code> for staff review.')}
</dl></section>
<section><h2>Staff (Network role <code>global_mod</code> or above)</h2><dl class="mm-eps">
${ep('GET', '/api/v1/staff/templates/uploads', 'List member-uploaded templates waiting for review.')}
${ep('POST', '/api/v1/staff/templates/:id/review', '<code>{ decision: "approved"|"rejected" }</code>.')}
${ep('POST', '/api/v1/entries/:slug/publish', 'Make a hidden candidate public. Refused when its origin citation is gone (409).')}
${ep('POST', '/api/v1/entries/:slug/hide', 'Remove it from public lists and tombstone its Search document.')}
${ep('PATCH', '/api/v1/entries/:slug', '<code>{ title, kind, status }</code>: change an entry; status history is kept.')}
${ep('GET', '/api/v1/reports', 'The open takedown/correction reports.')}
</dl></section>
<section id="mm-search"><h2>Search</h2><p class="mm-fine">Each public entry is one <code>search.index-document@1</code> (owner <code>meme</code>, type <code>entry</code>, canonical page <code>/m/&lt;slug&gt;</code>) queued in <code>meme_outbox</code> and delivered to OpenVibe.Search within a minute; hiding or deleting an entry queues a tombstone. The importer reads only public APIs and never publishes: a candidate stays hidden until a staff person publishes it.</p></section>
</div>`;
}

function notFound() {
    return `<div class="mm-wrap mm-page-pad mm-narrow"><div class="mm-empty" id="mm-not-found"><p class="mm-kicker">404</p><h1>This meme is not here</h1><p>It may have been hidden, its origin source may be gone, or the address was never an entry.</p><a class="mm-btn" href="/">Back to the memes</a></div></div>`;
}

module.exports = { home, entry, week, browse, make, caption, signIn, developers, notFound, statusBadge, kindLabel, citation, clock, STATUS_LABEL, KIND_LABEL, SOURCE_LABEL };
