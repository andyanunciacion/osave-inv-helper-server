-- Adds delivery_items.unit_count for the receipt's "Unit/Box" column.
--
-- Until now `quantity` was fed from "Unit/Box" and the receipt's separate
-- "Qty" column had nowhere to go. From here on:
--   unit_count = "Unit/Box"  (pieces per box)
--   quantity   = "Qty"       (how many boxes/pieces were delivered)
--
-- Run manually in the Supabase SQL editor (there is no migration tooling
-- wired up — see CLAUDE.md). Safe to run more than once: the backfill only
-- happens in the run that actually adds the column.

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'delivery_items'
      and column_name = 'unit_count'
  ) then
    alter table public.delivery_items add column unit_count numeric;

    -- Existing rows stored "Unit/Box" in `quantity`; copy it across.
    update public.delivery_items
    set unit_count = quantity
    where quantity is not null;

    -- Optional: those old `quantity` values are really Unit/Box, so they no
    -- longer mean "Qty". Uncomment to clear them (unit_count keeps the data).
    -- update public.delivery_items set quantity = null;
  end if;
end $$;
