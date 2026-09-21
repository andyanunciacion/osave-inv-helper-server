-- Run this against your Supabase project (SQL editor, or `supabase db push`
-- once the project is linked). Matches AI_DOCS/main-file.md §4.

create extension if not exists pgcrypto;

-- One row per store
create table if not exists stores (
  store_code text primary key,
  name text not null,
  created_at timestamptz default now()
);

-- One row per delivery receipt
create table if not exists deliveries (
  delivery_code text primary key,      -- OCR'd (or, in Phase 1, manually typed)
                                        -- from "Inv. Tran. No." — globally unique
  store_code text references stores(store_code),
  warehouse_code text,                 -- "From"
  delivery_date date not null,         -- "Transaction Date"
  receipt_store_code text,             -- "To" — kept separately from store_code
                                        -- for the mismatch warning (rule 6)
  source_images text[],                -- unused in the text-only pipeline
  uploaded_by text,                    -- device/session identifier
  status text default 'confirmed',     -- processing | confirmed | failed
  created_at timestamptz default now()
);

-- One row per line item within a delivery
create table if not exists delivery_items (
  id uuid primary key default gen_random_uuid(),
  delivery_code text references deliveries(delivery_code),
  store_code text references stores(store_code),  -- denormalized for fast search
  item_code text,                      -- "SAN", or a slugified fallback (§4 open decision)
  item_name text not null,             -- "Description"
  unit_count numeric,                  -- "Unit/Box" (pieces per box, e.g. 12, 96, 288)
  quantity numeric,                    -- "Qty" (how many units of `unit` were delivered)
  unit text,                           -- "UOM" ("BOX" or "PIECE")
  item_price numeric,                  -- "Sales Price"
  total_item_price numeric,            -- "Total" — extracted as printed, not recomputed
  raw_ocr_text text,
  created_at timestamptz default now(),
  -- item_code stays null when the receipt has no code (matches the frontend's
  -- DeliveryItem.item_code: string | null); duplicate detection falls back to
  -- a name-based key so a plain unique(delivery_code, item_code) still can't
  -- miss name-only duplicates (main-file.md §4's "open decision", resolved
  -- as option 1, matching the frontend's existing mock behavior).
  dedupe_key text generated always as (coalesce(item_code, 'name:' || lower(trim(item_name)))) stored,
  unique (delivery_code, dedupe_key)
);

create index if not exists delivery_items_store_item_code_idx on delivery_items (store_code, item_code);
create index if not exists delivery_items_store_item_name_idx on delivery_items (store_code, item_name);
create index if not exists delivery_items_store_created_at_idx on delivery_items (store_code, created_at);
create index if not exists deliveries_store_date_idx on deliveries (store_code, delivery_date);

-- This backend only ever talks to Supabase with the service_role key
-- (src/lib/supabase.ts), which bypasses RLS regardless of these settings.
-- Enabling RLS with no policies just locks the anon/publishable and
-- authenticated keys out of these tables entirely, since nothing in this
-- architecture is meant to hit Supabase directly except this server.
alter table stores enable row level security;
alter table deliveries enable row level security;
alter table delivery_items enable row level security;
