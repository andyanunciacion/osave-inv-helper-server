import { Router } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { normalizeStoreCode } from "../lib/normalize.js";

export const storesRouter = Router();

storesRouter.get("/", async (_req, res) => {
  const { data, error } = await supabase.from("stores").select("*").order("store_code");

  if (error) {
    return res.status(500).json({ error: "internal_error", message: error.message });
  }

  res.json({ stores: data });
});

const createStoreSchema = z.object({
  store_code: z.string().trim().min(1).transform(normalizeStoreCode),
  name: z.string().trim().min(1),
});

storesRouter.post("/", async (req, res) => {
  const parsed = createStoreSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  }

  const { data, error } = await supabase.from("stores").insert(parsed.data).select().single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "duplicate_store", message: "store_code already exists" });
    }
    return res.status(500).json({ error: "internal_error", message: error.message });
  }

  res.status(201).json({ store: data });
});
