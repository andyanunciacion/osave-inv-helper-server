-- Adds stores.passcode_hash: each store's staff passcode, hashed (scrypt,
-- "scrypt$<salt hex>$<key hex>" — src/lib/passcode.ts). Every /api request
-- must carry the store code and its passcode (src/lib/store-auth.ts); a store
-- with no passcode can't be used at all. Set or change one with
-- `npm run store:passcode -- <store_code> [name]` (scripts/set-store-passcode.ts),
-- which also creates the store row if it doesn't exist yet.
--
-- `stores` already has RLS enabled with no policies, so the hash is only
-- readable by the service-role server, never through the anon/authenticated
-- PostgREST API.
--
-- Run manually in the Supabase SQL editor (there is no migration tooling
-- wired up — see CLAUDE.md). Safe to run more than once.

alter table public.stores add column if not exists passcode_hash text;
