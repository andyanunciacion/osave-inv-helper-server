# Frontend Contract (as built)

Companion to `AI_DOCS/main-file.md` (the plan/domain-rules doc). That doc says
*what the rules are*; this doc says *what shape the frontend already expects
from a backend*, because the frontend was prototyped end-to-end against an
in-memory mock (`features/deliveries/lib/sample-store.ts`) before Supabase
existed. The data hooks below were deliberately kept stable at their public
boundary so that swapping the mock for real Supabase/TanStack Query calls
shouldn't require touching `features/upload` or `features/search` call
sites — this doc is that boundary, written down.

As of 2026-09-13. Re-check against the hook source before treating any
signature here as current — it's the kind of thing that drifts.

---

## 1. Persisted row shapes (`src/types/schema.ts`)

These mirror §4 of the plan doc and should map 1:1 to the eventual Postgres
tables:

```ts
interface Store {
  store_code: string;
  name: string;
  created_at: string; // ISO timestamp
}

type DeliveryStatus = "processing" | "confirmed" | "failed";

interface Delivery {
  delivery_code: string;
  store_code: string;
  warehouse_code: string | null;
  delivery_date: string;        // "yyyy-MM-dd", NOT a timestamp — see §5 (timezones)
  receipt_store_code: string | null;
  uploaded_by: string | null;
  status: DeliveryStatus;
  created_at: string;
}

type ItemUnit = "BOX" | "PIECE";

interface DeliveryItem {
  id: string;                   // uuid
  delivery_code: string;
  store_code: string;           // denormalized, per §4
  item_code: string | null;
  item_name: string;
  quantity: number | null;
  unit: ItemUnit | null;
  item_price: number | null;
  total_item_price: number | null;
  raw_ocr_text: string | null;
  created_at: string;
}
```

`store_code` is always normalized client-side to **trimmed, uppercased**
before it's used for scoping or storage (`use-store-session.ts`,
`sample-store.ts`'s `normalizeStoreCode`). The backend should apply the same
normalization (or a case-insensitive `citext`/unique index) so a client bug
or an inconsistently-cased QR code can't silently fork a store's data across
two rows.

---

## 2. Write path — creating a delivery

**Hook:** `useCreateDelivery()` → `submitDelivery(input: NewDeliveryInput): CreateDeliveryResult`
(`features/deliveries/hooks/use-create-delivery.ts`)

Called once, from the review screen's `confirm()` in
`useDeliveryDraft` (`features/upload/hooks/use-delivery-draft.ts`), after the
user has edited the OCR'd draft. This is a single call carrying the whole
receipt (header + all item rows) — not one call per item.

```ts
interface NewDeliveryItemInput {
  item_code: string | null;
  item_name: string;
  quantity: number | null;
  unit: ItemUnit | null;
  item_price: number | null;
  total_item_price: number | null;
}

interface NewDeliveryInput {
  delivery_code: string;
  store_code: string;
  warehouse_code: string | null;
  delivery_date: string;
  receipt_store_code: string | null;
  items: NewDeliveryItemInput[];
}
```

**Response** — the mock enforces §5 rules 2/3/5 itself; the real backend
needs to reproduce this exact result shape, not just the constraint:

```ts
type CreateDeliveryStatus = "success" | "duplicate_delivery" | "partial";

interface RejectedItem {
  item_code: string | null;
  item_name: string;
  reason: "duplicate_item_code";
}

interface CreateDeliveryResult {
  status: CreateDeliveryStatus;
  delivery: Delivery | null;      // null only on "duplicate_delivery"
  acceptedItems: DeliveryItem[];
  rejectedItems: RejectedItem[];
}
```

