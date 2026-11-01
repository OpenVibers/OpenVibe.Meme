# OpenVibe.Meme

> The open meme database, rebuilt with AI.

**Status:** v1 written and tested (see [STATUS.json](STATUS.json)).
**Domain:** `openvibe.meme` · **Port:** 5120 · **Service id:** `meme` · **Env prefix:** `MEME`
**License:** AGPL-3.0-only (same as every OpenVibe service).

OpenVibe.Meme turns OpenVibe's own running jokes into entries with a citation to the moment each one happened —
a chat line, a VOD second, a Rundown segment — a timeline of later uses, a status (`rising`, `peaked`, `classic`,
`dead`), a weekly vote and a caption generator on templates. Every public entry is also a Search Fabric document.

## Purpose

- **Entries, cited.** Every entry has one origin citation and any number of later uses; the quote is verbatim,
  the URL is canonical (OpenVibe.Video's `?t=` redirect is followed, e.g. `/v/6026?t=864` → `/v/6025?t=1541`),
  and `quote_hash` is its sha256. A summary is stored as written (L24 has no looks filter); only an empty summary
  falls back to the title. Verbatim quotes are never rewritten.
- **Candidates stay hidden.** `server/importer.js` reads public Chat/Live APIs only, finds a 3–6 word phrase used at
  least twice on two different days, attaches citations and inserts the entry `hidden`. It never publishes. A staff
  person (Network role `global_mod` or above) publishes it with `POST /api/v1/entries/:slug/publish`.
- **A judge writes the entry.** `server/ai/judge.js` asks OpenVibe.AI to score each candidate from its own
  citations — with the chat lines and transcript lines around each quote — and to write the entry from that material
  only: a title in natural case, a short summary, where it started, how people use it and two or three example uses.
  The score and the reason are stored with the entry.
- **Only what clears the bar is published.** Score 0.75 or more, used at least three times across at least two days
  or two channels, nothing denied, nothing about anyone's looks, the entry complete and a live origin citation.
  Everything else stays hidden for staff, with its score, on `GET /api/v1/staff/candidates`. Every decision is a
  status event.
- **The encyclopedia.** The well-known internet memes, seeded from Wikipedia's lists (CC BY-SA) and Wikidata (CC0)
  with a Commons picture only when its licence allows it, each an entry of kind `classic` with its origin, its
  spread, its sources and its attribution.
- **The citation is checked again.** A daily job reads every public citation URL; a 404/410 marks it `gone`, a
  401/403 marks it `hidden`, and an entry whose origin is gone is hidden (revision +1, Search tombstone).
- **Meme of the week.** People vote once per ISO week; a second vote changes the choice, never adds a ballot.
- **The encyclopedia (M2).** An entry has a `scope` (`openvibe` for today's running jokes, `internet` for the
  encyclopedia), an origin with a public citation, spread points (date, place, URL, count), named variations,
  Media examples, meaning and usage, L1 labels (`nudity`, `language`, `graphic`, `18+`, `flashing`, `spoilers`),
  related memes and a moderated revision history. A signed-in person proposes an entry or an edit; it stays
  pending, and staff approve or reject it. Every public entry is still one Search Fabric document, now with
  `scope` and `labels` facets and the origin as provenance.
- **Trends (M3).** Reddit's official API (OAuth2 client credentials, the four permitted subreddits, no scraping)
  records a score sample per post; `/api/v1/trends?window=day|week` ranks posts by upvote velocity, lists the
  templates a repeated perceptual hash reveals, and the public entries used in the same window. The importer is
  off when `MEME_REDDIT_CLIENT_ID`/`MEME_REDDIT_CLIENT_SECRET` are missing.
- **Analyse (M4).** `POST /api/v1/analyze { url | media_id }` sends the picture to OpenVibe.AI's vision call and
  one structured extraction. It returns the template, the matched entries, origin guesses with a confidence,
  meaning and usage, L1 labels, and for a Reddit URL its spread and the comments' tone. The daily AI budget is
  enforced before any call.
- **Deep dives (M5).** `POST /api/v1/research { topic }` starts a job that gathers sources with OpenVibe.AI's
  `research.gather` and writes a long read in which every paragraph cites a numbered source. A read that cites
  nothing is failed, not published. `GET /api/v1/research/:id` polls it, and the author may save it as a public
  deep-dive entry.
- **The generator.** Pick a template, type 1–4 lines of at most 120 characters each and preview them as HTML text
  over the image; a caption is stored as text lines, never as a rendered image.
- **The generator (M6).** `POST /api/v1/generate { template_slug | topic, lines? }` researches how the format is
  used right now, writes captions in that voice, and renders a real PNG server-side with the template's own text
  boxes, bundled DejaVu fonts, outline and wrap. The PNG goes to OpenVibe.Media and the caption keeps its labels
  and Media id. The older caption page still previews text in HTML over the template.

## Owns

| Table | Holds | Migration |
|---|---|---|
| `meme_entries` | `mem_` + ULID, unique slug (`/m/<slug>`), title, kind `joke\|catchphrase\|bit\|meme\|saga\|classic\|format\|event\|person\|phrase\|deep_dive`, scope `openvibe\|internet`, AI summary, meaning/usage, L1 `labels`, status + `status_since`, first/last seen, visibility `public\|unlisted\|hidden`, `submitted_by` for a proposal, `revision` (+1 on every change), timestamps, the picture and its licence, the attribution, the Wikidata id | `migrations/0001_initial.sql`, `0002_judge_and_encyclopedia.sql`, `0003_encyclopedia.sql` |
| `meme_citations` | entry, role `origin\|use\|example`, source service/type/id, stream/VOD/clip/message ids, canonical VOD `offset_seconds`, verbatim `quote_text`, `quote_hash`, canonical `url`, `observed_at`, `source_status` `live\|hidden\|gone`; the open web is a source too (`wikipedia`, `wikidata`, `commons`) | `0001_initial.sql`, `0002_judge_and_encyclopedia.sql` |
| `meme_judgements` | one row per entry: the score, the reason, the title/summary/origin/spread/examples the AI wrote, whether the text names looks or carries a denied word, the model and the run | `0002_judge_and_encyclopedia.sql` |
| `meme_status_events` | every status change: from, to, reason, who, when; a judge decision adds `decision`, `from_visibility`, `to_visibility` and `score` | `0001_initial.sql`, `0002_judge_and_encyclopedia.sql` |
| `meme_origins` | an internet entry's public origin: source `web\|reddit\|media\|openvibe`, URL, title, publisher, author, published/retrieved time, quote | `0003_encyclopedia.sql` |
| `meme_spread_points` | entry, date, place, optional URL and count, note — one sighting per (entry, date, place, URL) | `0003_encyclopedia.sql` |
| `meme_variations` | entry, name, description, optional `med_` Media id, source URL | `0003_encyclopedia.sql` |
| `meme_examples` | entry, `med_` Media id, caption, source URL — reposted pictures keep their source link | `0003_encyclopedia.sql` |
| `meme_entry_related` | directed related pairs; the API returns both sides' public entries | `0003_encyclopedia.sql` |
| `meme_entry_revisions` | entry, revision, author, `change` jsonb, field-by-field `diff`, moderation state `pending\|approved\|rejected`, reviewer and note | `0003_encyclopedia.sql` |
| `meme_votes` | (`week` `YYYY-Www`, `subject`) → entry; one vote a week | `0001_initial.sql` |
| `meme_templates` | id, name, `image_url` (openvibe.media, a local data-free placeholder or a Wikimedia Commons file), `box_count`, source, license, credit, source page, attribution; three placeholders seeded | `0001_initial.sql`, `0002_judge_and_encyclopedia.sql` |
| `meme_captions` | `mcp_` + ULID, subject, template, `lines` jsonb (1–4 plain-text lines), visibility, created | `0001_initial.sql` |
| `meme_reports` | `mrp_` + ULID, entry, subject, kind `takedown\|correction`, reason, note, status | `0001_initial.sql` |
| `meme_reddit_posts` | one Reddit post: id `t3_…`, subreddit, title, permalink, source URL, author, score, comments, over-18, dHash, Media id, created/last seen | `0004_trends.sql` |
| `meme_reddit_samples` | one score observation per post per run; velocity is computed from these, never from one score | `0004_trends.sql` |
| `meme_reddit_templates` | a dHash cluster repeated across posts: label, representative picture, Media id, post count, first/last seen | `0004_trends.sql` |
| `meme_reddit_template_posts` | which posts belong to a template and their hash distance | `0004_trends.sql` |
| `meme_ai_usage` | per UTC day and kind (`analyze`/`research`/`generate`): AI calls reserved and the cost the run stated | `0005_analyze.sql` |
| `meme_analyses` | `anl_` + ULID, subject (or null for a public analysis), input URL/Media id, status, the finished result jsonb and its cost | `0005_analyze.sql` |
| `meme_research` | `rsc_` + ULID, subject, topic, status, title/summary, the Markdown read, numbered sources/facts/citations, cost, error, saved entry slug, times | `0006_research.sql` |
| `meme_deep_dives` | entry, research job, the full Markdown read and its numbered sources/citations | `0006_research.sql` |
| `meme_research_usage` | per UTC day: research calls reserved and the cost the runs stated | `0006_research.sql` |
| `meme_templates` | id, name, `image_url` (openvibe.media or a local data-free placeholder), `box_count`, source, license, `layout` jsonb (text boxes, font, size, colour, outline, align, wrap); three placeholders seeded | `0001_initial.sql`, `0007_generate.sql` |
| `meme_captions` | `mcp_` + ULID, subject, template, `lines` jsonb (1–4 plain-text lines), visibility, created, L1 `labels`, rendered `media_id` | `0001_initial.sql`, `0007_generate.sql` |
| `meme_reports` | `mrp_` + ULID, entry, subject, kind `takedown\|correction`, reason, note, status | `0001_initial.sql` |
| `meme_generate_usage` | per UTC day: generation calls reserved and the cost the runs stated | `0007_generate.sql` |
| `meme_outbox` | Today's outbox shape: fixed `evt_` id, topic, JSON payload, attempts, last error, claim/backoff lease — the Search document queue | `0001_initial.sql` |
| `account_data_events` | openvibe-sdk/account-data's export/deletion receipts | `0001_initial.sql` |
| `telemetry_samples` | aggregated request telemetry, pruned after 14 days | `0001_initial.sql` |

## Does not own

- **Chat, Live and the VODs** — OpenVibe.Chat and OpenVibe.Live. Meme reads their public history, Rundown and
  transcripts. It never reads a private VOD, and it never cites VOD **5709** or clip **483** (the fixed deny list).
  The one service grant Meme holds is OpenVibe.AI's `ai.run.create`, used by the judge and the encyclopedia.
- **Identity, roles and accounts** — OpenVibe.Network. Meme verifies session tokens against its JWKS; a staff
  route asks for `global_mod` or above.
- **Search** — OpenVibe.Search. Meme produces `search.index-document@1` documents in its own outbox; the Search
  document writer is not wired yet because `meme` has no `search.document.write` grant.
- **Events, the host and the database** — OpenVibe.Events, OpenVibe.Host.

## Depends on

Environment variable names are in [.env.example](.env.example); no value is committed.

- **OpenVibe.Network** — sign-in (OAuth client `meme`, PKCE S256, cookies `meme_at`/`meme_rt`/`meme_oauth`), JWKS,
  token exchange/refresh/revoke, account export/deletion, staff roles: `OV_NETWORK_URL`,
  `OV_NETWORK_INTERNAL_URL`, `OV_NETWORK_ISSUER`, `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`,
  `OV_OAUTH_REDIRECT_URI`, `OV_SESSION_AUDIENCE`, `MEME_AUDIENCE`.
- **OpenVibe.Chat / Live / Video** — the public reads: `OV_CHAT_URL`, `OV_LIVE_URL`, `OV_VIDEO_URL`,
  `MEME_UPSTREAM_TIMEOUT_MS`.
- **OpenVibe.AI** — the judge and the encyclopedia's writing pass: `OV_AI_INTERNAL_URL` (default
  `http://127.0.0.1:4700`), `MEME_AI_AUDIENCE` (`openvibe.ai`), `MEME_AI_SCOPE` (`ai.run.create`),
  `MEME_AI_WAIT_MS`, `MEME_AI_TIMEOUT_MS`, `MEME_AI_POLL_MS`, `MEME_AI_MAX_TOKENS`. Meme calls `ai.generate` as
  the service `meme` with a Network client-credentials token; Network grants `ai.run.create` for the `ai.generate`
  namespace. Meme never names a provider — AI's routing decides, and the run reports what answered.
