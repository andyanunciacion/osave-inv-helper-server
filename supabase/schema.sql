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
  note text,                           -- staff's free-text note from the upload's
                                        -- success screen; replaced on each save
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

-- One row per quantity correction made to a confirmed delivery_items row
-- (main-file.md §12's "edit log" suggestion). Item edits are intentionally
-- narrow (quantity only, see CLAUDE.md) so this table only ever tracks a
-- before/after quantity pair, not a generic field-diff.
create table if not exists delivery_item_updates (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references delivery_items(id),
  delivery_code text not null references deliveries(delivery_code),
  store_code text not null references stores(store_code),  -- denormalized, matches delivery_items
  previous_quantity numeric,
  new_quantity numeric not null,
  reason text,
  created_at timestamptz default now()
);

create index if not exists delivery_item_updates_item_idx on delivery_item_updates (item_id, created_at);

-- This backend only ever talks to Supabase with the service_role key
-- (src/lib/supabase.ts), which bypasses RLS regardless of these settings.
-- Enabling RLS with no policies just locks the anon/publishable and
-- authenticated keys out of these tables entirely, since nothing in this
-- architecture is meant to hit Supabase directly except this server.
alter table stores enable row level security;
alter table deliveries enable row level security;
alter table delivery_items enable row level security;
alter table delivery_item_updates enable row level security;

-- The transactional writes behind POST /api/deliveries and the quantity
-- PATCH (added by migrations/20261008000000_atomic_delivery_writes.sql).

-- Returns { duplicate: true } when delivery_code already belongs to another
-- store. Otherwise { delivery, appending, accepted_items, rejected_items }:
-- appending is true when the delivery already existed (a later page of the
-- same receipt); an item whose dedupe_key is already on the delivery is
-- skipped and listed in rejected_items instead of failing the batch
-- (main-file.md §5 rule 5). p_items must already be merged by dedupe_key
-- (mergeDuplicateItems in src/routes/deliveries.ts).
create or replace function public.create_delivery(
  p_delivery_code text,
  p_store_code text,
  p_warehouse_code text,
  p_delivery_date date,
  p_receipt_store_code text,
  p_uploaded_by text,
  p_items jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_delivery public.deliveries;
  v_appending boolean := false;
  v_accepted jsonb;
  v_rejected jsonb;
begin
  -- Staff never register a store ahead of time (main-file.md §6 flow A);
  -- an existing store's name is never overwritten.
  insert into public.stores (store_code, name)
  values (p_store_code, p_store_code)
  on conflict (store_code) do nothing;

  insert into public.deliveries (
    delivery_code, store_code, warehouse_code, delivery_date,
    receipt_store_code, uploaded_by, status
  )
  values (
    p_delivery_code, p_store_code, p_warehouse_code, p_delivery_date,
    p_receipt_store_code, p_uploaded_by, 'confirmed'
  )
  on conflict (delivery_code) do nothing
  returning * into v_delivery;

  if not found then
    select * into v_delivery
    from public.deliveries
    where delivery_code = p_delivery_code;

    if v_delivery.store_code is distinct from p_store_code then
      return jsonb_build_object('duplicate', true);
    end if;
    v_appending := true;
  end if;

  with input as (
    select
      e.ord,
      e.item->>'item_code' as item_code,
      e.item->>'item_name' as item_name,
      (e.item->>'unit_count')::numeric as unit_count,
      (e.item->>'quantity')::numeric as quantity,
      e.item->>'unit' as unit,
      (e.item->>'item_price')::numeric as item_price,
      (e.item->>'total_item_price')::numeric as total_item_price,
      -- Same expression as delivery_items.dedupe_key.
      coalesce(e.item->>'item_code', 'name:' || lower(trim(e.item->>'item_name'))) as dedupe_key
    from jsonb_array_elements(p_items) with ordinality as e(item, ord)
  ),
  inserted as (
    insert into public.delivery_items (
      delivery_code, store_code, item_code, item_name, unit_count,
      quantity, unit, item_price, total_item_price
    )
    select
      p_delivery_code, p_store_code, item_code, item_name, unit_count,
      quantity, unit, item_price, total_item_price
    from input
    order by ord
    on conflict (delivery_code, dedupe_key) do nothing
    returning *
  )
  select
    coalesce(
      (select jsonb_agg(to_jsonb(ins) - 'dedupe_key' order by i.ord)
       from inserted ins join input i on i.dedupe_key = ins.dedupe_key),
      '[]'::jsonb
    ),
    coalesce(
      (select jsonb_agg(
                jsonb_build_object('item_code', i.item_code, 'item_name', i.item_name)
                order by i.ord)
       from input i
       where not exists (select 1 from inserted ins where ins.dedupe_key = i.dedupe_key)),
      '[]'::jsonb
    )
  into v_accepted, v_rejected;

  return jsonb_build_object(
    'delivery', to_jsonb(v_delivery),
    'appending', v_appending,
    'accepted_items', v_accepted,
    'rejected_items', v_rejected
  );
end;
$$;

-- Returns null when p_item_id isn't under p_delivery_code. Otherwise
-- { item, update }; update is null when the quantity didn't change — a
-- no-op isn't audited.
create or replace function public.update_delivery_item_quantity(
  p_delivery_code text,
  p_item_id uuid,
  p_quantity numeric,
  p_reason text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_previous numeric;
  v_item public.delivery_items;
  v_update jsonb;
begin
  -- Locked so two concurrent corrections can't both read the same
  -- previous_quantity.
  select quantity into v_previous
  from public.delivery_items
  where id = p_item_id and delivery_code = p_delivery_code
  for update;

  if not found then
    return null;
  end if;

  update public.delivery_items
  set quantity = p_quantity
  where id = p_item_id
  returning * into v_item;

  if v_previous is distinct from p_quantity then
    insert into public.delivery_item_updates as u (
      item_id, delivery_code, store_code, previous_quantity, new_quantity, reason
    )
    values (
      p_item_id, p_delivery_code, v_item.store_code, v_previous, p_quantity, p_reason
    )
    returning to_jsonb(u) into v_update;
  end if;

  return jsonb_build_object(
    'item', to_jsonb(v_item) - 'dedupe_key',
    'update', v_update
  );
end;
$$;

-- Supabase grants execute on new public functions to anon/authenticated,
-- which would expose these through the public API. Only this server (the
-- service_role key) calls them.
revoke execute on function public.create_delivery(text, text, text, date, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.update_delivery_item_quantity(text, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.create_delivery(text, text, text, date, text, text, jsonb) to service_role;
grant execute on function public.update_delivery_item_quantity(text, uuid, numeric, text) to service_role;
