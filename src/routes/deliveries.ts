import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { createDeliverySchema, recentQuerySchema, updateDeliveryItemQuantitySchema } from "../validators/delivery.js";
import type { DeliveryItemInput } from "../validators/delivery.js";

export const deliveriesRouter = Router();

const DELIVERY_ITEM_COLUMNS =
  "id, delivery_code, store_code, item_code, item_name, unit_count, quantity, unit, item_price, total_item_price, raw_ocr_text, created_at";

const DELIVERY_ITEM_UPDATE_COLUMNS =
  "id, item_id, delivery_code, store_code, previous_quantity, new_quantity, reason, created_at";

interface MergedItemInfo {
  item_code: string | null;
  item_name: string;
  mergedCount: number;
  fieldsDisagreed: boolean;
}

const sumOrNull = (values: Array<number | null | undefined>): number | null => {
  const known = values.filter((v): v is number => v !== null && v !== undefined);
  return known.length === 0 ? null : known.reduce((total, v) => total + v, 0);
};

// The receipt itself can print the same item twice on one page (e.g. a
// beer-crate deposit line repeated). Per the store manager's ask, those rows
// get combined instead of the second being rejected as a duplicate — but
// only within this one submitted batch; an item that collides with a row
// already saved from an earlier page is still a genuine duplicate and falls
// through to the existing 23505 handling below.
//
// Grouped by the same key as delivery_items.dedupe_key (supabase/schema.sql)
// so a merge here can never hide a collision the DB would otherwise catch.
// `quantity` and `total_item_price` are summed — they're how many units and
// how much money this page recorded for the item. `unit_count` ("Unit/Box")
// is a packaging fact, not a count, so it's kept from the first occurrence,
// not summed: summing it alongside quantity would double-count in the
// Qty × Unit/Box × Price relationship (main-file.md §4) and make a correctly
// merged row fail its own price-mismatch check.
function mergeDuplicateItems(items: DeliveryItemInput[]): {
  items: DeliveryItemInput[];
  merged: MergedItemInfo[];
} {
  const groups = new Map<string, DeliveryItemInput[]>();
  for (const item of items) {
    const key = item.item_code ?? `name:${item.item_name.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const mergedItems: DeliveryItemInput[] = [];
  const merged: MergedItemInfo[] = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      mergedItems.push(group[0]);
      continue;
    }

    const [first, ...rest] = group;
    const fieldsDisagreed = rest.some(
      (row) =>
        row.item_name.trim().toLowerCase() !== first.item_name.trim().toLowerCase() ||
        (row.unit ?? null) !== (first.unit ?? null) ||
        (row.unit_count ?? null) !== (first.unit_count ?? null) ||
        (row.item_price ?? null) !== (first.item_price ?? null),
    );

    mergedItems.push({
      ...first,
      quantity: sumOrNull(group.map((row) => row.quantity)),
      total_item_price: sumOrNull(group.map((row) => row.total_item_price)),
    });
    merged.push({
      item_code: first.item_code ?? null,
      item_name: first.item_name,
      mergedCount: group.length,
      fieldsDisagreed,
    });
  }

  return { items: mergedItems, merged };
}

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

  // A receipt printed for another store must never be saved to this store's
  // records. Checked before anything is written, including the store upsert.
  if (input.receipt_store_code !== input.store_code) {
    return res.json({
      status: "store_mismatch",
      delivery: null,
      acceptedItems: [],
      rejectedItems: [],
      mergedItems: [],
    });
  }

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

  const duplicateDelivery = {
    status: "duplicate_delivery",
    delivery: null,
    acceptedItems: [],
    rejectedItems: [],
    mergedItems: [],
  };

  const { data: inserted, error: deliveryError } = await supabase
    .from("deliveries")
    .insert({
      delivery_code: input.delivery_code,
      store_code: input.store_code,
      warehouse_code: input.warehouse_code ?? null,
      delivery_date: input.delivery_date,
      receipt_store_code: input.receipt_store_code,
      uploaded_by: input.uploaded_by ?? null,
      status: "confirmed",
    })
    .select()
    .single();

  let delivery = inserted;
  let appending = false;

  if (deliveryError) {
    if (deliveryError.code !== "23505") {
      return res.status(500).json({ error: "internal_error", message: deliveryError.message });
    }

    // One receipt spans several photographed pages ("Page 10 of 12"), and
    // every page prints the same "Inv. Tran. No.". A later page for the same
    // store appends its items to the delivery already stored; the same code
    // under another store is a genuine duplicate.
    const { data: existing, error: existingError } = await supabase
      .from("deliveries")
      .select("*")
      .eq("delivery_code", input.delivery_code)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({ error: "internal_error", message: existingError.message });
    }
    if (!existing || existing.store_code !== input.store_code) {
      return res.json(duplicateDelivery);
    }
    delivery = existing;
    appending = true;
  }

  const { items: mergedInputItems, merged: mergedItems } = mergeDuplicateItems(input.items);

  const rowsToInsert = mergedInputItems.map((item) => ({
    delivery_code: input.delivery_code,
    store_code: input.store_code,
    item_code: item.item_code ?? null,
    item_name: item.item_name,
    unit_count: item.unit_count ?? null,
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

  // Nothing new on a page that appends to an existing delivery means this
  // exact page was already uploaded.
  if (appending && acceptedItems.length === 0) {
    return res.json(duplicateDelivery);
  }

  res.json({
    status: rejectedItems.length > 0 ? "partial" : "success",
    delivery,
    acceptedItems,
    rejectedItems,
    mergedItems,
  });
});

// Quantity-only correction for an already-confirmed item, with an audit
// record of the change (main-file.md §12's "edit log" suggestion — see
// CLAUDE.md for why this is scoped to quantity rather than a general PATCH).
deliveriesRouter.patch("/:delivery_code/items/:item_id", async (req, res) => {
  const parsed = updateDeliveryItemQuantitySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  }
  const { delivery_code, item_id } = req.params;
  const { quantity, reason } = parsed.data;

  const { data: existing, error: fetchError } = await supabase
    .from("delivery_items")
    .select(DELIVERY_ITEM_COLUMNS)
    .eq("id", item_id)
    .eq("delivery_code", delivery_code)
    .maybeSingle();

  if (fetchError) {
    return res.status(500).json({ error: "internal_error", message: fetchError.message });
  }
  if (!existing) {
    return res.status(404).json({ error: "not_found", message: "delivery item not found" });
  }

  const previousQuantity = existing.quantity;

  const { data: updated, error: updateError } = await supabase
    .from("delivery_items")
    .update({ quantity })
    .eq("id", item_id)
    .select(DELIVERY_ITEM_COLUMNS)
    .single();

  if (updateError) {
    return res.status(500).json({ error: "internal_error", message: updateError.message });
  }

  // No-op corrections (resubmitting the same value) don't get a history row —
  // there's nothing that actually changed to audit.
  let update: unknown = null;
  if (previousQuantity !== quantity) {
    const { data: historyRow, error: historyError } = await supabase
      .from("delivery_item_updates")
      .insert({
        item_id,
        delivery_code,
        store_code: existing.store_code,
        previous_quantity: previousQuantity,
        new_quantity: quantity,
        reason: reason ?? null,
      })
      .select(DELIVERY_ITEM_UPDATE_COLUMNS)
      .single();

    if (historyError) {
      return res.status(500).json({ error: "internal_error", message: historyError.message });
    }
    update = historyRow;
  }

  res.json({ item: updated, update });
});

// The audit trail for the route above — every quantity correction made to
// this item, most recent first.
deliveriesRouter.get("/:delivery_code/items/:item_id/history", async (req, res) => {
  const { delivery_code, item_id } = req.params;

  const { data: history, error } = await supabase
    .from("delivery_item_updates")
    .select(DELIVERY_ITEM_UPDATE_COLUMNS)
    .eq("delivery_code", delivery_code)
    .eq("item_id", item_id)
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: "internal_error", message: error.message });
  }

  res.json({ history: history ?? [] });
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