- **Wikipedia, Wikidata and Wikimedia Commons** — the encyclopedia: `MEME_WIKIPEDIA_URL`, `MEME_WIKIDATA_URL`,
  `MEME_COMMONS_URL`, `MEME_WIKI_USER_AGENT`, `MEME_WIKI_TIMEOUT_MS`, `MEME_WIKI_MIN_INTERVAL_MS`,
  `MEME_ENCYCLOPEDIA_LIMIT`, `MEME_ENCYCLOPEDIA_LISTS`, `MEME_ENCYCLOPEDIA_CATEGORIES`,
  `MEME_ENCYCLOPEDIA_MIN_SCORE`, `MEME_TEMPLATES_LIMIT`.
- **OpenVibe.Events** — account deliveries: `MEME_EVENTS_SECRET`, `MEME_EVENTS_URL`, `MEME_EVENTS_ENDPOINT`.
- **PostgreSQL** — `DATABASE_URL` (through PgBouncer) and `DATABASE_DIRECT_URL` (migrations); embedded PGlite in
  `MEME_PGLITE_DIR` for development.
- **Valkey** — optional `VALKEY_URL`, `VALKEY_PREFIX` (readiness lists it; the limits in v1 count in-process).
- **Packages** — `openvibe-contracts` v0.229.0, `openvibe-sdk` v0.74.0, `openvibe-shared` v4.87.0, the same
  tags OpenVibe.Today pins.

