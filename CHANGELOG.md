# Changelog

What changed in OpenVibe.Meme, newest first.

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
