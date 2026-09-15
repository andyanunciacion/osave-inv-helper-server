import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { searchQuerySchema } from "../validators/delivery.js";

export const searchRouter = Router();

const DELIVERY_ITEM_COLUMNS =
  "id, delivery_code, store_code, item_code, item_name, quantity, unit, item_price, total_item_price, raw_ocr_text, created_at";

const GROUPED_DEFAULT_LIMIT = 15;
const UNIFIED_DEFAULT_LIMIT = 50;

type Delivery = {
  delivery_code: string;
  store_code: string;
  warehouse_code: string | null;
  delivery_date: string;
  receipt_store_code: string | null;
  uploaded_by: string | null;
  status: string;
  created_at: string;
};

type ItemRow = {
  id: string;
  delivery_code: string;
  item_code: string | null;
  item_name: string;
  quantity: number | null;
  unit: string | null;
  item_price: number | null;
  total_item_price: number | null;
  created_at: string;
};

// Mirrors the frontend's compareByItemCode (features/deliveries/lib/sort.ts):
// null item_code sorts first, then natural/numeric locale compare so
// "SAN-2" sorts before "SAN-10".
function byItemCode(a: { item_code: string | null }, b: { item_code: string | null }): number {
  if (a.item_code === null && b.item_code === null) return 0;
  if (a.item_code === null) return -1;
  if (b.item_code === null) return 1;
  return a.item_code.localeCompare(b.item_code, undefined, { numeric: true, sensitivity: "base" });
}

function escapeForIlike(value: string): string {
  return `"%${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}%"`;
}

