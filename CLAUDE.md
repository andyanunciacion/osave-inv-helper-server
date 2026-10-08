# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Backend API for a supermarket inventory/delivery-receipt system. Express + TypeScript, backed by Supabase (Postgres). This is a standalone server repo — the frontend (Next.js) lives in a separate repository and talks to this API over HTTP; there is no shared types package, so response shapes have to be kept in sync by hand (see "Contract docs" below).

## Commands

```bash
npm run dev      # tsx watch src/index.ts — dev server with reload
npm run build    # tsc — compiles src/ to dist/
npm start        # node dist/index.js — run the compiled build
npm test         # vitest run — receipt-parser accuracy against real receipt photos
```

No lint tooling is configured yet. Tests live in `test/` (outside `src/`, so `tsc` doesn't compile them). `test/receipt-parser.test.ts` scores the parser field-by-field against hand-transcribed ground truth (`test/fixtures/receipts.expected.ts`) for real receipt photos, using Vision word geometry saved once to `test/fixtures/vision/*.json` — no Vision calls at test time. Its thresholds are a ratchet: tighten them when the parser improves, never loosen them to get a change through. To add a photo: `npx tsx scripts/capture-vision-fixtures.ts <image-dir> test/fixtures/vision` (one billed Vision call per new image), then transcribe it into `receipts.expected.ts` — the self-check there (row arithmetic + printed footer totals) catches transcription slips.

Environment: copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (from a Supabase project). `PORT` defaults to 4000.

Database schema: `supabase/schema.sql` is not wired into any migration tooling — run it manually against a Supabase project's SQL editor (or `psql`) to create/update tables. There's no Supabase CLI project linked yet.

## Contract docs — read before changing API shapes

- `AI_DOCS/main-file.md` — the domain/business-rules doc (data model, duplicate-detection rules, search grouping semantics, phased roadmap). This is the source of truth for *why* the code behaves the way it does.
- `AI_DOCS/frontend-contract.md` — documents the exact request/response shapes the frontend repo already expects (it was prototyped against an in-memory mock before this backend existed). **Any change to a route's response shape must stay in sync with this doc** — there's no compiler to catch drift across repos.

`main-file.md` §10 lays out a phased roadmap (manual entry/search, then OCR, then offline/PWA, then realtime sync). The patterns described below apply across all of those phases, not just whatever's implemented today — as OCR, offline queueing, or realtime land, extend the existing router/validator/schema patterns rather than treating this doc as describing a throwaway early version. As of now, routes and validators assume manually-typed numeric input (not yet the string-typed OCR draft shape from `frontend-contract.md` §6) — check the actual route files for current coverage rather than trusting a phase label here to stay current.

## Architecture

`src/index.ts` is the only entry point: it mounts four routers under `/api` (`stores`, `deliveries`, `search`, `ocr`) plus a `/health` check. Each route file in `src/routes/` talks directly to Supabase via the client in `src/lib/supabase.ts` (service-role key — this server is trusted, not RLS-scoped) — there's no repository/service layer in between.

**Data model** (`supabase/schema.sql`, mirrors `main-file.md` §4): `stores` → `deliveries` (PK `delivery_code`, sourced from the receipt's printed "Inv. Tran. No.") → `delivery_items`. Two duplicate-detection layers matter for anyone touching `deliveries.ts`:
- Re-uploading the same `delivery_code` conflicts on the `deliveries` primary key itself — caught as a Postgres `23505` error.
- Within a delivery, item uniqueness is enforced via a **generated column** (`delivery_items.dedupe_key`, computed as `item_code` or else `name:<lowercased trimmed item_name>`), not `item_code` directly — this lets `item_code` stay `null` (matching the frontend's `DeliveryItem.item_code: string | null`) while still catching name-only duplicates at the DB level.

**Delivery creation (`POST /api/deliveries`)** always tries a single bulk insert of all items first; only on a `23505` conflict does it fall back to inserting items one-by-one, so a duplicate item doesn't fail the whole batch (per `main-file.md` §5 rule 5) but the common case (no duplicates) stays a single round trip. The response's `status` field (`"success" | "duplicate_delivery" | "partial"`) is the only signal the frontend uses — HTTP status stays 200 even on a domain-level rejection, per `frontend-contract.md` §2.

**Search (`GET /api/search`)** branches into two entirely different query shapes based on whether `q` is present, mirroring two separate frontend hooks:
- `q` present → `mode: "grouped"`: groups results by `delivery_code`. An exact (case-insensitive) match on `delivery_code` short-circuits to a single auto-expanded group with every item; any other match returns only the matching item rows per group, sorted by `item_code`. Paginated 15 groups/page.
- `q` absent, date/range present → `mode: "unified"`: a flat, ungrouped list of items across every delivery in range, each carrying its own `delivery_date`, sorted by date desc then `item_code`. Paginated 50 items/page. This mode exists because a date-only search means "what came in that day," not "which deliveries arrived" (`main-file.md` §6).

Both search modes, plus `GET /api/deliveries/recent`, do their grouping/sorting/pagination **in application code** (fetch matching rows, then sort/slice in JS) rather than in SQL, because `store_code` is denormalized onto `delivery_items` but `delivery_date` lives only on `deliveries` — joining and paginating that cleanly in one PostgREST query wasn't worth it at this project's scale (a handful of stores, a few concurrent users). If usage ever grows past that, this is the first place to revisit.

**OCR (`POST /api/ocr`)** sends the photo to Google Cloud Vision and parses it in `src/lib/receipt-parser.ts` from *word bounding boxes*, not `fullTextAnnotation.text` — Vision emits table cells column-by-column, so the plain text has no row structure, and the photos are tilted/curled (the tilt differs by ~5° between the left and right of one page), so rows are rebuilt by linking neighbouring words and then pairing each row's left half (SAN + description) with its right half (unit/qty/price/total). Don't "simplify" this back to splitting text on whitespace or to a single global rotation. Cells Vision can't read come back as `""` unless they can be *derived*, never guessed: staff strike through Qty/UOM while checking a delivery, so `reconcileItem` fills cells from the row's printed arithmetic (`Total = Qty × Unit/Box × Sales Price`, Qty must come out a whole number) and `ocr.ts` from the store's previous delivery of the same item — every filled cell is listed in the item's `inferred` array so the review screen marks it. A row that can't be made to add up is returned as read. Handwritten notes after the description are stripped from `item_name` (low Vision confidence + leading dash) and flagged via `has_annotation`; quantity stays the *printed* value by product decision. Every request costs a Vision call, so it's rate-limited (`OCR_RATE_LIMIT_PER_MINUTE`, `OCR_DAILY_LIMIT`) and validates its input before calling Vision. It also rejects a receipt whose "To" store code doesn't match the submitted `store_code` (409), and `POST /api/deliveries` re-checks that.

`store_code` is normalized (trim + uppercase) via a zod `.transform()` in every validator that accepts one (`src/validators/delivery.ts`, `src/routes/stores.ts`), backed by `src/lib/normalize.ts` — this exists because the frontend does the same normalization client-side and an inconsistently-cased QR code could otherwise fork a store's data across rows.

The project uses `"type": "module"` with `moduleResolution: "NodeNext"`, so relative imports in `src/` require explicit `.js` extensions (e.g. `from "../lib/supabase.js"`) even though the source files are `.ts`.

## Conventions for new routes/handlers

- **Validate at the boundary, infer the type from it.** Every route handler parses `req.body`/`req.query` with a zod schema from `src/validators/` before touching anything else, and uses `z.infer<typeof schema>` rather than a hand-written interface — don't add a parallel TypeScript type that can drift from the schema. Put any cross-field normalization (like `normalizeStoreCode`) in the schema itself via `.transform()`, not as a manual step after parsing.
- **Supabase calls return `{ data, error }`; check `error` explicitly, don't wrap in try/catch.** The Supabase client doesn't throw on query failures, so the codebase's pattern is `if (error) return res.status(...).json(...)` right after each call. Keep using that — a stray `try/catch` around Supabase calls won't catch anything and just adds noise.
- **Map known Postgres error codes to domain responses; don't let them fall through as generic 500s.** `23505` (unique violation) is the one that recurs here (duplicate delivery, duplicate item) and already has handling to copy from. If a new table/constraint introduces a new failure mode worth surfacing distinctly (e.g. `23503` FK violation), branch on `error.code` the same way rather than returning `{ error: "internal_error", message: error.message }` for everything.
- **Never forward raw Supabase error objects to the client.** Only `error.message` goes into a response body — not `.details`/`.hint`, which can leak schema/query internals.
- **Keep route files one-resource-thin.** Handlers talk to Supabase directly; only pull logic out into `src/lib/` when it's genuinely shared across routes (e.g. `normalize.ts`). Don't introduce a repository/service abstraction layer for its own sake at this scale.
- **Response shape is dictated by `frontend-contract.md`, not REST convention.** Don't rename fields, flatten nested objects, or change status-code-vs-body-status conventions "for consistency" — if a shape looks odd (e.g. 200 on a domain-level rejection), it's almost certainly intentional and documented there. Update that doc in the same change if a shape genuinely needs to move.
- **Read env vars once, at module load, and fail fast.** Follow `src/lib/supabase.ts`'s pattern (throw immediately if a required var is missing) instead of scattering `process.env.X` reads through handlers.
- **New routers get mounted in `src/index.ts` and, if they share a path prefix with an existing param route (like `:delivery_code`), registered before it** — see the `/recent` vs `/:delivery_code` ordering in `deliveries.ts`.
