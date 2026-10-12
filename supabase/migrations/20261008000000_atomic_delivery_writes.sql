-- Makes the two multi-statement writes atomic. Before this, each was several
-- PostgREST calls, so a failure partway through left half a write behind:
--   - POST /api/deliveries inserted the deliveries row, then the items; an
--     item failure left an empty delivery in recent uploads.
--   - PATCH /api/deliveries/:delivery_code/items/:item_id updated the
--     quantity, then inserted the audit row; an audit failure kept the new
--     quantity with no history, and a retry then saw no change to record.
-- Each is now one function, called via supabase.rpc, so it runs in a single
-- transaction. The routes still own validation, merging and response shape
-- (frontend-contract.md §2/§8); these only do the writes.
--
-- Run manually in the Supabase SQL editor (there is no migration tooling
-- wired up — see CLAUDE.md). Safe to run more than once.

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

notify pgrst, 'reload schema';
