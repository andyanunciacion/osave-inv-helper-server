# Backend — Left To Do

Reference doc for what's still open on this server repo, last re-checked
against the code on 2026-10-13 (branch `21-store-passcode-access` off
`develop` at `9875c89`; `npm test` 40/40 passing, `tsc --noEmit` clean).
Previous check: 2026-10-12.
Companion to `main-file.md` (business rules/roadmap) and
`frontend-contract.md` (response shapes) — this doc tracks *gaps*, not
current behavior. Update it as items get resolved rather than letting it go
stale; delete a line once it's actually done instead of marking it "done"
here (git history is the record of what shipped).

The frontend keeps its own list in
`osave-inv-helper-ui/AI_DOCS/frontend-left-to-do.md`. Its 2026-10-07
end-to-end browser pass ran against this server; what it found for the
backend is in §2 and §3 below.

---

## 1. Release / deployment

- **Nothing has been released yet.** `production` is still at the initial
  configuration commit (`ffeea90`); every feature lives on `develop`.
- **Host: Railway** (frontend on Vercel), starting on the free tiers. It has
  to stay one always-on instance, not serverless: the OCR and passcode
  limiters are in-memory, and a serverless body cap (~4.5MB) would undercut
  the 10MB photo limit the frontend's compression (#47) is tuned to. Deploy
  setup is in `#6` (README "Deployment", Node pinned via `engines`, CI); no
  `railway.json`, since Railway no longer accepts config files for new
  services. Before the first deploy:
  - Store 245 has a **test** passcode (set 2026-10-13 for the end-to-end
    check). Set the real one with `npm run store:passcode -- 245` before
    staff use it, and give any other store its own (§4) — a store without
    one is refused.
  - Set `TRUST_PROXY=1` on Railway (`src/index.ts`). Leave it unset locally.
  - Set `ALLOWED_ORIGINS` to the Vercel URL, and the Supabase/Google env vars.
  - Check what Railway's free tier allows (credit, sleeping): a sleeping
    server makes the first upload after a break slow.
- **OCR rate limiting is in-memory** (`src/routes/ocr.ts`): counters reset on
  restart and aren't shared across instances. Fine for a single instance;
  needs a shared store (e.g. Redis) if the host ever scales out.
- **Check `OCR_DAILY_LIMIT` against real volume.** It's a server-wide cap of
  300 Vision calls per rolling 24 hours. A full delivery is ~25 pages, so
  that's roughly 12 full deliveries a day across *all* stores before OCR
  shuts off and staff have to type receipts manually.

## 2. Correctness gaps

The 2026-10-08 code scan's gaps (1,000-row read cap, non-atomic writes,
non-UUID `item_id` 500s, OCR daily cap counting rejected uploads, unescaped
`%`/`_` in search) are fixed (`#17`, merged into `develop`). What's left:

- **Confirm the project's `max_rows` is at least 1000** (Dashboard →
  Settings → API). `selectAll` pages in slices of 1000 and treats a shorter
  slice as the last one. A lower cap would truncate again, silently.
- **Not paged, on purpose for now:**
  - The `deliveries`-table reads in search (one row per delivery). They'd
    need over 1,000 deliveries for one store in one date range. At that
    point the `.in("delivery_code", codes)` lists also get long enough to
    risk URL length limits, and the move to SQL pagination (CLAUDE.md's
    "first place to revisit") is due anyway.
  - `withItemHistory` in `ocr.ts`, which reads every past row of up to ~25
    item codes, newest first. If it's cut short, only the oldest rows are
    lost, so some rarely delivered items miss the fill and come back blank.
    Nothing gets filled wrongly.