## API

Everything is JSON under `/api/v1`; errors are `application/problem+json` with a `code`. A person is the `meme_at`
session cookie or `Authorization: Bearer <Network user token>`, verified offline with the Network JWKS. A write
made with the session cookie must come from `https://openvibe.meme` (403 `meme.cross_site`). A signed-in account
also gets per-actor minute/hour limits (`MEME_LIMITS_MINUTE`, `MEME_LIMITS_HOUR`).

| Route | What it does |
|---|---|
| `GET /entries?scope=&q=&status=&label=&kind=&sort=&window=&channel=&limit=&cursor=` | public entries; `scope=openvibe\|internet`; `q` matches title/summary/meaning/usage/slug; `label` is one L1 label; `sort=top&window=day\|week\|month` ranks by live uses (a cursor only on `newest`); `channel=<stream_id>` is Live's per-channel Memes block; `Cache-Control: public, max-age=60` |
| `GET /entries/:slug` | one entry with `origin` (a citation, or the web origin), `web_origin`, citations, `timeline`, `examples`, `spread`, `variations`, `related` and approved `revisions`, and the judge's `notes` (where it started, how people use it, the examples); a hidden proposal is 404 unless its author or staff |
| `GET /entries/:slug/revisions` | the approved revision history; staff also see pending and rejected ones |
| `GET /entries/:slug/series?days=30` | uses per UTC day, zero-filled, 1–365 days |
| `POST /entries` | signed in, same-origin: a proposal (`title`, `kind`, `scope`, `summary`, `meaning`, `usage`, `labels`, `origin`, `spread`, `variations`, `examples`, `related`) — born hidden with revision 1 pending (202); staff proposals are approved and public (201) |
| `POST /entries/:slug/revisions` | signed in: a proposed edit, stored as a revision with a field-by-field `diff`; a person's waits for review (202), staff's applies at once (201) |
| `POST /entries/:slug/revisions/:revision/review` | staff: `{ state: "approved"\|"rejected", note? }`; approving copies the change onto the entry, bumps its revision and re-indexes it |
| `GET /moderation/revisions?limit=` | staff: the pending revision queue with each entry's slug and title |
| `GET /trending?limit=` | public entries, `rising` first, then `peaked`, `classic`, `dead`; last use newest first |
| `GET /trends?window=day\|week&limit=` | rising Reddit posts with upvote velocity (from score samples), new template clusters and the public entries used in the window; `Cache-Control: public, max-age=120` |
| `POST /research` | signed in; `{ topic }` starts a deep-dive job (202 + `Location`); 503 without AI, 429 `meme.ai_budget`, 400 for a topic outside 2–300 characters |
| `GET /research/:id` | the job: queued/running/failed is visible to its author and staff; succeeded is public. Carries the source pack, facts, citations and the Markdown read |
| `POST /research/:id/entry` | the author or staff save a succeeded read as a public deep-dive entry (201, 200 when already saved) |
| `GET /entries/:slug/deep-dive` | the saved deep dive's full Markdown, numbered sources and citations |
| `GET /week` | this ISO week's candidates (public entries with a live use that week) and their vote counts |
| `POST /week/vote` | signed in, same-origin; `{ entry_id }`; upsert per (`week`, subject) — one vote a week |
| `GET /templates` | the caption templates with their caption counts and `layout` |
| `POST /generate` | signed in; `{ template_slug \| topic, lines? }`; researches current uses, writes captions, renders the template's layout as a PNG, stores it in Media and saves the caption. 201 returns `media_id`, `media_url`, `captions`, `template`, `labels`, `caption`; 503 `meme.ai_unavailable`/`meme.media_unavailable`; 429 `meme.ai_budget` |
| `POST /captions` | signed in; `{ template_id, lines, visibility? }`, 1–4 lines × 120 chars, blocked words refused |
| `GET /captions/:id` | one caption; a public read never returns the author's subject |
| `POST /entries/:slug/report` | signed in; `{ kind: "takedown"\|"correction", reason, note? }`, stored for staff |
| `GET /reports` | staff: the open reports |
| `GET /staff/candidates` | staff: the hidden candidates with the judge's score, its reason, the uses, the days and the channels |
| `GET /staff/candidates/:slug` | staff: one candidate — its judgement, its citations and its decision history |
| `POST /entries/:slug/publish` | staff: hidden → public; `409 meme.origin_gone` when the origin is not live |
| `POST /entries/:slug/hide` | staff: public → hidden; Search tombstone |
| `PATCH /entries/:slug` | staff: `{ title, kind, status, reason? }`; a status change writes `meme_status_events` and the edit is kept as an approved revision |

