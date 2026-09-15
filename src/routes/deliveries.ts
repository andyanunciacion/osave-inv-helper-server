import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { createDeliverySchema, recentQuerySchema } from "../validators/delivery.js";

export const deliveriesRouter = Router();

const DELIVERY_ITEM_COLUMNS =
  "id, delivery_code, store_code, item_code, item_name, quantity, unit, item_price, total_item_price, raw_ocr_text, created_at";

// Registered before "/:delivery_code" so "recent" isn't swallowed by the param route.
deliveriesRouter.get("/recent", async (req, res) => {
  const parsed = recentQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
  }
  const { store_code, limit } = parsed.data;

  const { data: deliveries, error: deliveriesError } = await supabase
    .from("deliveries")
    .select("*")
    .eq("store_code", store_code)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (deliveriesError) {
    return res.status(500).json({ error: "internal_error", message: deliveriesError.message });
  }

  const codes = (deliveries ?? []).map((d) => d.delivery_code);
  const itemsByDelivery = new Map<string, unknown[]>();

  if (codes.length > 0) {
    const { data: items, error: itemsError } = await supabase
      .from("delivery_items")
      .select(DELIVERY_ITEM_COLUMNS)
      .in("delivery_code", codes);

    if (itemsError) {
      return res.status(500).json({ error: "internal_error", message: itemsError.message });
    }

    for (const item of items ?? []) {
      const list = itemsByDelivery.get(item.delivery_code) ?? [];
      list.push(item);
      itemsByDelivery.set(item.delivery_code, list);
    }
  }

  const groups = (deliveries ?? []).map((delivery) => ({
    delivery,
    items: itemsByDelivery.get(delivery.delivery_code) ?? [],
  }));

  res.json({ groups });
});

deliveriesRouter.post("/", async (req, res) => {
  const parsed = createDeliverySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  }

  const input = parsed.data;

  // The frontend's store-session flow never registers a store ahead of time —
  // staff just type/scan a code and start uploading (main-file.md §6 flow A).
  // Auto-register it here so deliveries.store_code's FK doesn't block the
  // first delivery for a new store; ignoreDuplicates means an existing
  // store's name is never overwritten.
  const { error: storeUpsertError } = await supabase
    .from("stores")
    .upsert({ store_code: input.store_code, name: input.store_code }, { onConflict: "store_code", ignoreDuplicates: true });

  if (storeUpsertError) {
    return res.status(500).json({ error: "internal_error", message: storeUpsertError.message });
  }

  const { data: delivery, error: deliveryError } = await supabase
    .from("deliveries")
    .insert({
      delivery_code: input.delivery_code,
      store_code: input.store_code,
      warehouse_code: input.warehouse_code ?? null,
      delivery_date: input.delivery_date,
      receipt_store_code: input.receipt_store_code ?? null,
      uploaded_by: input.uploaded_by ?? null,
      status: "confirmed",
    })
    .select()
    .single();

  if (deliveryError) {
    if (deliveryError.code === "23505") {
      return res.json({
        status: "duplicate_delivery",
        delivery: null,
        acceptedItems: [],
        rejectedItems: [],
      });
    }
    return res.status(500).json({ error: "internal_error", message: deliveryError.message });
  }

  const rowsToInsert = input.items.map((item) => ({
    delivery_code: input.delivery_code,
    store_code: input.store_code,
    item_code: item.item_code ?? null,
    item_name: item.item_name,
    quantity: item.quantity ?? null,
    unit: item.unit ?? null,
    item_price: item.item_price ?? null,
    total_item_price: item.total_item_price ?? null,
  }));

  const acceptedItems: unknown[] = [];
  const rejectedItems: Array<{ item_code: string | null; item_name: string; reason: "duplicate_item_code" }> = [];

  const { data: insertedAll, error: bulkError } = await supabase
    .from("delivery_items")
    .insert(rowsToInsert)
    .select(DELIVERY_ITEM_COLUMNS);

  if (!bulkError) {
    acceptedItems.push(...(insertedAll ?? []));
  } else if (bulkError.code === "23505") {
    // Fall back to per-row inserts so a duplicate is rejected on its own row
    // instead of failing the whole batch (main-file.md §5 rule 5).
    for (const row of rowsToInsert) {
      const { data: inserted, error: rowError } = await supabase
        .from("delivery_items")
        .insert(row)
        .select(DELIVERY_ITEM_COLUMNS)
        .single();

      if (rowError) {
        if (rowError.code === "23505") {
          rejectedItems.push({
            item_code: row.item_code,
            item_name: row.item_name,
            reason: "duplicate_item_code",
          });
        } else {
          return res.status(500).json({ error: "internal_error", message: rowError.message });
        }
      } else {
        acceptedItems.push(inserted);
      }
    }
  } else {
    return res.status(500).json({ error: "internal_error", message: bulkError.message });
  }

  res.json({
    status: rejectedItems.length > 0 ? "partial" : "success",
    delivery,
    acceptedItems,
    rejectedItems,
  });
});

deliveriesRouter.get("/:delivery_code", async (req, res) => {
  const { delivery_code } = req.params;

  const { data: delivery, error: deliveryError } = await supabase
    .from("deliveries")
    .select("*")
    .eq("delivery_code", delivery_code)
    .maybeSingle();

  if (deliveryError) {
    return res.status(500).json({ error: "internal_error", message: deliveryError.message });
  }
  if (!delivery) {
    return res.status(404).json({ error: "not_found", message: "delivery not found" });
  }

  const { data: items, error: itemsError } = await supabase
    .from("delivery_items")
    .select(DELIVERY_ITEM_COLUMNS)
    .eq("delivery_code", delivery_code)
    .order("item_code");

  if (itemsError) {
    return res.status(500).json({ error: "internal_error", message: itemsError.message });
  }

  res.json({ delivery, items });
});
