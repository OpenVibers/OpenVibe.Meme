# Changelog

What changed in OpenVibe.Meme, newest first.

## Unreleased

- Public caption saves now queue a content-free `meme.caption.created` activity event in the same transaction; hidden and unlisted captions do not emit it. The Events relay sends it when configured.

- **The maker, second slice.** `/make` is a phone-first editor: template search, draggable and resizable caption
  boxes, crop and type/outline controls, emoji stickers, optional signed-out caption ideas from OpenVibe.AI's cheapest
  route, and PNG/GIF/MP4 downloads. Captions save their editor state as text and geometry, never as a rendered image.
  Member-uploaded templates go to OpenVibe.Media and stay hidden until staff approve them; migration 0010 adds the
  moderation and editor-state columns above 0009. Public templates, entries and the render request are checked against
  `meme.template@1`, `meme.entry@1` and `meme.render@1` (contracts v0.373.0). Saved captions gain copy/native share,
  Community, Pics and Chat links, and a render endpoint.
- **One title, one public entry.** `meme_entries.title_key` is the title lowercased with quotes/punctuation stripped
  and whitespace collapsed; a trigger keeps it current and a partial unique index on `(kind, title_key)` stops two
  public entries sharing a title. The importer upserts on the key instead of the slug, so a second phrase that the
  judge titles the same way enriches the entry that exists. Migration 0009 merges the existing public duplicates into
  the oldest entry, moves their citations, votes, reports, judgements, origins, spread, examples, variations, related
  rows and revision history, records the merge in the kept entry's history, and turns the old slug and id into 301
  redirects (`meme_entry_redirects`).
- **The hidden duplicates 0009 left.** The old candidate miner kept inserting hidden candidates after 0009: it
  deduped the phrase's slug before the judge rewrote the title, so a new window of the same line became a hidden row
  with the public entry's title and its own citations — and one took back `close-and-enemies`, hiding the 301.
  Migration 0011 merges every hidden entry that shares a public entry's `(kind, title_key)` into the public keeper,
  moves its citations, votes and history, and turns its old slug/id into 301s. A redirect now wins over a hidden row
  for readers (staff and the author still see it), and a new entry can never take a merged slug back.
- **Tests.** Two ingests of one normalised title stay one entry; 0009 moves everything and old addresses 301; 0011
  merges a hidden duplicate and the merged slug still 301s.

## 0.1.0 — 2026-10-28

The first version: the open meme database, rebuilt with AI.

- **Entries and citations.** `meme_entries` with kind, AI summary (`noLooks`; a look-naming summary becomes the
  title), status and `meme_status_events`, first/last seen, visibility and a revision that goes up on every change.
  `meme_citations` carries a verbatim quote, its sha256, the canonical VOD second and URL, and
  `live|hidden|gone`. VOD 5709 and clip 483 are a fixed deny list: never cited, kept or rendered.
- **The importer.** Every 30 minutes (off under `MEME_DRILL`) it reads Chat's public history and timeline, Live's
  Rundown and VOD transcripts, finds a 3–6 word phrase in at least two uses on two different days, follows
  OpenVibe.Video's joined-VOD redirect, and inserts one hidden candidate with an origin and its uses. It never
  publishes. A second run enriches the same slug, never duplicates it.
- **Re-verification.** Daily, every citation URL is read again: 404/410 → `gone`, 401/403 → `hidden`, a redirect
  updates the canonical VOD second. An entry whose origin is gone is hidden and tombstoned. A transient 5xx changes
  nothing.
- **The API.** Public cursor-paged `GET /entries`, one entry with its citations and timeline,
  `GET /entries/:slug/series?days=30` zero-filled per UTC day, `GET /trending`, `GET /week`, `POST /week/vote` (one
  ballot per week and person), `GET/POST /templates` and `/captions` (1–4 lines × 120 characters, blocked words,
  text only), `GET /captions/:id`, `POST /entries/:slug/report`, and staff `publish|hide|PATCH` behind Network role
  `global_mod`+ plus `GET /reports`.
- **The week and the generator.** ISO `YYYY-Www` weeks, candidate counts and the reader's own vote; a caption
  preview is server-rendered HTML text over a template image and a saved caption is its jsonb lines.
- **Search.** Each public entry is one `search.index-document@1` (owner `meme`, type `entry`, `/m/<slug>`, revision
  from the entry, provenance per citation) queued in `meme_outbox` in the same transaction; hiding writes a
  tombstone. The relay waits for the `search.document.write` grant.
- **The service.** Network sign-in as OAuth client `meme` (PKCE S256, `meme_at`/`meme_rt`/`meme_oauth`), truthful
  readiness, Prometheus metrics on loopback, discovery, deploy files, and server-rendered pages with stable `mm-`
  ids. `public/css/meme.css` and `public/js/meme.js` are one-comment placeholders for the main session.
- **The first proof.** `scripts/seed-proof.js` creates `cozmo-offline` hidden from Chat message 86957 and VOD 6025
  @ 1541 s (the canonical target of `/v/6026?t=864`), with its two citations and a noLooks-cleaned summary.
- **Tests.** Migration, importer, re-verification, deny list, noLooks, votes, captions, staff, Search document,
  SSO, pages/cache and account export/deletion, each in its own process on a temporary PGlite database with a mock
  Network and a Chat/Live/Video fixture server.