- **A `*` in the search text still matches anything.** PostgREST turns `*`
  into `%` in `like`/`ilike` and has no way to escape it. `%`, `_` and `\`
  are escaped.

## 3. OCR pipeline (`src/routes/ocr.ts`, `src/lib/vision.ts`, `src/lib/receipt-parser.ts`)

Status: working end-to-end on real photographed receipts, including a full
multi-page batch (with `/api/ocr/reconcile` filling a blocked store code from
a sibling page) and `PIECE`-unit rows. Word-geometry parsing (not
`fullTextAnnotation.text`, which Vision emits column-by-column) was verified
against the original sample pages: every parsed row lands in the right row,
and each page's sum of totals equals its printed "Total Value". Still open:

- **Reconcile doesn't fill a blank Transaction date** (frontend browser pass
  2026-10-07). On the `14*` batch, `/api/ocr/reconcile` filled pages 2/3's
  store code from page 1 but left their `delivery_date` blank, so staff typed
  it on every page. The parser misses the date when the "Transaction Date"
  label is cut off or the photo is strongly tilted (14(1), 14(2) in the
  fixtures). Fill it from siblings with the same `printout_datetime`, the
  same way as the store code, and add a `delivery_date_inferred` flag
  (contract change; the frontend already marks inferred cells with a dashed
  outline).
- **Reconcile doesn't cross-check `delivery_code`.** Pages from one print run
  share an "Inv. Tran. No.". If one page misreads it (e.g. `ITPH1978G04`),
  saving that page creates a second, bogus delivery instead of appending to
  the real one. Siblings with the same `printout_datetime` and disagreeing
  codes should be flagged. Siblings with a blank code could be filled. Both
  options need a contract decision with the frontend.
- **Printed totals partly missed** (frontend browser pass). For `17.jpg` only
  `total_value` came back; `total_box` and `total_items` were blank although
  "Total Box: 8 / Total Item/s: 8" is clearly printed. `parseTotals` reads
  the bare number stack only when it holds exactly 3 numbers, or 2 on a page
  without PIECE rows, so a stack that Vision splits or partly drops is
  discarded. With only the value sum to compare, a wrong Qty passes the
  frontend's totals check. The `17.json` fixture can reproduce it offline.
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
- A row whose SAN/description was unreadable but whose numbers were is
  returned with `item_code: ""` and `item_name: ""` (the frontend's
  `confirm()` drops blank-name rows, so the review screen has to surface
  these). A row with a description but no SAN, price or total is dropped as
  indistinguishable from page-footer noise.
- `delivery_items.raw_ocr_text` and `deliveries.source_images` are never
  written. That's expected for the text-only pipeline, but either use them or
  note them as unused in `schema.sql`.

## 4. Auth / access control

Per-store passcodes are in (`frontend-contract.md` §10, `src/lib/store-auth.ts`):
every `/api` request needs the store code and that store's passcode, may only
touch that store's data, and wrong passcodes are rate-limited per IP. What's
still open:

- **Shared passcode per store, not per person.** Anyone who has a store's
  passcode is that store; there's no way to tell staff apart or revoke one
  phone (changing the passcode signs every phone out). Fine for 2–3 trusted
  staff. Real per-user accounts (e.g. Supabase Auth) if that ever changes.
- **The passcode is kept on the phone** (localStorage) so staff don't retype
  it. Anyone holding an unlocked phone with the app open has access.
- **The passcode lockout is in-memory**, like the OCR limits (§1): a restart
  resets it, and it's per instance.
- `uploaded_by` is saved as `null` on every delivery because the frontend
  never sends it (no reference in its `src/` outside types/tests; checked
  2026-10-08). The server stores it correctly when present. This needs a real
  identity source first (see the frontend list's Auth item).

## 5. Testing

Vitest is set up (`npm test`), covering `receipt-parser.ts` against 12 real
photos (see CLAUDE.md), passcode hashing, and the `requireStoreAccess`
middleware (Supabase mocked). Still uncovered:
- Delivery duplicate-detection (`POST /api/deliveries`): the
  `create_delivery` function's append/reject paths, plus the `dedupe_key`
  generated-column behaviour for code-less items. These were checked once
  against PGlite (Postgres in WASM) on 2026-10-08 with a throwaway script.
  Nothing in `npm test` covers them yet. `mergeDuplicateItems` is a pure function and the easiest
  start, but it isn't exported yet.
- Search grouping/sorting math (`GET /api/search`) — the grouped-vs-unified
  branch, exact-vs-partial delivery-code match auto-expand logic, and
  pagination slicing, since it's all done in application code rather than
  SQL (see `CLAUDE.md`'s note on why).
- `/api/ocr/reconcile` — sibling matching by printout timestamp, and the
  ambiguous cases (no sibling, disagreeing siblings) staying blank.

## 6. Operational gaps

- No request logging (e.g. morgan/pino) — nothing to look at when debugging
  a production issue beyond the `console.error` in the global error handler.
- **The two repos' `frontend-contract.md` copies have drifted** (diffed
  2026-10-08). The frontend's copy is missing the `/api/ocr/reconcile`
  section, `DraftHeader.printout_datetime`, the full `totals` comparison
  rules and all of §8 (quantity PATCH). This copy is missing the frontend's
  newer §2 wording (merges keep `status: "success"`, shown on the batch
  summary). Merge them into one text and copy it to both repos. §9 (delivery
  note, 2026-10-12) was written to match in both copies.

## 7. Deleting a confirmed delivery or item

Flagged as an open question in `main-file.md` §12, still unresolved for the
delete half. **Marked optional / nice-to-have, not blocking** — no delete
routes exist for `deliveries` or `delivery_items`. Quantity edits are
handled (`PATCH /api/deliveries/:delivery_code/items/:item_id`, audited via
`delivery_item_updates` — see `frontend-contract.md` §8). If delete gets
picked up: prefer soft-delete + an edit log over hard deletes, per the
original doc's own suggestion, for auditability — same pattern as the
quantity-edit history table.

## 8. Realtime sync (Phase 4, `main-file.md` §8)

Not started. No Supabase Realtime subscription exists anywhere in this repo.
Needed once multi-user concurrent editing actually matters — low priority
while usage is 2–3 people who rarely collide. The frontend side would
invalidate `["deliveries", storeCode]` on each event.

---

## Already handled (kept here only as context, not a to-do)

For anyone reading this later wondering why these *aren't* on the list:
- Every migration in `supabase/migrations/` has been applied to the Supabase
  project, including `atomic_delivery_writes` (`#17`) — the
  `update_delivery_item_quantity` function answered a no-match call on
  2026-10-12.