Validation refusals are `400 { code: "meme.invalid", message }`; a blocked caption is
`400 { code: "meme.blocked_words" }`; an edit that changes nothing is `409 meme.no_change` and a revision
already reviewed is `409 meme.revision_reviewed`. Other codes: `meme.sign_in_required`, `meme.staff_required`,
`meme.cross_site`, `meme.not_found`, `meme.template_not_found`, `meme.origin_gone`, `meme.rate_limited`.

## The judge

`server/jobs/judge.js` runs every 30 minutes (`MEME_JUDGE_INTERVAL_MS`), off under `MEME_DRILL`; tests call
`runOnce()`.

For every candidate nobody has judged yet it:

1. reads the entry's live citations and opens each one up — the chat lines around a chat message, the transcript
   lines around a VOD second (`server/ai/context.js`), because a joke only makes sense with its neighbours;
2. asks OpenVibe.AI to score it from 0 to 1 on whether it is a real meme, catchphrase or inside joke rather than
   everyday words that recur, and to write the entry from that material only;
3. stores the score, the reason and the written entry in `meme_judgements`;
4. applies the publish rule (`server/ai/gate.js`): score ≥ `MEME_JUDGE_MIN_SCORE` (0.75), at least
   `MEME_JUDGE_MIN_USES` (3) uses across at least `MEME_JUDGE_MIN_DAYS` (2) days or `MEME_JUDGE_MIN_CHANNELS` (2)
   channels, nothing denied, nothing that names looks, the entry complete, and a live origin citation;
