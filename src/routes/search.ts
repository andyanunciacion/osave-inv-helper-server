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

function byItemCode(a: { item_code: string | null }, b: { item_code: string | null }): number {
  return (a.item_code ?? "").localeCompare(b.item_code ?? "");
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

  // Free-text mode: check for an exact delivery_code match first (auto-expands).
  let exactQuery = supabase
    .from("deliveries")
    .select("*")
    .eq("store_code", store_code)
    .ilike("delivery_code", q);
  if (date) exactQuery = exactQuery.eq("delivery_date", date);
  if (dateFrom) exactQuery = exactQuery.gte("delivery_date", dateFrom);
  if (dateTo) exactQuery = exactQuery.lte("delivery_date", dateTo);

  const { data: exactDelivery, error: exactError } = await exactQuery.maybeSingle();
  if (exactError) {
    return res.status(500).json({ error: "internal_error", message: exactError.message });
  }

  if (exactDelivery) {
    const { data: items, error: itemsError } = await supabase
      .from("delivery_items")
      .select(DELIVERY_ITEM_COLUMNS)
      .eq("delivery_code", exactDelivery.delivery_code)
      .order("item_code");

    if (itemsError) {
      return res.status(500).json({ error: "internal_error", message: itemsError.message });
    }

    return res.json({
      mode: "grouped",
      groups: [
        {
          delivery: exactDelivery as Delivery,
          items: items ?? [],
          displayItems: items ?? [],
          autoExpand: true,
        },
      ],
      pagination: { page: 1, limit, total: 1 },
    });
  }

  // Broad match: item_code/item_name matches, plus delivery_code fragment matches.
  const escaped = escapeForIlike(q);

  const { data: matchedItems, error: matchedItemsError } = await supabase
    .from("delivery_items")
    .select(DELIVERY_ITEM_COLUMNS)
    .eq("store_code", store_code)
    .or(`item_code.ilike.${escaped},item_name.ilike.${escaped}`);

  if (matchedItemsError) {
    return res.status(500).json({ error: "internal_error", message: matchedItemsError.message });
  }

  let codeFragmentQuery = supabase
    .from("deliveries")
    .select("delivery_code")
    .eq("store_code", store_code)
    .ilike("delivery_code", `%${q}%`);
  if (date) codeFragmentQuery = codeFragmentQuery.eq("delivery_date", date);
  if (dateFrom) codeFragmentQuery = codeFragmentQuery.gte("delivery_date", dateFrom);
  if (dateTo) codeFragmentQuery = codeFragmentQuery.lte("delivery_date", dateTo);

  const { data: codeFragmentMatches, error: codeFragmentError } = await codeFragmentQuery;
  if (codeFragmentError) {
    return res.status(500).json({ error: "internal_error", message: codeFragmentError.message });
  }

  const itemsByDelivery = new Map<string, ItemRow[]>();
  for (const item of (matchedItems ?? []) as ItemRow[]) {
    const list = itemsByDelivery.get(item.delivery_code) ?? [];
    list.push(item);
    itemsByDelivery.set(item.delivery_code, list);
  }

  const allCodes = new Set<string>([
    ...itemsByDelivery.keys(),
    ...(codeFragmentMatches ?? []).map((d) => d.delivery_code),
  ]);

  if (allCodes.size === 0) {
    return res.json({ mode: "grouped", groups: [], pagination: { page, limit, total: 0 } });
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
      const displayItems = (itemsByDelivery.get(delivery.delivery_code) ?? []).sort(byItemCode);
      return {
        delivery,
        items: displayItems,
        displayItems,
        autoExpand: false,
      };
    })
    .sort((a, b) => (a.delivery.delivery_date < b.delivery.delivery_date ? 1 : -1));

  const total = groups.length;
  const from = (page - 1) * limit;
  const pageGroups = groups.slice(from, from + limit);

  res.json({ mode: "grouped", groups: pageGroups, pagination: { page, limit, total } });
});
