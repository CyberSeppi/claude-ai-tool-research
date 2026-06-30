# Design — User-Curated Seeds as a First-Class Feature

Date: 2026-06-30
Status: Approved — ready for implementation plan

## Context

Today the app shows a catalogue derived solely from the workflow output
(`data/raw-records.json`). The research workflow is non-deterministic
and sometimes drops legitimate tools between runs — Obsidian fell out
of the catalogue this morning, claude-mem fell out the run before.

A short-lived `data/seeds.json` overlay file was introduced this
morning (`9a71780`) as a CLI-only mechanism. It works but suffers from
two problems: it lives in the gitignored data tree, and curating a
record requires hand-editing JSON. This spec replaces it with a proper
in-app feature: an "Add Tool" button in the UI that calls a backend
endpoint, auto-fills the record fields by calling the GitHub REST API
or extracting from a homepage with the LLM, lets the user review, and
saves to a runtime-state seeds.json. Seeds and the workflow output are
merged in-memory on every API request.

## Decisions locked in before brainstorm

- **Storage:** `app/db/seeds.json` (alongside `flags.json`, in the
  db-volume that's already mounted read-write into the container).
- **Auto-fill:** maximum — user provides url and (optional) name;
  backend fills the rest.
- **Pipeline contract:** `raw-records.json` stays the workflow's
  write-output. `seeds.json` stays the user's write-output. **No
  merged file on disk.** The Hono backend merges in-memory on every
  GET.
- **Migration:** the existing `data/seeds.json` is deleted, the
  `merge-seeds.mjs` script is deleted, the `report:seed` npm script
  is removed. claude-mem stays only because the workflow already
  surfaces it; if it falls out of a future run, re-add via the UI.

## Decisions from the brainstorm

| | |
|---|---|
| Merge location | In-memory in `loadReport`, called per `GET /api/records` |
| API surface | Full CRUD: `POST /api/seeds`, `PATCH /api/seeds/:slug`, `DELETE /api/seeds/:slug`, plus `POST /api/seeds/enrich` for the preview step |
| UI entry point | "+ Add Tool" button in the toolbar, opens a modal |
| Modal flow | Two-stage: paste URL → click **Fetch** → editable preview → click **Save** |
| LLM extraction | Full: description, efficiency_gain, use_cases, category suggestion, free-tier check |
| Slug-collision UX | One row, seed wins, **⭐ curated** badge on the name |
| RAG indexing | Async (setImmediate) after POST returns; chat retrieval gets the new entry within seconds |
| Validation | name + url + category required; slug unique against seeds AND raw-records |

## Architecture

```
┌──────────────────────┐          ┌──────────────────────┐
│  raw-records.json    │          │ app/db/seeds.json    │
│  (workflow output,   │          │ (user-curated state, │
│   gitignored)        │          │  in db-volume)       │
└──────────┬───────────┘          └──────────┬───────────┘
           │                                  │
           └──────────────┬───────────────────┘
                          │
                          ▼
                ┌──────────────────────┐
                │  loadReport()        │  in-memory merge:
                │  in data.mjs         │  • seed wins on slug collision
                │                      │  • adds `curated: true`
                └────────┬─────────────┘  • re-sorts by stars desc
                         │
                         ▼
                ┌──────────────────────┐
                │ GET /api/records     │  unified view to UI
                └──────────────────────┘
```

## Modules

### `app/server/seeds.mjs` (new)

Storage layer for `app/db/seeds.json`. Same atomic-write pattern as
`flags.mjs` (write to `.tmp`, then `rename`).

Public functions:

```js
slugOf(record)                 // canonical slug — must match augment-github-meta.mjs
readSeeds(dbDir)               // → Seed[] (empty array when file missing)
writeSeedsAtomic(dbDir, seeds) // → void
addSeed(dbDir, seed)           // → { seed }; throws on slug collision
updateSeed(dbDir, slug, patch) // → { seed }; throws on missing slug
deleteSeed(dbDir, slug)        // → boolean
```

### `app/server/enrich.mjs` (new)

Auto-fill for the modal preview step. Two paths based on the URL host.

```js
enrichFromUrl({ url, name?, githubToken, llm, fetchImpl? })
  → {
      name, url, repo_url, category, description, efficiency_gain,
      use_cases, sources, confidence, free, free_check_reason,
      stars, stars_display, version, contributors
    }
```

- If `url` matches `https://github.com/{owner}/{repo}`:
  - REST-API: `/repos/{owner}/{repo}` → stars + description + topics + license
  - Plus existing helpers from `augment-github-meta.mjs`:
    `fetchVersion()`, `fetchContributors()`, `formatStars()` — refactor
    to be importable.
  - LLM is **not** called for github URLs (the repo description and
    topics are enough; description + efficiency_gain prefilled from
    repo description as a starting point for the user to edit).
- Else (non-github URL):
  - WebFetch the homepage HTML.
  - Single LLM call with a strict JSON schema asking for description,
    efficiency_gain, suggested category, use_cases, and an explicit
    free-tier boolean + reason.
  - `repo_url` stays null unless the homepage links to a github repo
    that the LLM identifies; in that case the github augment also
    runs and fills stars/version/contributors.

The free-tier check is informational only — the UI shows it as a
yellow banner when `free === false` so the user can override or
back out, but the backend does NOT block the save based on it. The
strict free-cost gate applies to the workflow's discover/verify
phases, not to user-curated entries; the user is assumed to have
read the page they're adding.

### `app/server/data.mjs` (modified)

`loadReport(dataDir)` becomes `loadReport(dataDir, dbDir)`. Reads
`raw-records.json` (workflow output), `app/db/seeds.json` (user
overlay), and `app/db/flags.json` (existing flags layer). Merges
them in-memory:

1. Build a slug → record map from raw-records.
2. For each seed: replace the matching slug, OR append. Tag the
   record `curated: true`. For non-null augment fields in the seed,
   the seed wins; for null fields, raw-records' values are kept.
3. Apply `flags` overlay (flagged, note) as today.
4. Sort by stars desc (null last).
5. Return `{ generated_at, records }`.

The function is the **single source of truth**. The CLI's
`report:build` still writes a `report.{json,md}` file for the
markdown export, but the running server reads the merged shape
in-memory from `loadReport`, not from the on-disk `report.json`.

### `app/server/app.mjs` (modified)

New routes added in this order so the existing routes are unaffected:

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/seeds/enrich` | `{ url, name? }` | `{ enriched: Seed }` (preview, not saved) |
| `POST` | `/api/seeds` | `{ name, url, repo_url?, category, description?, efficiency_gain?, use_cases?, sources? }` | `201 { seed }`, `400` on validation, `409 { existing: 'raw' \| 'seed' }` on slug collision |
| `PATCH` | `/api/seeds/:slug` | partial fields | `200 { seed }`, `404` if not a seed |
| `DELETE` | `/api/seeds/:slug` | — | `200 { deleted: true }`, `404` if not a seed |

POST behaviour after save:
- Atomic write of seeds.json.
- `setImmediate(() => indexRecord(seed))` — async RAG embedding so
  the chat retrieval picks it up within a few seconds. Errors from
  the indexer are logged, not propagated.
- Response returns the saved seed including all auto-augmented
  fields. UI invalidates the records cache and reloads.

`POST /api/seeds/enrich` is intentionally **separate** from
`POST /api/seeds` — it lets the modal preview, edit, and confirm
before any state changes.

The new endpoints are guarded behind a feature check: when `llm` is
null (boot-time failure), enrich for non-github URLs returns 503;
github-only enrich still works.

### `app/server/rag/index-one.mjs` (new helper or extension to backfill.mjs)

Wrapper that takes a single record, applies the same fields-chunk +
optional README-chunk pipeline as the boot-time backfill, and writes
into the embeddings store. Single-record path is just a fan-out of
the existing `runBackfill` loop body extracted into its own function:

```js
export async function indexRecord(rec, { client, store, config, fetchReadmeFn })
  // builds candidate chunks, embeds the ones missing from the store,
  // upserts. Same idempotency rules as the boot backfill (text_hash
  // gate).
```

### `app/web/AddToolModal.tsx` (new)

Two-stage modal. State machine:

```
idle → fetching → preview → saving → success
                          ↓
                        error
```

Stage 1 (idle): two fields — `url` and `name?`. **Fetch** button
calls `/api/seeds/enrich`. While loading: spinner + disable inputs.

Stage 2 (preview): editable form with all returned fields. Read-only
hint shows whether github augment or LLM extraction filled it.
Free-tier check appears as a small warning banner if `free === false`
("LLM thinks this might have a paid tier — keep going?"). **Save**
button calls `POST /api/seeds`. **Back** returns to idle without
losing the entered URL.

Stage 3 (saving): button spinner. On 409: inline error showing
existing → user can either edit the existing (DELETE-then-Add) or
cancel.

Success: close modal, show toast, parent invalidates `/api/records`.

### `app/web/columns.tsx` (modified)

In the Name cell, render a small ⭐ icon to the left of the link when
`record.curated`. Tooltip: "Curated record — added via 'Add Tool'."

### `app/web/DetailPanel.tsx` (modified)

If `record.curated`:
- Show **Edit** + **Delete** buttons in the action row.
- Show a small note below the title: "Curated record. Edits are
  saved to your local copy."

Edit re-opens AddToolModal pre-filled. Delete asks confirm, calls
DELETE, parent invalidates list.

Non-curated records: no edit/delete UI.

### `app/web/api.ts` (modified)

Add four helpers: `enrichTool(payload)`, `addTool(payload)`,
`updateTool(slug, patch)`, `deleteTool(slug)`. Each returns a typed
response; 4xx body is surfaced as an `ApiError` with code so the
modal can branch on `409 / existing: 'seed'` vs `409 / existing: 'raw'`.

## Schema

`app/db/seeds.json`:

```json
{
  "records": [
    {
      "name": "Obsidian",
      "url": "https://obsidian.md",
      "repo_url": "https://github.com/obsidianmd/obsidian-releases",
      "category": "companion-app",
      "description": "...",
      "efficiency_gain": "...",
      "use_cases": ["knowledge-tool", "note-taking", "rag", "free"],
      "sources": ["https://obsidian.md"],
      "confidence": "high",
      "stars": null,
      "stars_display": null,
      "version": null,
      "contributors": null,
      "added_at": "2026-06-30T13:55:00Z",
      "updated_at": "2026-06-30T13:55:00Z"
    }
  ]
}
```

Top-level `blacklist` is dropped — feature wasn't used. Adds two
metadata fields `added_at` / `updated_at` for future UI sorts.

## Validation (POST)

| Field | Required | Validation |
|---|---|---|
| `url` | yes | must parse as http(s) URL |
| `name` | yes | non-empty string, ≤ 255 chars |
| `category` | yes | one of `plugin-skill \| mcp-server \| token-tool \| companion-app` |
| `repo_url` | no | if set, must be a github URL |
| `description` | no | ≤ 5000 chars |
| `efficiency_gain` | no | ≤ 1000 chars |
| `use_cases` | no | string array, ≤ 20 entries |
| `sources` | no | URL array |

Slug uniqueness: compute `slugOf(payload)`. If a seed with that slug
exists → `409 { existing: 'seed' }`. If a raw-records record with
that slug exists → `409 { existing: 'raw' }`. Frontend uses the
existing-field to show "this came from the crawler" vs "you already
curated this".

## RAG indexing flow

POST `/api/seeds` writes seeds.json, returns 201, schedules
`setImmediate(() => indexRecord(...))`. The single-record indexer:

1. Builds candidate chunks (1 fields chunk + N readme chunks for
   github URLs with GITHUB_TOKEN; just fields for homepage-only).
2. For each chunk, `hasChunkWithHash` decides skip vs embed.
3. Embed via existing `EmbeddingsClient.embedBatch`.
4. Upsert chunks.

Errors logged via `console.warn`. No retry — next container boot's
backfill will pick up anything missed.

PATCH `/api/seeds/:slug`: same indexer is called. Drift-detection
(`text_hash` gate, already implemented) handles re-embedding
automatically; unchanged chunks are skipped.

DELETE `/api/seeds/:slug`: chunks are NOT removed synchronously.
Next container boot's prune step deletes them (boot-time
`listRecordIds` - `currentIds` = stale, already implemented).

## Migration

On the first deploy of this feature:

1. `data/seeds.json` deleted from git (was committed in `9a71780`).
2. `.claude/skills/efficiency-research/scripts/merge-seeds.mjs`
   deleted.
3. `package.json`: `report:seed` script removed.
4. `.gitignore`: the protective comment about `data/seeds.json`
   removed (no longer relevant).
5. README & SKILL.md updated to describe the new flow.

The claude-mem entry that lived in the old data/seeds.json simply
disappears. The current workflow already surfaces claude-mem
(85k stars), so it stays in the catalogue via raw-records.json.

## Testing

| Test file | What |
|---|---|
| `app/server/seeds.test.mjs` (new) | `slugOf` parity with augment script; add/update/delete; slug-collision; atomic write doesn't leave `.tmp` |
| `app/server/enrich.test.mjs` (new) | github path with mocked fetch returns a real-looking record; homepage path with mocked LLM returns the structured fields; LLM rejects non-JSON gracefully |
| `app/server/data.test.mjs` (extended) | `loadReport(dataDir, dbDir)` merges seeds with raw-records; seed wins on collision; curated:true tag is set; sort order preserved |
| `app/server/app.test.mjs` (extended) | new endpoint shapes; 400 on missing required fields; 409 with `existing` field on slug collision; PATCH updates only the patch fields; DELETE removes seed |
| `app/web/AddToolModal.test.tsx` (new) | state-machine transitions; preview-then-save flow; error rendering on 409 |

## Out of scope

- Multi-user concurrency. The app is single-user local.
- Edit history / undo. Last write wins.
- LLM-graded sanity checks of curated descriptions. User reviews
  the preview.
- Bulk import (CSV / JSON paste).
- Sort-by-added-date. The existing stars-desc sort is enough; the
  curated badge makes user-added records easy to scan.

## Risk

- **Schema drift** between seeds.json shape and raw-records shape.
  Mitigation: `seeds.mjs` carries a TypeScript-style JSDoc typedef
  that the test compares to a sample raw record; CI test fails on
  drift.
- **slug-function drift** between `seeds.mjs`, `augment-github-meta.mjs`,
  and `backfill.mjs`. Mitigation: extract `slugOf` to a single
  shared module imported by all three, OR document the canonical
  formula in a code-block at the top of each file (the brainstorm
  picked the latter for now — single shared module is a follow-up
  cleanup).
- **Async RAG indexer firing during boot backfill** — race on the
  same store. The store uses SQLite + WAL, which serialises writes
  safely. The indexer's chunks may briefly miss in retrieval until
  the embed completes; acceptable trade-off for non-blocking POST.
