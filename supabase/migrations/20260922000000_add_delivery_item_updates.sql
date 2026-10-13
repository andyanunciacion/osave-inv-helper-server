-- Adds delivery_item_updates, the audit trail for PATCH
-- /api/deliveries/:delivery_code/items/:item_id (quantity corrections only —
-- see CLAUDE.md). One row per correction: previous_quantity -> new_quantity,
-- plus an optional reason.
--
-- Run manually in the Supabase SQL editor (there is no migration tooling
-- wired up — see CLAUDE.md). Safe to run more than once.

create table if not exists public.delivery_item_updates (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.delivery_items(id),
  delivery_code text not null references public.deliveries(delivery_code),
  store_code text not null references public.stores(store_code),
  previous_quantity numeric,
  new_quantity numeric not null,
  reason text,
  created_at timestamptz default now()
);

create index if not exists delivery_item_updates_item_idx
  on public.delivery_item_updates (item_id, created_at);

alter table public.delivery_item_updates enable row level security;
