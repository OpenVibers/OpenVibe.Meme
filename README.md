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
  and `quote_hash` is its sha256. A summary is AI-written and passes `noLooks`; if it names looks it is replaced by
  the title. Verbatim quotes are never rewritten.
- **Candidates stay hidden.** `server/importer.js` reads public Chat/Live APIs only, finds a 3–6 word phrase used at
  least twice on two different days, attaches citations and inserts the entry `hidden`. It never publishes. A staff
  person (Network role `global_mod` or above) publishes it with `POST /api/v1/entries/:slug/publish`.
- **The citation is checked again.** A daily job reads every public citation URL; a 404/410 marks it `gone`, a
  401/403 marks it `hidden`, and an entry whose origin is gone is hidden (revision +1, Search tombstone).
- **Meme of the week.** People vote once per ISO week; a second vote changes the choice, never adds a ballot.
- **The generator.** Pick a template, type 1–4 lines of at most 120 characters each and preview them as HTML text
  over the image; a caption is stored as text lines, never as a rendered image.

## Owns

| Table | Holds | Migration |
|---|---|---|
| `meme_entries` | `mem_` + ULID, unique slug (`/m/<slug>`), title, kind `joke\|catchphrase\|bit\|meme\|saga`, AI summary, status + `status_since`, first/last seen, visibility `public\|unlisted\|hidden`, `revision` (+1 on every change), timestamps | `migrations/0001_initial.sql` |
| `meme_citations` | entry, role `origin\|use\|example`, source service/type/id, stream/VOD/clip/message ids, canonical VOD `offset_seconds`, verbatim `quote_text`, `quote_hash`, canonical `url`, `observed_at`, `source_status` `live\|hidden\|gone` | `0001_initial.sql` |
| `meme_status_events` | every status change: from, to, reason, who, when | `0001_initial.sql` |
| `meme_votes` | (`week` `YYYY-Www`, `subject`) → entry; one vote a week | `0001_initial.sql` |
| `meme_templates` | id, name, `image_url` (openvibe.media or a local data-free placeholder), `box_count`, source, license; three placeholders seeded | `0001_initial.sql` |
| `meme_captions` | `mcp_` + ULID, subject, template, `lines` jsonb (1–4 plain-text lines), visibility, created | `0001_initial.sql` |
| `meme_reports` | `mrp_` + ULID, entry, subject, kind `takedown\|correction`, reason, note, status | `0001_initial.sql` |
| `meme_outbox` | Today's outbox shape: fixed `evt_` id, topic, JSON payload, attempts, last error, claim/backoff lease — the Search document queue | `0001_initial.sql` |
| `account_data_events` | openvibe-sdk/account-data's export/deletion receipts | `0001_initial.sql` |
| `telemetry_samples` | aggregated request telemetry, pruned after 14 days | `0001_initial.sql` |

## Does not own

- **Chat, Live and the VODs** — OpenVibe.Chat and OpenVibe.Live. Meme reads their public history, Rundown and
  transcripts. It never reads a private VOD, never uses a service grant in v1, and never cites VOD **5709** or clip
  **483** (the fixed deny list).
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
- **OpenVibe.Events** — account deliveries: `MEME_EVENTS_SECRET`, `MEME_EVENTS_URL`, `MEME_EVENTS_ENDPOINT`.
- **PostgreSQL** — `DATABASE_URL` (through PgBouncer) and `DATABASE_DIRECT_URL` (migrations); embedded PGlite in
  `MEME_PGLITE_DIR` for development.
- **Valkey** — optional `VALKEY_URL`, `VALKEY_PREFIX` (readiness lists it; the limits in v1 count in-process).
- **Packages** — `openvibe-contracts` v0.229.0, `openvibe-sdk` v0.70.0, `openvibe-shared` v4.45.0, the same
  tags OpenVibe.Today pins.

## API

Everything is JSON under `/api/v1`; errors are `application/problem+json` with a `code`. A person is the `meme_at`
session cookie or `Authorization: Bearer <Network user token>`, verified offline with the Network JWKS. A write
made with the session cookie must come from `https://openvibe.meme` (403 `meme.cross_site`). A signed-in account
also gets per-actor minute/hour limits (`MEME_LIMITS_MINUTE`, `MEME_LIMITS_HOUR`).

| Route | What it does |
|---|---|
| `GET /entries?limit=&cursor=&kind=&status=` | public entries, newest first; opaque keyset cursor; `Cache-Control: public, max-age=60` |
| `GET /entries/:slug` | one entry with `origin`, every `citation`, the use `timeline` and `examples`; a hidden one is 404 unless staff |
| `GET /entries/:slug/series?days=30` | uses per UTC day, zero-filled, 1–365 days |
| `GET /trending?limit=` | public entries, `rising` first, then `peaked`, `classic`, `dead`; last use newest first |
| `GET /week` | this ISO week's candidates (public entries with a live use that week) and their vote counts |
| `POST /week/vote` | signed in, same-origin; `{ entry_id }`; upsert per (`week`, subject) — one vote a week |
| `GET /templates` | the caption templates with their caption counts |
| `POST /captions` | signed in; `{ template_id, lines, visibility? }`, 1–4 lines × 120 chars, blocked words refused |
| `GET /captions/:id` | one caption; a public read never returns the author's subject |
| `POST /entries/:slug/report` | signed in; `{ kind: "takedown"\|"correction", reason, note? }`, stored for staff |
| `GET /reports` | staff: the open reports |
| `POST /entries/:slug/publish` | staff: hidden → public; `409 meme.origin_gone` when the origin is not live |
| `POST /entries/:slug/hide` | staff: public → hidden; Search tombstone |
| `PATCH /entries/:slug` | staff: `{ title, kind, status, reason? }`; a status change writes `meme_status_events` |

Validation refusals are `400 { code: "meme.invalid", message }`; a blocked caption is
`400 { code: "meme.blocked_words" }`. Other codes: `meme.sign_in_required`, `meme.staff_required`,
`meme.cross_site`, `meme.not_found`, `meme.template_not_found`, `meme.origin_gone`, `meme.rate_limited`.

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
- summary AI-written and `noLooks`-cleaned; `first_seen_at`/`last_seen_at` from the two citations.

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
```

The tests boot the app with a mock Network, a Chat/Live/Video fixture server, and a temporary database: the
migration, the importer's candidate and its canonical redirect, the deny list, `noLooks`, the one-vote-a-week rule,
the caption limits, staff publish/patch/hide, the Search document (validated against
`search.index-document@1`), the citation 404 → gone → hidden path, sign-in, the pages and cache headers, and the
account export/deletion over votes, captions and reports.

## Deploy

`deploy/systemd/openvibe-meme.service` (127.0.0.1:5120, `/etc/openvibe/meme.env`) and
`deploy/nginx/openvibe.meme.conf` (TLS, www → apex, `/auth/me` on the API zone, `/internal` and `/metrics` 404, a
forms zone for the POST routes). Not deployed by this change.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

<!-- versions:start -->
- openvibe-contracts: v0.234.0
- openvibe-sdk: v0.70.0
- openvibe-shared: v4.45.0
<!-- versions:end -->
