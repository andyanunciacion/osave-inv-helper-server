-- A quantity correction now recalculates the item's total in the same
-- transaction: round(new Qty × Unit/Box × Sales Price, 2), the receipt's own
-- arithmetic (main-file.md §4). It's left as it was when Unit/Box or the
-- price is missing. Before this, the PATCH only set quantity, so a corrected
-- row kept the printed total for the old quantity (e.g. "3 BOX" beside the
-- 2-box ₱2,712.00).
--
-- The history row records the total before and after, so the printed amount
-- isn't lost. Both columns are nullable: rows written before this migration
-- have neither.
--
-- Same function signature as 20261008000000_atomic_delivery_writes.sql, so a
-- server already deployed keeps working and gets the recalculation as soon
-- as this runs. Run this BEFORE deploying the server that selects the new
-- columns (DELIVERY_ITEM_UPDATE_COLUMNS in src/routes/deliveries.ts) — the
-- item history GET fails until they exist.
--
-- Run manually in the Supabase SQL editor (there is no migration tooling
-- wired up — see CLAUDE.md). Safe to run more than once.

alter table public.delivery_item_updates
  add column if not exists previous_total_item_price numeric,
  add column if not exists new_total_item_price numeric;

-- Returns null when p_item_id isn't under p_delivery_code. Otherwise
-- { item, update }; update is null when the quantity didn't change — a
-- no-op isn't audited, and it leaves the total alone too.
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
  v_before public.delivery_items;
  v_item public.delivery_items;
  v_update jsonb;
begin
  -- Locked so two concurrent corrections can't both read the same
  -- previous quantity and total.
  select * into v_before
  from public.delivery_items
  where id = p_item_id and delivery_code = p_delivery_code
  for update;

  if not found then
    return null;
  end if;

  -- Resubmitting the same quantity changes nothing. Recalculating here would
  -- silently replace a printed total that was off by rounding, with no
  -- history row to show it.
  if v_before.quantity is not distinct from p_quantity then
    return jsonb_build_object(
      'item', to_jsonb(v_before) - 'dedupe_key',
      'update', null
    );
  end if;

  update public.delivery_items
  set quantity = p_quantity,
      total_item_price = case
        when unit_count is null or item_price is null then total_item_price
        else round(p_quantity * unit_count * item_price, 2)
      end
  where id = p_item_id
  returning * into v_item;

  insert into public.delivery_item_updates as u (
    item_id, delivery_code, store_code, previous_quantity, new_quantity,
    previous_total_item_price, new_total_item_price, reason
  )
  values (
    p_item_id, p_delivery_code, v_item.store_code, v_before.quantity, p_quantity,
    v_before.total_item_price, v_item.total_item_price, p_reason
  )
  returning to_jsonb(u) into v_update;

  return jsonb_build_object(
    'item', to_jsonb(v_item) - 'dedupe_key',
    'update', v_update
  );
end;
$$;

-- create or replace keeps the existing grants; repeated so this file stands
-- on its own.
revoke execute on function public.update_delivery_item_quantity(text, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.update_delivery_item_quantity(text, uuid, numeric, text) to service_role;

notify pgrst, 'reload schema';
