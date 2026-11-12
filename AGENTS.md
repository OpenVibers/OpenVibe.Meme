# AGENTS.md — OpenVibe.Meme

## Project Overview

OpenVibe.Meme is an open encyclopedia of internet memes and a maker attached to each entry. Every public entry cites
where it started and how it spread, connects variations/related memes, and is a Search document. Members propose and
edit entries (staff review revisions), vote in the weekly candidate list, make and render captions, analyse a meme,
start a cited deep-dive, and generate a researched caption picture. AI is used through OpenVibe.AI; every judgement,
usage cap and citation rule is in the code, not in a prompt alone.

- **Domain:** `openvibe.meme` · **Port:** 5120 · **Service id:** `meme` · **Env prefix:** `MEME`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey
  optional, `sharp` and ffmpeg for rendering, `openvibe-shared` for the shell.
- **Read first:** [README.md](README.md), [STATUS.json](STATUS.json), [.env.example](.env.example).

**Network context:** identity, roles and JWKS are OpenVibe.Network (OAuth client `meme`; staff is `global_mod` or
above). Chat, Live and Video are **public reads only** (`server/upstreams.js`, `server/reddit-read.js`): Meme never
reads a private VOD and never cites VOD **5709** or clip **483** (the fixed deny list in
[server/deny-list.js](server/deny-list.js)). AI is OpenVibe.AI (`ai.generate`, `ai.run.create`) — never a provider
directly. Wikipedia/Wikidata/Commons are paced, cached, attributed reads. Search documents wait in `meme_outbox` and
are delivered by `openvibe-publishing/search-relay`. Events are OpenVibe.Events.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm run dev                    # http://localhost:5120, PGlite under data/
npm start                      # node server/index.js
npm test                       # every test/*.test.js on temp PGlite, mocked Network/AI/upstreams
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- judge              # only test files whose name contains the word
npm test -- --strict           # a skipped test fails the run
node --check <file.js>         # syntax check (no linter configured)
```

No build step: server-rendered pages plus plain JS/CSS in [public/](public/) and local SVG placeholders in
[public/img/](public/img/). Rendering of captions/pictures is server-side (`sharp`, `server/render-png.js`).

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — listener, telemetry, the importer and citation re-verifier, judge
  job and Events subscriptions; graceful stop. `MEME_DRILL` keeps boot-time work off; tests drive `runOnce()`.
- **App factory:** [server/app.js](server/app.js) — CSP, SSO, `/auth`, `/internal/events`, `/shared`+static, `/api/v1`,
  discovery/agent twins, pages, 404/error handler.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production `/etc/openvibe/meme.env`.
- **Store/schema:** [server/store.js](server/store.js) and [migrations/](migrations/). Core tables: `meme_entries`,
  `meme_citations`, `meme_judgements`, `meme_status_events`, `meme_origins`, `meme_spread_points`,
  `meme_variations`, `meme_examples`, `meme_entry_related`, `meme_entry_revisions`, `meme_entry_redirects`,
  `meme_votes`, `meme_templates`, `meme_captions`, `meme_reports`, `meme_reddit_*`, `meme_analyses`,
  `meme_research`, `meme_deep_dives`, `meme_*_usage`, `meme_outbox`, `event_outbox`, `account_data_events`,
  `telemetry_samples`.
- **AI and rules:** [server/ai/](server/ai/) (`client.js`, `judge.js`, `gate.js`, `context.js`), [server/ai.js](server/ai.js),
  [server/generate-ai.js](server/generate-ai.js), [server/research-ai.js](server/research-ai.js), [server/person-cap.js](server/person-cap.js),
  [server/deny-list.js](server/deny-list.js), [server/text/no-looks.js](server/text/no-looks.js).
- **Content jobs:** [server/importer.js](server/importer.js), [server/classics/](server/classics/) (`seed.js`,
  `sources.js`), [server/trends.js](server/trends.js),
  [server/reddit.js](server/reddit.js), [server/reverify.js](server/reverify.js), [server/research.js](server/research.js),
  [server/analyze.js](server/analyze.js), [server/generate.js](server/generate.js), [server/pics-maker.js](server/pics-maker.js).
- **HTTP:** [server/http/api.js](server/http/api.js), [server/http/pages.js](server/http/pages.js),
  [server/http/principal.js](server/http/principal.js), [server/http/discovery.js](server/http/discovery.js),
  [server/http/router.js](server/http/router.js). Views: [server/views/](server/views/).
- **Auth/account data:** [server/auth/sso.js](server/auth/sso.js), [server/auth/keys.js](server/auth/keys.js),
  [server/identity/account-data.js](server/identity/account-data.js), [server/identity/staff.js](server/identity/staff.js).
- **Frontend:** [server/render/layout.js](server/render/layout.js), [server/render/html.js](server/render/html.js),
  [server/render-png.js](server/render-png.js), [server/render/video.js](server/render/video.js); assets
  [public/css/meme.css](public/css/meme.css), [public/js/meme.js](public/js/meme.js). Pages work without JavaScript.
- **Deploy:** [deploy/systemd/openvibe-meme.service](deploy/systemd/openvibe-meme.service) (`/etc/openvibe/meme.env`,
  `/opt/openvibe.meme`) and [deploy/nginx/openvibe.meme.conf](deploy/nginx/openvibe.meme.conf). `sudo ovhost deploy
  meme`; database `ov_meme`; rollback on a failed `/api/ready`.

## Ownership and Boundaries

Meme owns entries, citations, judgements, status events, origins/spread/variations/examples/related, revisions and
redirects, votes, templates/captions, reports, Reddit observations, analyses, research/deep dives, usage counters and
the Search outbox. It is **not** the authority for Chat/Live/Video content (public reads only), accounts/roles
(Network), AI runs (OpenVibe.AI), Search (documents in its outbox), event delivery (Events), or the host/database
(Host). A hidden proposal is 404 unless its author or staff; a merged entry's old slug answers 301.

## Auth and Capabilities

- A person is the `meme_at` cookie or a Network user token, verified offline; a cookie write must come from
  `https://openvibe.meme` (`meme.cross_site`). Per-actor limits: `MEME_LIMITS_MINUTE`, `MEME_LIMITS_HOUR`.