searchRouter.get("/", async (req, res) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_query", issues: parsed.error.issues });
  }

  const { store_code, q, date, dateFrom, dateTo, page } = parsed.data;

  // Date-only mode: unified flat list of items across every matching delivery.
  if (!q) {
    const limit = parsed.data.limit ?? UNIFIED_DEFAULT_LIMIT;

    let deliveryQuery = supabase
      .from("deliveries")
      .select("delivery_code, delivery_date")
      .eq("store_code", store_code);
    if (date) deliveryQuery = deliveryQuery.eq("delivery_date", date);
    if (dateFrom) deliveryQuery = deliveryQuery.gte("delivery_date", dateFrom);
    if (dateTo) deliveryQuery = deliveryQuery.lte("delivery_date", dateTo);

    const { data: matchingDeliveries, error: deliveriesError } = await deliveryQuery;
    if (deliveriesError) {
      return res.status(500).json({ error: "internal_error", message: deliveriesError.message });
    }

    const dateByCode = new Map((matchingDeliveries ?? []).map((d) => [d.delivery_code, d.delivery_date]));
    const codes = Array.from(dateByCode.keys());
    if (codes.length === 0) {
      return res.json({ mode: "unified", items: [], pagination: { page, limit, total: 0 } });
    }

    const { data: items, error: itemsError } = await supabase
      .from("delivery_items")
      .select(DELIVERY_ITEM_COLUMNS)
      .eq("store_code", store_code)
      .in("delivery_code", codes);

    if (itemsError) {
      return res.status(500).json({ error: "internal_error", message: itemsError.message });
    }

    const unifiedItems = ((items ?? []) as ItemRow[])
      .map((item) => ({ ...item, delivery_date: dateByCode.get(item.delivery_code) as string }))
      .sort((a, b) => {
        if (a.delivery_date !== b.delivery_date) return a.delivery_date < b.delivery_date ? 1 : -1;
        return byItemCode(a, b);
      });

    const total = unifiedItems.length;
    const from = (page - 1) * limit;
    const pageItems = unifiedItems.slice(from, from + limit);

    return res.json({ mode: "unified", items: pageItems, pagination: { page, limit, total } });
  }

  const limit = parsed.data.limit ?? GROUPED_DEFAULT_LIMIT;
  const normalizedQuery = q.toLowerCase();

  // Free-text mode. Matches the real frontend hook (use-delivery-search.ts),
  // not the (admittedly stale, per frontend-contract.md's own warning) "only
  // matched items" description for a delivery-code hit: any match on
  // delivery_code — fragment or exact — shows every item in that delivery;
  // only an exact match additionally auto-expands it. An item_code/item_name
  // match on a delivery whose code didn't match shows just the matched rows.
  const escaped = escapeForIlike(q);

  const { data: matchedItems, error: matchedItemsError } = await supabase
    .from("delivery_items")
    .select(DELIVERY_ITEM_COLUMNS)
    .eq("store_code", store_code)
    .or(`item_code.ilike.${escaped},item_name.ilike.${escaped}`);

  if (matchedItemsError) {
    return res.status(500).json({ error: "internal_error", message: matchedItemsError.message });
  }

  let codeMatchQuery = supabase
    .from("deliveries")
    .select("delivery_code")
    .eq("store_code", store_code)
    .ilike("delivery_code", `%${q}%`);
  if (date) codeMatchQuery = codeMatchQuery.eq("delivery_date", date);
  if (dateFrom) codeMatchQuery = codeMatchQuery.gte("delivery_date", dateFrom);
  if (dateTo) codeMatchQuery = codeMatchQuery.lte("delivery_date", dateTo);

  const { data: codeMatches, error: codeMatchError } = await codeMatchQuery;
  if (codeMatchError) {
    return res.status(500).json({ error: "internal_error", message: codeMatchError.message });
  }

  const itemMatchesByDelivery = new Map<string, ItemRow[]>();
  for (const item of (matchedItems ?? []) as ItemRow[]) {
    const list = itemMatchesByDelivery.get(item.delivery_code) ?? [];
    list.push(item);
    itemMatchesByDelivery.set(item.delivery_code, list);
  }

  const codeMatchedCodes = new Set((codeMatches ?? []).map((d) => d.delivery_code));
  const allCodes = new Set<string>([...itemMatchesByDelivery.keys(), ...codeMatchedCodes]);

  if (allCodes.size === 0) {
    return res.json({ mode: "grouped", groups: [], pagination: { page, limit, total: 0 } });
  }

  const fullItemsByDelivery = new Map<string, ItemRow[]>();
  if (codeMatchedCodes.size > 0) {
    const { data: fullItems, error: fullItemsError } = await supabase
      .from("delivery_items")
      .select(DELIVERY_ITEM_COLUMNS)
      .in("delivery_code", Array.from(codeMatchedCodes));

    if (fullItemsError) {
      return res.status(500).json({ error: "internal_error", message: fullItemsError.message });
    }

    for (const item of (fullItems ?? []) as ItemRow[]) {
      const list = fullItemsByDelivery.get(item.delivery_code) ?? [];
      list.push(item);
      fullItemsByDelivery.set(item.delivery_code, list);
    }
  }

  let deliveriesQuery = supabase.from("deliveries").select("*").in("delivery_code", Array.from(allCodes));
  if (date) deliveriesQuery = deliveriesQuery.eq("delivery_date", date);
  if (dateFrom) deliveriesQuery = deliveriesQuery.gte("delivery_date", dateFrom);
  if (dateTo) deliveriesQuery = deliveriesQuery.lte("delivery_date", dateTo);

  const { data: deliveries, error: deliveriesFullError } = await deliveriesQuery;
  if (deliveriesFullError) {
    return res.status(500).json({ error: "internal_error", message: deliveriesFullError.message });
  }

  const groups = ((deliveries ?? []) as Delivery[])
    .map((delivery) => {
      const isCodeMatch = codeMatchedCodes.has(delivery.delivery_code);
      const displayItems = (
        isCodeMatch
          ? (fullItemsByDelivery.get(delivery.delivery_code) ?? [])
          : (itemMatchesByDelivery.get(delivery.delivery_code) ?? [])
      ).sort(byItemCode);
      return {
        delivery,
        items: displayItems,
        displayItems,
        autoExpand: isCodeMatch && delivery.delivery_code.toLowerCase() === normalizedQuery,
      };
    })
    .sort((a, b) => (a.delivery.delivery_date < b.delivery.delivery_date ? 1 : -1));

  const total = groups.length;
  const from = (page - 1) * limit;
  const pageGroups = groups.slice(from, from + limit);

  res.json({ mode: "grouped", groups: pageGroups, pagination: { page, limit, total } });
});
