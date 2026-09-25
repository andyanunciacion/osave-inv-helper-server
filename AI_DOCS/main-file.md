# Supermarket Inventory System — Development Plan

## 1. System Summary

A web app (PWA-enabled) that lets store staff:
- Select/scan a store code to scope a session
- Photograph or upload delivery receipts, which get OCR'd into structured header fields + item rows
- Search delivered items by name, item code, date, date range, or delivery code
- Work with 2–3 concurrent users whose data stays in sync
- Keep working (uploads run in the background) and, ideally, keep working offline

This document covers architecture, data model, business rules, and a phased build plan sized for a solo developer shipping an MVP first.

**Source document:** the delivery receipt is printed by the warehouse system, which pre-assigns the delivery code — printed as **"Inv. Tran. No."** — before the receipt ever reaches the app. That code is guaranteed **globally unique** by the warehouse system. This is actually good news for the data model: `delivery_code` stays a clean, simple primary key (§4) — the only real change from the original plan is *where the code comes from* (OCR'd from the receipt) rather than client-generated, and that has a couple of knock-on effects on the offline flow (§8) and duplicate-detection (§5) worth knowing about.

**Receipt layout:**
| Header field | Maps to | Notes |
|---|---|---|
| To: [store_code] [store_address] | `store_code` (cross-check), see §5 rule 4 | store_address not persisted — already in `stores` |
| From: [warehouse_code] | `warehouse_code` | |
| Transaction Date | `delivery_date` | |
| Inv. Tran. No. | `delivery_code` | primary identifier — see §4 |
| Date/hour of printout | `printout_datetime` | see §5 rule 8 — used to recover a blocked store code, not persisted on `deliveries` |
| No. of Pallets | — | disregard |

| Item table column | Maps to | Notes |
|---|---|---|
| SAN | `item_code` | |
| Description | `item_name` | |
| Unit/Box | `unit_count` | pieces per box (e.g. 12, 96, 288) |
| UOM | `unit` | "BOX" or "PIECE" |
| Qty | `quantity` | how many units of `unit` were delivered |
| Sales Price | `item_price` | |
| Total | `total_item_price` | printed value — extract, don't recompute (see §7) |

---

## 2. Recommended Tech Stack

| Layer | Recommendation | Why |
|---|---|---|
| Frontend | **Next.js (React + TypeScript)** | One framework for web + PWA, file-based routing, can host API routes if you don't want a fully separate backend, huge ecosystem for a solo dev. |
| Hosting | **Vercel** | Zero-config deploys for Next.js, free tier is enough for this scale, HTTPS by default (required for PWA + camera access). |
| Backend/DB | **Supabase** (managed Postgres + Auth + Storage + Realtime + Edge Functions) | Gives you a real relational DB (needed for your uniqueness rule), file storage for delivery photos, and built-in realtime subscriptions — which solves your "3 users synced" requirement almost for free. |
| OCR/extraction | **Google Cloud Vision API** or a structured invoice parser (Document AI / Textract `AnalyzeExpense`) | Which one fits best depends on how the actual receipts look — see §7 for the comparison and how to decide. |
| Local/offline storage | **IndexedDB** via the `idb` library | Lets you queue uploads and cache search results when offline. |
| QR/barcode scanning | Native `BarcodeDetector` API with `@zxing/browser` as a polyfill fallback | Covers browsers that don't yet support `BarcodeDetector` (notably older iOS Safari). |
| Camera capture | `<input type="file" accept="image/*" capture="environment">` | More reliable cross-browser than raw `getUserMedia` for "take or upload a photo" — no custom camera UI to maintain. |

This stack lets one person realistically build and operate the whole system without managing servers, and stays close to free until you have real usage volume.

---

## 3. High-Level Architecture

```
[Browser / PWA]
   ├─ Store session (store_code in localStorage)
   ├─ Search UI ─────────────► Supabase (Postgres, via REST/JS client)
   ├─ Upload UI
   │     ├─ Photo captured in-browser (kept only in memory / IndexedDB —
   │     │        never written to Supabase Storage, see §7)
   │     ├─ Sent directly to an OCR proxy endpoint ───► OCR/extraction service
   │     │        (a small serverless function, e.g. a Vercel/Next.js API
   │     │         route — keeps the extraction API key off the client;
   │     │         see §7 for which service)
   │     ├─ Local upload queue (IndexedDB) holds the photo only until
   │     │        OCR succeeds, then discards it
   │     └─ Parsed text rows ──► Review/Edit screen ──► Postgres (text only)
   └─ Realtime subscription ◄─── Supabase Realtime (store-scoped channel)
```

Everything reads/writes through Supabase's client SDK, which also handles the realtime channel that keeps the 2–3 concurrent users in sync — no custom sync server needed. Note the image itself never has to touch Supabase at all — only the parsed text does (see §7).

---

## 4. Data Model

```sql
-- One row per store
create table stores (
  store_code text primary key,
  name text not null,
  created_at timestamptz default now()
);

-- One row per delivery receipt
create table deliveries (
  delivery_code text primary key,     -- OCR'd from "Inv. Tran. No." — guaranteed
                                       -- globally unique by the warehouse system
  store_code text references stores(store_code),
  warehouse_code text,                 -- OCR'd from "From"
  delivery_date date not null,         -- OCR'd from "Transaction Date"
  receipt_store_code text,             -- OCR'd from "To" — kept separately from
                                        -- store_code for an audit cross-check
                                        -- (see §5, rule 4)
  source_images text[],               -- optional: only populate this if you decide
                                       -- to retain original photos (see §7). Leave
                                       -- null/unused for a text-only pipeline.
  uploaded_by text,                   -- device/session identifier
  status text default 'processing',   -- processing | confirmed | failed
  created_at timestamptz default now()
);

-- One row per line item within a delivery
create table delivery_items (
  id uuid primary key default gen_random_uuid(),
  delivery_code text references deliveries(delivery_code),
  store_code text references stores(store_code),  -- denormalized for fast search
  item_code text,                     -- OCR'd from "SAN"
  item_name text not null,            -- OCR'd from "Description"
  unit_count numeric,                 -- OCR'd from "Unit/Box" (pieces per box)
  quantity numeric,                   -- OCR'd from "Qty"
  unit text,                          -- OCR'd from "UOM" ("BOX" or "PIECE")
  item_price numeric,                 -- OCR'd from "Sales Price"
  total_item_price numeric,           -- OCR'd from "Total" — extracted as printed,
                                       -- not recomputed (see §7 for why)
  raw_ocr_text text,                  -- original OCR line, kept for auditing/corrections
  created_at timestamptz default now(),
  unique (delivery_code, item_code)   -- enforces your core duplicate rule
);

create index on delivery_items (store_code, item_code);
create index on delivery_items (store_code, item_name);
create index on delivery_items (store_code, created_at);
```

**Open decision:** if a slip lists an item with no code, only a name, the `unique(delivery_code, item_code)` constraint can't catch duplicates by name alone. Two options:
1. Require a fallback code (e.g., a slugified item name) whenever no code is present, and enforce uniqueness on that.
2. Treat name-only items as always allowed to repeat (accept the risk) and let the review screen be the safety net.

I'd default to option 1 for MVP — it's a small addition and keeps the rule airtight.

**On `total_item_price`:** the receipt prints quantity, unit price, and total together, so extract all three directly rather than computing total yourself. That printed total is actually useful as a free sanity check: if `quantity × unit_count × item_price` doesn't roughly match the extracted `total_item_price` (on the sample receipts, `Total = Qty × Unit/Box × Sales Price`, so `item_price` is per piece), that's a signal one of the three fields was misread by OCR — worth flagging in the review screen rather than silently trusting whichever value you happened to compute.

---

## 5. Core Business Rules

1. Every operation (search, upload) is scoped to a `store_code` — set once at session start, applied to every query.
2. A `delivery_code` represents one delivery receipt and is sourced from the printed **"Inv. Tran. No."** — not generated by the app. Because the warehouse guarantees this globally unique, re-uploading the *same physical receipt* naturally conflicts on the `deliveries` primary key itself — you get duplicate-receipt protection for free, on top of the duplicate-item rule below. The one thing this depends on is OCR reading that field correctly, which is why it should be shown prominently and editable on the review screen before confirming (§6) — a misread here is more consequential than a misread item name.
3. Within a delivery, `item_code` (or, for a code-less item, the name-based fallback key — see §4's "open decision") must be unique **per submitted batch**: the receipt itself sometimes prints the same item twice on one page (confirmed on a real sample — a deposit line repeated), and per the store manager, those rows should be **combined**, not rejected. `quantity` and `total_item_price` are summed across the repeated rows; `unit_count`, `unit`, `item_price`, and `item_name` are kept from the first occurrence — `unit_count` ("Unit/Box") is a packaging fact, not a count, so summing it alongside `quantity` would double-count against `total_item_price` (see §4's note on that formula) rather than genuinely reflect what was delivered. If the kept fields disagree between the repeated rows (different price, unit, or name — a sign the item code was misread rather than a genuine repeat), the merge still happens but the row is flagged (`mergedItems` in the response) for the review screen to call out. This merge only ever happens *within one upload*: an item that collides with a row **already saved** from an earlier page of the same receipt (rule 7) is a different case and is still rejected as a duplicate — merging across separate uploads risks silently doubling a resubmitted page.
4. Different items freely share the same `delivery_code` — that's the normal case (a delivery usually has many items).
5. Duplicate rejection happens at the database level (the `unique` constraint, and the `deliveries` primary key) *and* is surfaced clearly in the UI at review time, so staff know exactly which line — or which whole receipt — failed and why.
6. The receipt's printed "To" store code (`receipt_store_code` — the first number in the "To:" line; the address after it is ignored) must match the session's `store_code`. A mismatch is **rejected**, so a receipt for one store can't land in another store's records: `/api/ocr` returns 409 `store_mismatch` before any items are returned, and `POST /api/deliveries` returns `status: "store_mismatch"` and writes nothing. (This replaces the earlier warn-only rule.) `receipt_store_code` is **required** on `POST /api/deliveries` (400 if missing or blank), including for manual entry — staff type it from the paper receipt. If OCR couldn't read the "To" code, `/api/ocr` returns it blank instead of rejecting, and the user must fill it in before the delivery can be saved.
7. A physical receipt can span several photographed pages ("Page 10 of 12"), and every page prints the same "Inv. Tran. No.". A later page for the **same store** appends its items to the existing delivery (rule 3 still rejects individual duplicate items); a page whose items are all duplicates, or the same code under a **different store**, comes back as `duplicate_delivery`.
8. When a photo's "To:" store code can't be read — the digits themselves obscured (a folded corner, a staple, a sticker), or even the "To:" label itself obscured so there's nothing to anchor the search from — it isn't necessarily hand-typed by the user. Every page of one physical receipt also prints an identical "Date and hour of printout" (down to the second, and printed a second time in the page footer as extra redundancy), so a multi-photo upload can recover it from a sibling page instead: if exactly one other page in the same upload shares that exact timestamp *and* has a store code that read cleanly, that code is copied over and flagged as inferred rather than OCR'd (`POST /api/ocr/reconcile`, §7). No match, or siblings that disagree, leaves it blank — same as today, the user fills it in by hand. This is a same-upload cross-check only: it never looks at previously-saved deliveries, and rule 6's mismatch check still applies to an inferred code exactly as it would to a directly-read one.

---

## 6. Key User Flows

**A. Store session**
Enter or scan store code → store it in `localStorage` → every screen after this is scoped to that store until changed.

**B. Upload flow**
1. Take/upload one or more photos of the delivery receipt.
2. Assign a temporary **local draft ID** client-side (just for tracking this upload in the local queue) — this is *not* the delivery code. Unlike the earlier version of this plan, the real `delivery_code` isn't known yet, since it lives on the receipt itself.
3. Queue the photo(s) for OCR; user is free to keep using the app.
3a. Once every photo in this upload has come back from OCR, if more than one page was uploaded, send their headers to `/api/ocr/reconcile` (§5 rule 8) so a page with a blocked store code can pick one up from a sibling page before the review screen renders — a single-photo upload skips this step, there's nothing to cross-check against.
4. When OCR returns, show a **review/edit screen** with:
   - The extracted header fields — store, warehouse, transaction date, and the **Inv. Tran. No. shown prominently and editable**, since it's now the primary key and a misread here matters more than a misread item name.
   - (A receipt for a different store never gets this far — `/api/ocr` rejects it, rule 6, §5.)
   - The parsed item rows (code, description, unit count, quantity, unit, price, total), with any quantity×unit count×price/total mismatches flagged (§4).
5. On confirm, the delivery and its rows are written. A duplicate `delivery_code` (same receipt uploaded twice) is rejected at the `deliveries` table level. An item code repeated *within this same upload* is combined into one row rather than rejected (rule 3, §5); a duplicate `(delivery_code, item_code)` against a row **already saved** (e.g. from an earlier page) is still rejected at the item level — both surfaced per-row, not as a whole-batch failure.

**C. Search flow**
- Free-text input: matched against `item_code`, `item_name`, and `delivery_code`.
- Date picker (single or range): matched against `deliveries.delivery_date`.
- Results render on their own page, reached from the search screen on submit (not live-as-you-type), so filters are shareable/back-button-friendly via the URL.
- Grouping: when a free-text query is present, results are grouped by delivery_code/date — a search by item name or item code can return the same item across several deliveries, shown as separate groups. When the search is **date-only** (a date/range is set and the text field is empty), results are instead shown as one unified list of items across every matching delivery, not separated by delivery_code — a date-only search is usually "what came in that day," not "which deliveries arrived." Each row in that unified list still carries its own delivery_code so the source stays traceable.
- Since a single delivery can have 50-80 line items, a grouped result only shows the item(s) that actually matched the query, not the whole receipt — except an **exact** match on the delivery_code itself, which is treated as "show me this receipt": every item is shown and the group expands automatically. Any other match (a delivery-code fragment, or an item name/code, exact or partial) stays collapsed until tapped. The groups list itself also paginates for broad queries matching many deliveries, and item lists (an expanded group, or the unified view) are virtualized.

---

## 7. OCR Pipeline (text-only — no image storage)

The image does **not** need to be stored anywhere, in Supabase or otherwise. But it's worth re-evaluating the extraction method now that we know the exact shape of the document: it's a structured header (To/From/Date/Inv. Tran. No.) plus a priced line-item table — functionally, this is an invoice/receipt, not just a loose list of items.

**Extraction approach:**
- **Purpose-built invoice/receipt parsers** — Google Document AI's Invoice/Expense parser, or AWS Textract's `AnalyzeExpense` — are designed for exactly this shape (labeled header fields + a line-item table with quantity/price/total) and can return structured key-value pairs and table rows directly, instead of raw text you then have to parse yourself. Given you now have concrete fields to extract (SAN, Description, Unit/Box, UOM, Sales Price, Total), this is worth trying first — it likely needs less custom parsing code than generic OCR.
- **Generic OCR + custom parsing** (Google Vision `DOCUMENT_TEXT_DETECTION`) is still a reasonable fallback if the structured parsers are pricier than you want at your volume, or if the receipt layout turns out to be simple/consistent enough that basic line-splitting heuristics hold up. This is the one worth testing against a real sample image (see below).
- **Tesseract.js**, fully client-side, remains the option for keeping the image entirely on-device — but you'd be writing your own table-parsing heuristics on top of raw text, so it's the most implementation-effort of the three for this particular document shape.

**Flow (Option A, server-side):**
1. Photo is captured/selected in the browser and held only in memory (or briefly in IndexedDB if offline — see §8).
2. It's sent directly to a small serverless **OCR proxy endpoint** (a Next.js API route or Supabase Edge Function) which calls the chosen extraction service and returns structured fields. This proxy exists purely for security: calling any of these APIs straight from the browser would expose your API key in every request; a thin server-side function keeps the key hidden without persisting the image anywhere.
3. Header fields and item rows come back as structured JSON, mapped to the schema in §4.
4. Only that JSON is sent to the client. The image is discarded after this step — never written to disk or storage.
4a. For a multi-photo upload, once all pages have come back, their headers are sent to `/api/ocr/reconcile` — a second, image-free endpoint that fills in a page's blocked store code from a sibling page sharing the same printed "Date and hour of printout" (§5 rule 8). This is a pure cross-check over already-extracted JSON, not another Vision call.
5. User reviews/edits on the review screen (§6); on confirm, only text/number data is written to Postgres.

**Trade-off to weigh either way:** without keeping the image, you lose the ability to go back and check the original receipt if a number looks wrong or a supplier disputes a delivery later. If that matters, a middle ground is to only retain images the OCR step flags as low-confidence, rather than storing everything — this can be added later without any redesign, since it's purely additive.

**Worth doing before committing to an approach:** run 2–3 real (or realistically messy) sample receipts through both a generic OCR call and a structured invoice parser, and compare how cleanly each extracts the Inv. Tran. No. and the item table — that'll tell you whether the extra cost of a purpose-built parser is worth it for your receipts specifically.

---

## 8. Background Upload & Offline/Sync Architecture

- **Background upload:** each queued upload has a status (`pending → uploading → processing → done/failed`) tracked in IndexedDB and mirrored in the UI as a small non-blocking badge/toast — never a blocking spinner. The rest of the app stays usable while this runs.
- **Local draft ID vs. real delivery code:** since `delivery_code` now comes from the receipt itself (§1), it isn't known until OCR runs. Offline capture still works the same way in practice — the photo is queued locally under a throwaway client-generated draft ID purely for UI/queue tracking, and the *real* `delivery_code` only gets bound once OCR (local Tesseract.js, or a synced cloud call) extracts the Inv. Tran. No. and the user confirms it on the review screen.
- **Offline queueing:** if captured offline, the photo is held *temporarily* in IndexedDB (not uploaded anywhere) until connectivity returns (or immediately, if using on-device Tesseract.js); it's then sent to the OCR step and discarded once parsed fields come back. What actually gets queued for sync to Postgres is the structured header + item data once confirmed — the image is never the thing being "synced" long-term.
- **Multi-user sync:** a Supabase Realtime subscription per `store_code` pushes new/confirmed deliveries to all connected clients — this comfortably covers 2–3 concurrent users with no custom infrastructure.
- **Background Sync API** (Chrome/Android) can trigger a sync automatically when connectivity returns, even if the tab isn't focused. This is not available on iOS Safari (see §9) — for those users, sync is triggered on app foreground/visibility-change instead, with a periodic retry while the app is open.

Given you only have ~3 concurrent users, this is a very low-concurrency problem — you don't need anything more sophisticated than the above; it's mentioned mainly so you don't over-build it.

---

## 9. PWA Implementation Notes

- Standard `manifest.json` (name, icons, `display: standalone`, theme color) plus a service worker (Workbox is the easiest way to generate one) using a **network-first strategy for API calls** and **cache-first for static assets**.
- Installability: Android/Chrome shows a native install prompt (`beforeinstallprompt`); iOS Safari requires the user to manually "Add to Home Screen" — there's no programmatic prompt, so plan a small in-app nudge/instructions for iOS users.
- **iOS Safari caveats to design around:**
  - No Background Sync API — use the foreground/visibility-change fallback described in §8.
  - Local storage (including IndexedDB) can be evicted after extended inactivity on some iOS versions — treat local storage as a *buffer*, not a durable store; sync to the server as soon as possible rather than relying on long local retention.
  - Camera capture via `<input capture>` works fine on iOS; a fully custom `getUserMedia` camera UI is more fragile there, which is part of why it's the recommended approach in §2.

---

## 10. Development Roadmap (MVP-first, solo dev)

Sequencing is deliberately built so the *core inventory + search logic* is proven out with plain manual entry before you take on OCR complexity.

| Phase | Scope | Rough size |
|---|---|---|
| **0. Setup** | Repo, Vercel + Supabase projects, base schema, store-code session flow | ~1 week |
| **1. Core MVP** | Manual item entry (no OCR yet) tied to delivery codes, the duplicate-rule constraint, and full search (name/code/date/date range) grouped correctly | ~2–4 weeks |
| **2. OCR & photo upload** | Camera/file upload, OCR integration (test generic vs. structured invoice parser — §7), header + item table parsing, review/edit screen (incl. editable Inv. Tran. No.), background upload queue + status UI | ~2–4 weeks |
| **3. PWA & offline** | manifest + service worker, installability, IndexedDB queue, offline capture, QR scanning for store code | ~2 weeks |
| **4. Multi-user realtime sync** | Supabase Realtime subscriptions, concurrent-edit edge cases | ~1–2 weeks |
| **5. Hardening** | Error handling/retries, OCR cost/rate limiting, logging, real-device testing (especially iOS Safari) | ongoing |

Treat these as relative sizing, not commitments — solo-dev pace varies a lot week to week. The important structural point is: **ship manual entry + search first**, since that alone is a usable, valuable tool, and it validates your data model before OCR adds noise.

---

## 11. Rough Cost Expectations

At this scale (a handful of stores, 2–3 concurrent users), you can run the MVP close to **$0/month**:
- Vercel: free tier is enough.
- Supabase: free tier covers early Postgres/Realtime usage; paid tier (~$25/mo) only needed once you exceed it. If you skip image storage entirely (§7), you won't touch the Storage quota at all, which pushes that ceiling out further.
- OCR/extraction: generic OCR (Google Vision) has a free tier of 1,000 units/month, then roughly $1.50 per additional 1,000 images. Structured invoice parsers (Document AI / Textract `AnalyzeExpense`) typically cost more per page than generic text detection — worth checking current pricing for both once you've decided which fits your receipts better (§7), but either is cheap at your volume.

---

## 12. Open Questions Worth Deciding Early

- What should happen when an item on the slip has **no printed code** — auto-generate a fallback code (§4), or accept the small duplicate-detection gap?
- Do staff need to **edit or delete** a confirmed delivery/item after the fact? (Suggest soft-delete + an edit log rather than hard deletes, for auditability.)
- Is this **one deployment serving many stores** (as assumed throughout, via `store_code` scoping), or one deployment per store?
- Should search results ever cross stores, or always stay scoped to the currently selected store code?
- If OCR misreads the Inv. Tran. No. slightly differently on two attempts at the same physical receipt, the free duplicate-receipt protection in §5 won't catch it. Worth deciding how much you rely on the review screen alone vs. adding a secondary soft check (e.g., flag if a very similar item set was uploaded to the same store recently).
- Is `warehouse_code` just stored for reference, or do you want reporting by source warehouse later? Doesn't affect the MVP schema either way, but worth knowing.

---

*Next step: I'd start with Phase 0/1 — get the schema and manual-entry + search flow working end-to-end before touching OCR. Happy to help scaffold the Next.js + Supabase project or write the actual schema migration next.*