- Staff = Network `global_mod` or above; staff proposals/revisions apply immediately, members' wait for review.
- The one outbound service grant is OpenVibe.AI `ai.run.create` with a client-credentials token (`svc:meme`); never
  name a provider — AI's routing decides and the run reports what answered.
- Outbound also: `events.subscription.manage`, `search.document.write`, and `identity.subject.resolve` where needed.
- AI budget is both per-day global and per-person (`meme_person_usage`; staff not counted). A refused call is 429
  `meme.ai_budget`, unavailable AI 503 `meme.ai_unavailable`, unavailable Media 503 `meme.media_unavailable`.
- Errors are RFC 9457 problem+json with stable `meme.*` codes.

## API (JSON under `/api/v1`)

Public: `GET /entries`, `GET /memes`, `GET /memes/:slug`, `GET /entries/:slug`, `/entries/:slug/revisions`,
`/entries/:slug/series`, `/entries/:slug/deep-dive`, `GET /week`, `GET /trending`, `GET /trends`, `GET /templates`,
`POST /caption-ideas`, `POST /render`, `GET /captions/:id[/render]`.
Signed in: `POST /entries`, `POST /entries/:slug/revisions`, `POST /week/vote`, `POST /research`, `GET /research/:id`,
`POST /research/:id/entry`, `POST /templates/uploads`, `POST /generate`, `POST /captions`,
`POST /entries/:slug/report`. Staff: `/moderation/revisions`, `/staff/templates/uploads`,
`POST /staff/templates/:id/review`, `/reports`, `/staff/candidates[/:slug]`, `POST /entries/:slug/publish|hide`,
`PATCH /entries/:slug`, `POST /entries/:slug/revisions/:revision/review`. Machine endpoints `/api/health`,
`/api/ready`, `/release.json`, `/metrics` are loopback only.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter. Async handlers through the router.
- IDs are `mem_`/`mcp_`/`mrp_`/`anl_`/`rsc_` + ULID; slugs are unique and title-normalised (`title_key`, lowercase,
  punctuation stripped, whitespace collapsed, unique per kind for public rows).
