# Backend — Left To Do

Reference doc for what's still open on this server repo, last re-checked
against the code on 2026-09-25 (branch
`12-update-upload-to-accept-multi-upload-of-delivery-receipt`). Companion to
`main-file.md` (business rules/roadmap) and `frontend-contract.md` (response
shapes) — this doc tracks *gaps*, not current behavior. Update it as items
get resolved rather than letting it go stale; delete a line once it's
actually done instead of marking it "done" here (git history is the record
of what shipped).

---

## 1. Release / deployment (do first)

- **Nothing has been released yet.** `production` is still at the initial
  configuration commit; every feature so far lives on `develop` (and `#12`,
  multi-page upload + `/api/ocr/reconcile`, is on its way there). The
  frontend's multi-upload flow already calls `/api/ocr/reconcile`, so the
  server must ship `#12` before or together with that frontend release.
- **Host not decided.** No deployment config (Dockerfile/Procfile/etc.)
  exists — scaffolding depends entirely on the target (Render/Railway/
  Fly.io/VPS/etc. all differ). Revisit this section once one is picked.
- **Set Express's `trust proxy` once the host is known.** Nearly every host
  puts the app behind a proxy; without it the per-IP OCR limiter sees the
  proxy's IP, so all users share one 30/minute bucket. Not set anywhere in
  `src/index.ts` today.
- **OCR rate limiting is in-memory** (`src/routes/ocr.ts`): counters reset on
  restart and aren't shared across instances. Fine for a single instance;
  needs a shared store (e.g. Redis) if the host ever scales out.
- **Check `OCR_DAILY_LIMIT` against real volume.** It's a server-wide cap of
  300 Vision calls per rolling 24 hours. A full delivery is ~25 pages, so
  that's roughly 12 full deliveries a day across *all* stores before OCR
  shuts off and staff have to type receipts manually.

## 2. OCR pipeline (`src/routes/ocr.ts`, `src/lib/vision.ts`, `src/lib/receipt-parser.ts`)

Status: working end-to-end on real photographed receipts, including a full
multi-page batch (with `/api/ocr/reconcile` filling a blocked store code from
a sibling page) and `PIECE`-unit rows. Word-geometry parsing (not
`fullTextAnnotation.text`, which Vision emits column-by-column) was verified
against the original sample pages: every parsed row lands in the right row,
and each page's sum of totals equals its printed "Total Value". Still open:

- **Still one warehouse template, one store.** Not yet tried on receipts
  from another store or another date, flat scans, or pages without the
  header band. Row grouping relies on the header labels (`SAN`,
  `Description`, `Unit`, `UOM`, `Qty`, `Sales`, `Total`) being readable and
  on the column order `SAN | Description | Unit/Box | UOM | Qty | Sales
  Price | Total`.
- **Rows where only Qty × Price is known stay blank.** Struck-through or
  watermarked cells are now filled from the row arithmetic (see CLAUDE.md),
  but when *both* Qty and Price (or Qty and Unit/Box) are unreadable the
  product is ambiguous — 4 of 211 sample rows. Item history fills Unit/Box
  when the store has received the item before. A page-level fill from the
  printed "Total Box" (one unknown Qty left on the page) was considered, but
  the Box/Pcs labels are rarely read and the bare numbers are noisy ("43" for
  Pcs 4 / Box 3), so it isn't done; the frontend just compares the totals.
- **Header dates on folded/tilted pages.** `delivery_date` comes back blank
  when the "Transaction Date" label is cut off or the photo is strongly
  tilted (14(1), 14(2) in the fixtures). `/api/ocr/reconcile` could fill it
  from a sibling page with the same printout timestamp, like it does the
  store code.
- A row whose SAN/description was unreadable but whose numbers were is
  returned with `item_code: ""` and `item_name: ""` (the frontend's
  `confirm()` drops blank-name rows, so the review screen has to surface
  these). A row with a description but no SAN, price or total is dropped as
  indistinguishable from page-footer noise.

## 3. Auth / access control

**Deliberately deferred for this MVP's scale** (2–3 trusted staff users), but
it becomes a real exposure the moment the server is deployed to a public URL
(§1). Right now the only access control on this API is the CORS origin
allowlist (`ALLOWED_ORIGINS`) — anyone who can reach the server directly
(not through a browser, so CORS doesn't apply) can read/write any store's
data, since the server always uses the Supabase service-role key with no RLS
policies and no session/API-key check of its own. A shared API-key header
checked in middleware would be the smallest meaningful step before going
public; revisit properly if the user base grows past a small trusted group.

## 4. Testing

Vitest is set up (`npm test`), covering `receipt-parser.ts` against 12 real
photos (see CLAUDE.md). Still uncovered:
- Delivery duplicate-detection (`POST /api/deliveries`) — the bulk-insert
  then per-row-fallback logic, in-batch row merging (`mergedItems`), and the
  `dedupe_key` generated-column behavior for code-less items.
- Search grouping/sorting math (`GET /api/search`) — the grouped-vs-unified
  branch, exact-vs-partial delivery-code match auto-expand logic, and
  pagination slicing, since it's all done in application code rather than
  SQL (see `CLAUDE.md`'s note on why).
- `/api/ocr/reconcile` — sibling matching by printout timestamp, and the
  ambiguous cases (no sibling, disagreeing siblings) staying blank.

## 5. Operational gaps

- No request logging (e.g. morgan/pino) — nothing to look at when debugging
  a production issue beyond the `console.error` in the global error handler.
- No CI pipeline (build/typecheck on push).

## 6. Deleting a confirmed delivery or item

Flagged as an open question in `main-file.md` §12, still unresolved for the
delete half. **Marked optional / nice-to-have, not blocking** — no delete
routes exist for `deliveries` or `delivery_items`. Quantity edits are
handled (`PATCH /api/deliveries/:delivery_code/items/:item_id`, audited via
`delivery_item_updates` — see `frontend-contract.md` §8). If delete gets
picked up: prefer soft-delete + an edit log over hard deletes, per the
original doc's own suggestion, for auditability — same pattern as the
quantity-edit history table.

## 7. Realtime sync (Phase 4, `main-file.md` §8)

Not started. No Supabase Realtime subscription exists anywhere in this repo.
Needed once multi-user concurrent editing actually matters — low priority
while usage is 2–3 people who rarely collide.

---

## Already handled (kept here only as context, not a to-do)

For anyone reading this later wondering why these *aren't* on the list:
- Both migrations in `supabase/migrations/` (`add_unit_count`,
  `add_delivery_item_updates`) have been applied to the Supabase project.
- Multi-page upload: `/api/ocr/reconcile` cross-checks store codes across
  pages of one receipt via the printed printout timestamp (`main-file.md` §5
  rule 8); the parser reads the timestamp and warehouse from the page footer
  first. Default `OCR_RATE_LIMIT_PER_MINUTE` raised to 30 so a ~25-page
  delivery fits in one batch.
- Global JSON error handling (404s, multer upload errors, malformed JSON
  bodies) — all failure paths return JSON instead of Express's default HTML
  error page.
- OCR upload mimetype validation — non-image uploads are rejected before
  hitting the Vision API.
- CORS origin allowlist (`ALLOWED_ORIGINS`).