5. publishes what cleared the bar and leaves the rest hidden, logging both as a status event with the score and
   the reasons.

The AI's text is never taken at its word: a title that names looks is dropped (the entry keeps the name it had),
every other field is repaired word by word with `noLooks`, and a field that still names looks — or that carries a
word from the deny list — keeps the entry hidden.

`node scripts/rejudge.js` runs one round over every hidden candidate and prints what was published and why;
`--dry-run` judges and reports without publishing, `--slug <slug>` judges only those.

## The encyclopedia

`node scripts/seed-classics.js` seeds the well-known internet memes; `node scripts/seed-templates.js` seeds the
caption templates. Neither starts the server.

The classics are read from Wikipedia's lists of Internet phenomena and memes (CC BY-SA) and from the categories
behind them, and every entry is finished from Wikidata (CC0): the Q id, the inception date and the picture. A
Commons picture is used only when its licence allows it (public domain, CC0, CC), and each entry keeps its credit,
its licence, its file page and the attribution of the text it was written from. The same AI pass writes the entry
— the title in natural case, the summary, where it started, how it spread, two or three example uses — and the
same publish rule decides what becomes public: an entry the AI scored under `MEME_ENCYCLOPEDIA_MIN_SCORE` (0.75),
or whose text names looks or carries a denied word, stays hidden for staff with its score.