- New schema = a new `migrations/NNNN_name.sql`; never edit one that has run.
- Citations are verbatim with a canonical URL and an `observed_at`; re-verification marks `live|hidden|gone`, and a
  hidden/gone origin blocks publishing with 409 `meme.origin_gone`. Never invent a citation or a source URL.
- CSP: add every external origin to `helmet` in [server/app.js](server/app.js); Media images come from the named
  `openvibe.media` host, not arbitrary CDNs.
- **People may be described** (owner, 2026-10-31): the old looks filter is off; summaries may describe appearance.
  What stays gated is sex acts/porn (the explicit gate) and the deny list. Do not reintroduce `noLooks`.
- Phone first: `/`, `/m/:slug`, `/week`, `/make`, `/c/:id` must fit 390 px with no horizontal scroll.
- "Calm reduces, only Off removes": hide/visibility reduces what is shown; only the explicit hide/delete path removes.
- No Font Awesome; use `openvibe-shared` glyphs. Empty states use the shared kit.
- Do not hand-write an entry as if AI/judge did; proposals, revisions and staff review are the only paths.

## Key Pitfalls

- **Deny list is fixed:** VOD 5709 and clip 483 (and denied words/sources in [server/deny-list.js](server/deny-list.js))
  must never be cited, summarised or used as an example. [test/deny-list.test.js](test/deny-list.test.js) enforces it.
- **Citations:** each entry has one origin citation plus later uses; the quote is verbatim and the canonical VOD offset
  is seconds. The open web (Wikipedia/Wikidata/Commons) is a source too. A dead origin cannot be published.
- **Classics:** a documented classic publishes on score + written text + a clean deny list; it needs no example uses
  and is not held for describing people, but a low score, denied source or missing text still hides it
  ([server/ai/gate.js](server/ai/gate.js), [test/classic-gate.test.js](test/classic-gate.test.js)).
- **AI budget:** global and per-person caps are reserved before the call (`server/person-cap.js`); a retry must not
  double-count. AI output is validated against the entry's sources before storage.
- **Maker rendering:** safe editor geometry is persisted (`meme_captions.editor_state`, ≤8 KB); uploaded templates are
  `pending` until staff review; the renderer must never fetch an arbitrary user URL (image loading uses the guarded
  fetch in [server/fetch-image.js](server/fetch-image.js)).
- **Search outbox:** public entries are documents; hiding tombstones them. The relay is off without `MEME_SEARCH_URL`
  and documents wait — that is expected.
- **Drill mode** (`MEME_DRILL`) keeps the importer, re-verifier, judge job and subscriptions off; add new timers there.
- **Account deletion** erases personal rows and anonymizes public contributions through `/internal/events`; a
  redelivery changes nothing.

## Testing

`npm test` runs each file in its own process on temp PGlite with mock Network/AI/upstreams: judge/gate/deny-list,
encyclopedia/classics, citations/reverify, trends/Reddit, analyse/research/generate, captions/templates/pics maker,
votes/week, staff revisions, search relay, SSO, pages, agent layer, real-content-first, contrast and migration.
`npm run test:pg` for PostgreSQL. Run the narrowest file first, then the suite; always `node --check` changed files.

## Documentation

- [README.md](README.md) — entries/judge/encyclopedia/trends/analyse/deep dives/generator/importer/citations/Search/
  pages/run/test/deploy.
- [STATUS.json](STATUS.json) — stage, deployed flag, features and not-yet list.
- [.env.example](.env.example) — variable names only.
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).