Behavior the review screen depends on:
- **Whole-receipt rejection**: if `delivery_code` already exists, return
  `status: "duplicate_delivery"`, `delivery: null`, both item arrays empty.
  Nothing is written. The UI (`use-delivery-draft.ts`'s `editAgain()`) sends
  the user back to editing with their typed rows intact — it does not refetch
  anything, so the rejection must be synchronous/immediate in the response,
  not a side-channel notification.
- **Per-row rejection, not batch failure**: a duplicate `item_code` *within
  the same submitted batch* is dropped into `rejectedItems`, and every other
  row still gets written and returned in `acceptedItems`. Status becomes
  `"partial"` (not an error) when `rejectedItems.length > 0`, `"success"`
  otherwise.
- **Fallback dedupe key for code-less items**: when `item_code` is null/empty,
  the mock keys the duplicate check on `name:<lowercased trimmed item_name>`
  instead (§4's "open decision", option 1 — this has already been decided,
  not left open). The backend's uniqueness handling needs an equivalent
  fallback (e.g. a generated slug column) since a plain
  `unique(delivery_code, item_code)` constraint can't see name-only rows.
- Rows with an empty/blank `item_name` are filtered out client-side before
  the call is even made (see `confirm()`) — the backend doesn't need to
  handle "empty item" as its own case.
- `store_code` and `receipt_store_code` mismatch (§5 rule 6) is **not**
  enforced or blocked server-side in this contract — it's a client-only
  warning (`storeMismatch` in `useDeliveryDraft`, computed by string
  comparison) shown before confirm. The write itself always succeeds
  regardless of mismatch; the backend doesn't need to reject or flag it.

---

## 3. Read path — search

**Hook:** `useDeliverySearch({ storeCode, query, range })` →
`{ groups: DeliverySearchResultGroup[], hasActiveFilters: boolean }`
(`features/deliveries/hooks/use-delivery-search.ts`)

- Returns `{ groups: [], hasActiveFilters: false }` when both `query` is
  empty and `range` is unset — the frontend never asks for "everything",
  so the backend query doesn't need an unbounded/no-filter path from this
  hook (see §4 for the one place that does browse unfiltered).
- `query` matches (case-insensitive, substring) against `item_code`,
  `item_name`, and `delivery_code` — matching §6's free-text spec.
- `range` filters on `deliveries.delivery_date`, inclusive, compared as
  **local calendar dates**, not UTC — see §5 below, this is a real bug class
  the frontend already hit once.
- **Grouping/display logic below is currently computed client-side** over
  full delivery+item rows. For an API that returns already-paginated data,
  this logic needs to move server-side (see "porting note" at the end):
  - Exact match on `delivery_code` (case-insensitive, full string): return
    *every* item for that delivery, and mark it `autoExpand: true`.
  - Any other match (delivery-code fragment, or item name/code hit): return
    only the item rows that matched, `autoExpand: false`. A delivery can
    have 50-80 items — the UI is relying on the backend/hook to not hand
    back the whole receipt for a one-item hit.
  - Displayed items within a group are sorted by `item_code`.
  - The **groups list itself** paginates in pages of 15
    (`use-paginated-groups.ts`, `DEFAULT_PAGE_SIZE = 15`) — a broad query
    can match many deliveries.

```ts
interface DeliveryGroup {
  delivery: Delivery;
  items: DeliveryItem[];
}

interface DeliverySearchResultGroup extends DeliveryGroup {
  displayItems: DeliveryItem[]; // filtered/sorted subset, see above
  autoExpand: boolean;
}
```

**Hook:** `useUnifiedItemSearch({ storeCode, range })` →
`{ items: UnifiedItemRow[] }` (`features/deliveries/hooks/use-unified-item-search.ts`)

Used instead of `useDeliverySearch` specifically when the query text is
empty and only a date range is set (§6: "date-only search is usually 'what
came in that day'"). Returns a flat, ungrouped list of items across every
delivery in range, each item still carrying its own `delivery_code` and
(added) `delivery_date`, sorted by date desc then `item_code`. This is a
materially different query shape from the grouped search above — a real
API needs both, selected by the same "is there text?" branch the frontend
uses, not just one endpoint with grouping as a client-side afterthought.

```ts
interface UnifiedItemRow extends DeliveryItem {
  delivery_date: string;
}
```

---

## 4. Read path — recent/browse

**Hook:** `useRecentDeliveries(storeCode, limit = 5)` →
`{ groups: DeliveryGroup[] }` (`features/deliveries/hooks/use-recent-deliveries.ts`)

Store-scoped, **unfiltered**, most-recent-first (`created_at` desc), capped
at `limit`. Backs the "recent uploads" quick-select bar on the search
screen. This is the one place the frontend does want an unfiltered/browse
query — separate from search, don't conflate the two into one endpoint with
optional filters if it makes the "recent, capped, no filters" case awkward.

---

## 5. Known correctness traps already hit while building the frontend

- **Date-only strings and timezones**: `delivery_date` is a plain
  `"yyyy-MM-dd"` string, deliberately not a timestamp. Parsing it with
  `new Date(str)` / `parseISO` treats it as UTC midnight, which shifts a
  calendar day in timezones ahead of UTC (this app is PH-based, UTC+8) —
  this was a real bug, fixed client-side in
  `features/deliveries/lib/date-range.ts` /
  `features/search/lib/search-params.ts` by parsing against a local
  reference date instead of relying on UTC-based parsing. Whatever the
  backend uses for date filtering (Postgres `date` type + range query)
  should be timezone-agnostic by construction, but if any date arithmetic
  happens in application code, use the same local-date approach rather than
  naive `Date` parsing.
- `sample-store.ts`'s own seed-data generator still has this bug
  (`.toISOString().slice(0,10)`) — harmless there since it only affects
  which day cosmetic demo data lands on, but don't copy that line as a
  reference for real date generation.
- **Quantity × price ≈ total is a soft check, not a constraint**: §4's
  sanity check (`hasPriceMismatch` in
  `features/deliveries/lib/format.ts`) is purely a UI flag on the review
  screen — it does not block submission and the backend doesn't need to
  validate or reject on it. `total_item_price` is stored exactly as
  extracted/edited, never recomputed.

---

## 6. Not yet real / explicitly deferred

Don't treat these as "backend needs to support this on day one" — they were
deliberately mocked or postponed:

- **OCR**: `features/upload/lib/mock-ocr.ts` fabricates an `OcrResult`
  (header + item rows) from a couple of canned templates after a ~1.2s
  delay; the photo file is never inspected. The real contract is §7 of the
  plan doc (a proxy endpoint that accepts an image and returns this same
  `OcrResult` shape) — `OcrResult`'s shape below is what the review screen
  (`useDeliveryDraft`) already expects as input, so the real OCR proxy
  should return exactly this:

  ```ts
  interface DraftHeader {
    delivery_code: string;
    warehouse_code: string;
    delivery_date: string;      // "yyyy-MM-dd"
    receipt_store_code: string;
  }

  interface DraftItem {
    localId: string;            // client-generated, not persisted
    item_code: string;
    item_name: string;
    quantity: string;           // note: strings, for controlled-input editing
    unit: string;
    item_price: string;
    total_item_price: string;
  }

  interface OcrResult {
    header: DraftHeader;
    items: DraftItem[];
  }
  ```

  All fields are strings (including numeric ones) because they're bound
  directly to editable text inputs on the review screen and only parsed
  back to `NewDeliveryInput`'s numeric/typed fields at confirm time
  (`toNumberOrNull`/`toItemUnitOrNull` in `use-delivery-draft.ts`). An OCR
  proxy that returns numbers instead of strings would need an adapter, not
  a hook change.

- **Auth / `uploaded_by`**: currently hardcoded to `"prototype-session"`.
  No real user/session identity exists yet on the frontend.
- **Realtime sync (§8)**: no Supabase Realtime subscription exists.
  `sample-store.ts`'s subscribe/notify pattern is a local stand-in for what
  a realtime channel will eventually drive, but there's no networking
  involved today.
- **Offline queue / IndexedDB / PWA (§8/§9)**: not built. Deferred by
  agreement until real backend latency exists to design against.
- **Route guard**: `/search` and `/upload` are reachable with no store code
  set (`storeCode` is just `null`) — not a backend concern, but worth
  knowing the frontend doesn't currently prevent an unscoped call from
  happening.

---

## 7. Porting note

Every hook above is written to be the seam: `features/deliveries/hooks/*`
and `features/upload/hooks/use-delivery-draft.ts` call into
`features/deliveries/lib/sample-store.ts` only, never `fetch`/Supabase
directly. Swapping that module's internals for real `useQuery`/`useMutation`
calls against Supabase — keeping each hook's exported parameter and return
shape identical — should not require changing anything in
`features/upload/components` or `features/search/components`. Where a
hook's current behavior (e.g. grouping/filtering in §3) is really a query
shape that belongs in SQL/an RPC rather than client-side `.filter()`, that's
a hook-internals change, still without touching call sites.