Nothing is scraped from a site whose terms forbid it: Wikipedia, Wikidata and Wikimedia Commons only, each with
its User-Agent, paced per host.

## Trends (M3)

`server/reddit.js` reads `oauth.reddit.com` with this app's own OAuth2 client-credentials token and a User-Agent
that names it. The official API is the only Reddit path: no page, login or captcha wall is touched. Each run
reads `/r/<sub>/top?t=day` for the subreddits in `MEME_REDDIT_SUBREDDITS` (default r/memes, r/dankmemes,
r/MemeEconomy and r/wholesomememes), upserts the posts, appends a score sample, and dHashes the picture with
`sharp` (9×8 grayscale, 64-bit). Equal-enough hashes are grouped; a group of at least
`MEME_REDDIT_MIN_TEMPLATE_POSTS` distinct posts becomes a `meme_reddit_templates` row, and the picture is
uploaded to OpenVibe.Media when `OV_MEDIA_INTERNAL_URL` and the Network client secret are set. Without the Reddit
credentials the importer is off, and the read still serves whatever was recorded before.

`server/source-registration.js` creates the registry row in OpenVibe.Sources (`meme-reddit`, disabled, with its
terms and robots notes) once when `MEME_SOURCES_REGISTER=1` and `OV_SOURCES_INTERNAL_URL` are set; it never
overwrites an existing row. The row documents where the data comes from; Meme's importer owns the OAuth exchange.
## Analyse (M4)

`POST /api/v1/analyze` accepts exactly one of `url` (a public http(s) URL) or `media_id` (a `med_…` object). For a
Reddit URL it reads the post and its top comments through the official API (`server/reddit-read.js`); any other URL
is treated as the picture, and a Media id is resolved to `https://openvibe.media/o/<id>`.

It then makes two OpenVibe.AI runs: `pics.describe_image` (vision: alt, caption, tags) and `ai.extract` (one
structured answer: template, meaning, usage, labels, origin guesses with confidence, similar formats, comment
tone). Meme matches the answer against its own templates and public entries and never lets the model write an
entry. `MEME_AI_DAILY_CALLS` (200) and `MEME_AI_DAILY_BUDGET_USD` (5) cap the day; the calls are reserved before
the first run and the run's stated cost is recorded in `meme_ai_usage`. Reddit credentials are the same
`MEME_REDDIT_CLIENT_ID`/`MEME_REDDIT_CLIENT_SECRET` as the trends importer.
## Deep dives (M5)

