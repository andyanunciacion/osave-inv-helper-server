-- Adds deliveries.note: the staff's free-text note from the upload's success
-- screen. One per delivery, replaced on every save via
-- PATCH /api/deliveries/:delivery_code/note (frontend-contract.md §9).
--
-- No function changes needed: create_delivery returns to_jsonb(v_delivery),
-- and every read route selects the full row, so the column flows through.
--
-- Run manually in the Supabase SQL editor (there is no migration tooling
-- wired up — see CLAUDE.md). Safe to run more than once.

alter table public.deliveries add column if not exists note text;