- Delivery note (`#19`, `frontend-contract.md` §9): `add_delivery_note` applied
  to the Supabase project 2026-10-12; the column and the PATCH's update query
  were checked against it (a non-matching code returns no row → 404). A real
  save from the frontend hasn't been tried yet.
- Multi-page upload (`#12`, merged): `/api/ocr/reconcile` cross-checks store
  codes across pages of one receipt via the printed printout timestamp
  (`main-file.md` §5 rule 8); the parser reads the timestamp and warehouse
  from the page footer first. Default `OCR_RATE_LIMIT_PER_MINUTE` raised to
  30 so a ~25-page delivery fits in one batch.
- Crossed-out Qty/UOM recovery, handwriting flag and printed totals block
  (`#15`, merged into `develop`): `reconcileItem` row arithmetic, item-history
  fill, and an `inferred` array on every item.
- In-batch duplicate rows are merged (`mergedItems`); a collision with an
  already-saved row is rejected per row (`partial`). The frontend shows both
  (its `#21`/`#42`), and both were verified live on 2026-10-07.
- Global JSON error handling (404s, multer upload errors, malformed JSON
  bodies) — all failure paths return JSON instead of Express's default HTML
  error page.
- OCR upload mimetype validation — non-image uploads are rejected before
  hitting the Vision API.
- CORS origin allowlist (`ALLOWED_ORIGINS`). It only binds browsers; the
  passcode check (§4) is what stops direct callers.
- `trust proxy` (`TRUST_PROXY` env, `src/index.ts`), so per-IP limits see
  the caller behind Railway's proxy.
- Store passcodes (`#21`, `frontend-contract.md` §10): `add_store_passcode`
  applied to the Supabase project 2026-10-13, and checked end to end against
  the frontend's `#52` — sign-in, wrong passcode, a refused (changed)
  passcode sending staff back to re-enter it, another store's data → 403.
  Not yet exercised live: the 10-wrong-passcodes lockout and `/api/ocr`.