`POST /api/v1/research` requires a signed-in person and a topic. The job runs `research.gather` (Wikipedia, the
topic's Fandom wiki, Wikidata, DeepSeek search, Commons/Openverse, as OpenVibe.AI implements it) and then
`ai.generate` with the numbered evidence pack. The prompt requires a 700–1400 word Markdown read whose every
paragraph ends with its source numbers. `groundedIssues()` checks that every body paragraph of at least ten words
has a `[n]` and that every `n` names a gathered source; a read that fails is stored `failed` with
`meme.research_ungrounded`, never published. The read is public once succeeded. Saving it creates a public entry
and `meme_deep_dives` keeps its full text for `GET /entries/:slug/deep-dive`.

Two calls per job are reserved against `MEME_RESEARCH_DAILY_CALLS` (40) and `MEME_RESEARCH_DAILY_BUDGET_USD` (5);
the calls and the runs' stated cost go in `meme_research_usage`. The job is in-process: a restart loses a queued
job (it stays `running` for the operator to see; there is no retry button yet).
## The generator (M6)

`POST /api/v1/generate` takes a template (`template_slug`, which is the id, slug or name) or a topic. It first runs
`research.gather` on how the format is actually captioned right now, then `ai.extract` for the lines and the L1
labels; with `lines` supplied the person's lines are used verbatim and only the labels come from the model. When a
topic alone is given, the model picks one of the configured templates.

`server/render-png.js` loads the template's `layout` (or a vertical fallback for a template without one), wraps
each line to its box, shrinks the font until it fits, converts the text to outlines with opentype.js (bundled
DejaVu Sans and DejaVu Sans Bold under `server/assets/fonts`, Bitstream Vera licence included), strokes the
outline and fills the text, then composites the SVG over the template artwork with sharp. The PNG is uploaded to
OpenVibe.Media as a public object; without Media the route answers 503 rather than returning an unstored picture.
The saved caption carries the labels and the `med_…` id. Two calls per request are reserved against
`MEME_GENERATE_DAILY_CALLS` (60) and `MEME_GENERATE_DAILY_BUDGET_USD` (5) in `meme_generate_usage`.

## The importer

`server/importer.js` runs every 30 minutes (`MEME_IMPORTER_INTERVAL_MS`), off under `MEME_DRILL`; tests call
`runOnce()`. It reads:

1. **Chat global history** — verbatim lines with ids and timestamps, each a usable citation.
2. **Chat global timeline** — a model paraphrase with no message id, so it is a discovery hint only; it never
   becomes a citation.
3. **Rundown topics and segments** — every quote is verbatim speech with `vod_id` and a VOD second, with `said_at`.
4. **VOD transcripts** — a segment is used only when the public VOD row gives a date; source part ids are
   canonicalised through OpenVibe.Video before a citation is stored.

A 3–6 word phrase that starts and ends with a content word, appears in at least `MEME_IMPORTER_MIN_USES` uses on at
least `MEME_IMPORTER_MIN_DAYS` different days, and is not a substring of a stronger phrase becomes one candidate
(at most `MEME_IMPORTER_MAX_CANDIDATES` per run). Its earliest use is `origin`, the rest are `use`, and the entry
is inserted `hidden`. Re-running enriches the existing slug with new uses and an extended first/last range; it
never creates a duplicate and never publishes. Uses naming the deny list are dropped before anything is written.

## Citations and re-verification

`server/reverify.js` runs daily (`MEME_REVERIFY_INTERVAL_MS`), off under `MEME_DRILL`. Each citation is read again:

- a Chat line is looked up in `GET /api/chat/global/history?before=<timestamp+1m>&limit=500`; a missing id (or a
  deleted message) is `gone`/`hidden`;
- every other citation's canonical URL is fetched; 404/410 → `gone`, 401/403 → `hidden`, 2xx/3xx → `live`;
- a redirect to a joined VOD updates `vod_id`, `offset_seconds` and `url`;
- an entry whose origin is no longer `live` is hidden (`revision` +1) and a Search tombstone is queued.

A transient 5xx is recorded and changes nothing: a hiccup must not erase a real citation.

## Search

`server/search.js` builds one `search.index-document@1` for each public entry: owner `meme`, type `entry`, id
`mem_…`, revision = the entry's `revision`, canonical page `${BASE_URL}/m/<slug>`, title/summary/body (the
verbatim quotes as plain text), facets `kind`/`status`/`source`, authorship `ai_assisted`, and one provenance
reference per live citation. Publishing or editing queues `meme.index_document.upserted`; hiding, deleting or
losing the origin queues `meme.index_document.deleted` (a tombstone wins over an older revision). Rows live in
`meme_outbox` in the same transaction as the entry change and wait for the `search.document.write` grant; the relay
is deliberately not part of v1. The `search-feed` recipe (Work, Help, Rent, Quest) is followed: a document from one
row, a sequencer revision in the row, a tombstone when the page is no longer public.

