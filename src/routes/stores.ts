import { Router } from "express";
import { authStoreCode } from "../lib/store-auth.js";
import { supabase } from "../lib/supabase.js";

export const storesRouter = Router();

// The store this request signed in as (frontend-contract.md §10). Reaching
// this handler at all means the code + passcode headers were accepted, so
// the frontend calls it to check a passcode when staff enter one. Stores are
// created and given passcodes with scripts/set-store-passcode.ts, not over
// the API — and there's no route listing every store.
storesRouter.get("/current", async (_req, res) => {
  const { data: store, error } = await supabase
    .from("stores")
    .select("store_code, name")
    .eq("store_code", authStoreCode(res))
    .single();

  if (error) {
    return res.status(500).json({ error: "internal_error", message: error.message });
  }

  res.json({ store });
});
