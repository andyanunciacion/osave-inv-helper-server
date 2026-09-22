# Backend — Left To Do

Reference doc for what's still open on this server repo, as of a full-codebase
scan on 2026-09-16. Companion to `main-file.md` (business rules/roadmap) and
`frontend-contract.md` (response shapes) — this doc tracks *gaps*, not
current behavior. Update it as items get resolved rather than letting it go
stale; delete a line once it's actually done instead of marking it "done"
here (git history is the record of what shipped).

---

## 1. OCR pipeline (`src/routes/ocr.ts`, `src/lib/vision.ts`, `src/lib/receipt-parser.ts`)

Status: working end-to-end on real photographed receipts. Word-geometry
parsing (not `fullTextAnnotation.text`, which Vision emits column-by-column)
was verified against 3 sample pages (+ 3 lower-quality re-compressed copies):
every parsed row lands in the right row, and each page's sum of totals equals
its printed "Total Value". Still open:

- **Tested on one receipt template only** (same warehouse system, same
  store, same day). Row grouping relies on the header labels (`SAN`,
  `Description`, `Unit`, `UOM`, `Qty`, `Sales`, `Total`) being readable and on
  the column order `SAN | Description | Unit/Box | UOM | Qty | Sales Price |
  Total`. Run a few more receipts (other stores, other dates, flat scans,
  pages without the header band, a `PIECE`-unit row) before trusting it
  broadly.
- **Vision misses cells; the parser leaves them blank rather than guessing.**
  Cells under the diagonal watermark or on glare (BOX, Qty, sometimes a price)
  come back missing, and white-on-grey text (`Total Box`, `Sales Price`) is
  often dropped. On the sample pages 20–40% of `unit`/`quantity`/`item_price`
  cells were blank. The printed relationship `Total = Qty × Unit/Box × Sales
  Price` (`main-file.md` §4) could fill one missing value per row, and the
  review screen should highlight blanks — neither is implemented.
- A row whose SAN/description was unreadable but whose numbers were is
  returned with `item_code: ""` and `item_name: ""` (the frontend's
  `confirm()` drops blank-name rows, so the review screen has to surface
  these). A row with a description but no SAN, price or total is dropped as
  indistinguishable from page-footer noise.
- **Run `supabase/migrations/20260921000000_add_unit_count.sql`** in the
  Supabase SQL editor before deploying this branch — every read/write of
  `delivery_items` now selects `unit_count` and will 500 until the column
  exists. The migration copies old `quantity` values (which were really
  "Unit/Box") into `unit_count` and leaves `quantity` as-is (a commented-out
  line clears it).
- The frontend needs the contract changes in `frontend-contract.md` (§1, §2,
  §6): `unit_count` on items/drafts, `store_code` in the `/api/ocr` upload, a
  new `store_mismatch` status and 409, multi-page appends, and a now-required
  `receipt_store_code` on save (the manual-entry form must include it too).
- The uncommitted files (`src/routes/ocr.ts`, `src/validators/ocr.ts`,
  `src/lib/vision.ts`, `src/lib/receipt-parser.ts`, plus the
  `@google-cloud/vision`/`multer`/`express-rate-limit` deps,
  `GOOGLE_APPLICATION_CREDENTIALS_JSON`/`OCR_*` env vars and the migration)
  still need committing — they're on the `3-tighten-the-cors-security`
  branch, which is otherwise unrelated to OCR.
- Rate limiting (`OCR_RATE_LIMIT_PER_MINUTE`, `OCR_DAILY_LIMIT`) is
  in-memory: counters reset on restart and aren't shared across instances.
  If the host ends up behind a proxy, set Express's `trust proxy` so the
  per-IP limit sees real client IPs.

## 2. Deleting a confirmed delivery or item

Flagged as an open question in `main-file.md` §12, still unresolved for the
delete half. **Marked optional / nice-to-have, not blocking** — no delete
routes exist for `deliveries` or `delivery_items`. Quantity edits are now
handled (`PATCH /api/deliveries/:delivery_code/items/:item_id`, audited via
`delivery_item_updates` — see `frontend-contract.md` §8). If delete gets
picked up: prefer soft-delete + an edit log over hard deletes, per the
original doc's own suggestion, for auditability — same pattern as the
quantity-edit history table.

## 3. Auth / access control

**Deliberately deferred for this MVP's scale** (2–3 trusted staff users).
Right now the only access control on this API is the CORS origin allowlist
(`ALLOWED_ORIGINS`) — anyone who can reach the server directly (not through
a browser, so CORS doesn't apply) can read/write any store's data, since the
server always uses the Supabase service-role key with no RLS policies and no
session/API-key check of its own. Revisit if the user base grows past a
small trusted group, or before exposing this server outside a private
network.

## 4. Realtime sync (Phase 4, `main-file.md` §8)

Not started. No Supabase Realtime subscription exists anywhere in this repo.
Needed once multi-user concurrent editing actually matters — low priority
while usage is 2–3 people who rarely collide.

## 5. Testing

No test tooling configured at all (`npm test` is a placeholder). Highest-value
things to cover first, if/when this gets picked up:
- Delivery duplicate-detection (`POST /api/deliveries`) — the bulk-insert
  then per-row-fallback logic, and the `dedupe_key` generated-column
  behavior for code-less items.
- Search grouping/sorting math (`GET /api/search`) — the grouped-vs-unified
  branch, exact-vs-partial delivery-code match auto-expand logic, and
  pagination slicing, since it's all done in application code rather than
  SQL (see `CLAUDE.md`'s note on why).

## 6. Operational gaps

- No request logging (e.g. morgan/pino) — nothing to look at when debugging
  a production issue.
- No deployment config (Dockerfile/Procfile/etc.) for wherever this Express
  server ends up running — **host is not decided yet.** Revisit this doc
  once that's picked; scaffolding config depends entirely on the target
  (Render/Railway/Fly.io/VPS/etc. all differ).
- No CI pipeline (build/typecheck on push).

---

## Already handled (kept here only as context, not a to-do)

For anyone reading this later wondering why these *aren't* on the list:
- Global JSON error handling (404s, multer upload errors, malformed JSON
  bodies) — added, all failure paths return JSON instead of Express's
  default HTML error page.
- OCR upload mimetype validation — non-image uploads are rejected before
  hitting the Vision API.
- CORS origin allowlist — done on the `3-tighten-the-cors-security` branch.