## Pages

All server-rendered through the OpenVibe Frame (`openvibe-shared/shell`), readable without JavaScript, with semantic
HTML and stable `mm-` ids/classes. Public pages are `public, max-age=60` with `Vary: Cookie`; a page drawn for a
signed-in person is `private, no-store`.

| Page | What it is |
|---|---|
| `/` | trending, meme of the week, the generator teaser |
| `/m/:slug` | one entry: origin with its citation link, the use timeline, examples, and a report form when signed in |
| `/week` | the ballot (`POST /week/vote`) |
| `/make` | the generator form: template, 1–4 lines, a server-rendered preview (`GET /make`), save (`POST /make` → 303 `/c/:id`) |
| `/c/:id` | one saved caption, the lines over the template image |
| `/developers` | the API, the Search document, the importer's sources |
| 404 | the not-found page |

`public/css/meme.css` and `public/js/meme.js` are one-comment placeholder files: the pages are complete without
them, and the main session designs them. The templates' images are local data-free SVG placeholders (or an
`openvibe.media` object when staff add a real one). `robots.txt`, `sitemap.xml`, `llms.txt` and `llms-full.txt` list
the public pages and every public entry.

## The first proof

`scripts/seed-proof.js` reads the live public APIs and creates **one hidden entry**:

- slug `cozmo-offline`, title `Cozmo is offline`, kind `joke`, status `classic`, visibility `hidden`;
- origin: Chat message **86957** (2026-10-28 00:11:53, “your Cozmo ain’t online yet”);
- use: VOD **6025** at **1541 s** — the canonical target of `/v/6026?t=864` (source part 6026 at 864.08 s), quote
  “but yeah and Cosmo is broken now…”;
- summary AI-written and stored as written (no looks filter); `first_seen_at`/`last_seen_at` from the two citations.

It never publishes. A re-run leaves the existing entry and adds only a citation that is not already there. VOD
5709 and clip 483 are refused before anything is written.

## Run and test

```sh
npm install
npm test                 # PGlite; every test file in its own process, no network needed
npm run test:pg          # the same through PostgreSQL + PgBouncer (openvibe-sdk scripts/test-services.sh up)
OV_ALLOW_SUITE=1 npm test
npm start                # PORT 5120, loopback; DATABASE_URL or an embedded PGlite in development
node scripts/seed-proof.js   # the first proof, hidden, from the live public APIs
node scripts/rejudge.js      # one judge round over every hidden candidate; prints what was published
node scripts/seed-classics.js  # the encyclopedia, from Wikipedia and Wikidata
node scripts/seed-templates.js # the caption templates, from Wikimedia Commons
```

The tests boot the app with a mock Network, an OpenVibe.AI stand-in, a Chat/Live/Video fixture server, and a
temporary database: the migration, the importer's candidate and its canonical redirect, the deny list, L24 text
(no looks filter), the one-vote-a-week rule, the caption limits, staff publish/patch/hide, the Search document (validated against
`search.index-document@1`), the citation 404 → gone → hidden path, sign-in, the pages and cache headers, and the
account export/deletion over votes, captions and reports. The judge, the publish rule, the encyclopedia's
attribution and the templates' licences have their own files: `test/judge.test.js`, `test/encyclopedia.test.js`
and `test/templates.test.js`.

## Deploy

`deploy/systemd/openvibe-meme.service` (127.0.0.1:5120, `/etc/openvibe/meme.env`) and
`deploy/nginx/openvibe.meme.conf` (TLS, www → apex, `/auth/me` on the API zone, `/internal` and `/metrics` 404, a
forms zone for the POST routes). Not deployed by this change.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

<!-- versions:start -->
- openvibe-contracts: v0.234.0
- openvibe-sdk: v0.78.0
- openvibe-shared: v4.87.0
<!-- versions:end -->
