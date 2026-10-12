import { Router } from "express";
import { selectAll } from "../lib/select-all.js";
import { supabase } from "../lib/supabase.js";
import {
  createDeliverySchema,
  deliveryItemParamsSchema,
  recentQuerySchema,
  updateDeliveryItemQuantitySchema,
  updateDeliveryNoteSchema,
} from "../validators/delivery.js";
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
// through to create_delivery's rejected_items below.
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
    // A full delivery runs to ~600 items, so five of them pass PostgREST's
    // row cap — page through instead of trusting one response.
    const { data: items, error: itemsError } = await selectAll((from, to) =>
      supabase.from("delivery_items").select(DELIVERY_ITEM_COLUMNS).in("delivery_code", codes).order("id").range(from, to),
    );

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

  const duplicateDelivery = {
    status: "duplicate_delivery",
    delivery: null,
    acceptedItems: [],
    rejectedItems: [],
    mergedItems: [],
  };

  const { items: mergedInputItems, merged: mergedItems } = mergeDuplicateItems(input.items);

  // One transaction (supabase/migrations/20261008000000_atomic_delivery_writes.sql):
  // auto-registers the store (staff never register one ahead of time,
  // main-file.md §6 flow A), creates the delivery or — when this store
  // already has it — appends to it, since every photographed page of one
  // receipt prints the same "Inv. Tran. No.". The same code under another
  // store is a genuine duplicate. An item already saved on the delivery is
  // skipped and comes back in rejected_items instead of failing the batch
  // (main-file.md §5 rule 5). A failure writes nothing.
  const { data: result, error } = await supabase.rpc("create_delivery", {
    p_delivery_code: input.delivery_code,
    p_store_code: input.store_code,
    p_warehouse_code: input.warehouse_code ?? null,
    p_delivery_date: input.delivery_date,
    p_receipt_store_code: input.receipt_store_code,
    p_uploaded_by: input.uploaded_by ?? null,
    p_items: mergedInputItems.map((item) => ({
      item_code: item.item_code ?? null,
      item_name: item.item_name,
      unit_count: item.unit_count ?? null,
      quantity: item.quantity ?? null,
      unit: item.unit ?? null,
      item_price: item.item_price ?? null,
      total_item_price: item.total_item_price ?? null,
    })),
  });

  if (error) {
    return res.status(500).json({ error: "internal_error", message: error.message });
  }
  if (result.duplicate) {
    return res.json(duplicateDelivery);
  }

  const acceptedItems: unknown[] = result.accepted_items;
  const rejectedItems = (result.rejected_items as Array<{ item_code: string | null; item_name: string }>).map(
    (item) => ({ ...item, reason: "duplicate_item_code" as const }),
  );

  // Nothing new on a page that appends to an existing delivery means this
  // exact page was already uploaded.
  if (result.appending && acceptedItems.length === 0) {
    return res.json(duplicateDelivery);
  }

  res.json({
    status: rejectedItems.length > 0 ? "partial" : "success",
    delivery: result.delivery,
    acceptedItems,
    rejectedItems,
    mergedItems,
  });
});

// The staff's note on a delivery (frontend-contract.md §9): one per delivery,
// replaced on every save. Unlike the quantity PATCH below, this is scoped to
// store_code, so one store can't write to another's delivery. No history row —
// the note is the staff's own remark, not delivered data.
deliveriesRouter.patch("/:delivery_code/note", async (req, res) => {
  const parsed = updateDeliveryNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  }
  const { delivery_code } = req.params;
  const { store_code, note } = parsed.data;

  const { data: delivery, error } = await supabase
    .from("deliveries")
    .update({ note })
    .eq("delivery_code", delivery_code)
    .eq("store_code", store_code)
    .select("*")
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: "internal_error", message: error.message });
  }
  if (!delivery) {
    return res.status(404).json({ error: "not_found", message: "delivery not found" });
  }

  res.json({ delivery });
});

// Quantity-only correction for an already-confirmed item, with an audit
// record of the change (main-file.md §12's "edit log" suggestion — see
// CLAUDE.md for why this is scoped to quantity rather than a general PATCH).
deliveriesRouter.patch("/:delivery_code/items/:item_id", async (req, res) => {
  // A malformed item_id can't name a row; without this, Postgres rejects the
  // uuid cast (22P02) and it surfaces as a 500.
  const params = deliveryItemParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(404).json({ error: "not_found", message: "delivery item not found" });
  }
  const parsed = updateDeliveryItemQuantitySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  }
  const { delivery_code, item_id } = params.data;
  const { quantity, reason } = parsed.data;

  // The quantity change and its history row are one transaction
  // (supabase/migrations/20261008000000_atomic_delivery_writes.sql), so a
  // failed audit insert can't leave the new quantity behind unrecorded.
  // No-op corrections (resubmitting the same value) don't get a history row —
  // there's nothing that actually changed to audit.
  const { data: result, error } = await supabase.rpc("update_delivery_item_quantity", {
    p_delivery_code: delivery_code,
    p_item_id: item_id,
    p_quantity: quantity,
    p_reason: reason ?? null,
  });

  if (error) {
    return res.status(500).json({ error: "internal_error", message: error.message });
  }
  if (!result) {
    return res.status(404).json({ error: "not_found", message: "delivery item not found" });
  }

  res.json({ item: result.item, update: result.update });
});

// The audit trail for the route above — every quantity correction made to
// this item, most recent first.
deliveriesRouter.get("/:delivery_code/items/:item_id/history", async (req, res) => {
  // A malformed item_id has no history, same as an unknown one.
  const params = deliveryItemParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.json({ history: [] });
  }
  const { delivery_code, item_id } = params.data;

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

  const { data: items, error: itemsError } = await selectAll((from, to) =>
    supabase
      .from("delivery_items")
      .select(DELIVERY_ITEM_COLUMNS)
      .eq("delivery_code", delivery_code)
      .order("item_code")
      .order("id")
      .range(from, to),
  );

  if (itemsError) {
    return res.status(500).json({ error: "internal_error", message: itemsError.message });
  }

  res.json({ delivery, items });
});
