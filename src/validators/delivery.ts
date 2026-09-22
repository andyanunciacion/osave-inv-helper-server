import { z } from "zod";
import { normalizeStoreCode } from "../lib/normalize.js";

export const deliveryItemSchema = z.object({
  item_code: z.string().trim().min(1).nullish(),
  item_name: z.string().trim().min(1),
  unit_count: z.number().nonnegative().nullish(),
  quantity: z.number().nonnegative().nullish(),
  unit: z.enum(["BOX", "PIECE"]).nullish(),
  item_price: z.number().nonnegative().nullish(),
  total_item_price: z.number().nonnegative().nullish(),
});

export const createDeliverySchema = z.object({
  delivery_code: z.string().trim().min(1),
  store_code: z.string().trim().min(1).transform(normalizeStoreCode),
  warehouse_code: z.string().trim().nullish(),
  delivery_date: z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
    message: "delivery_date must be a valid date",
  }),
  receipt_store_code: z.string().trim().min(1).transform(normalizeStoreCode),
  uploaded_by: z.string().trim().nullish(),
  items: z.array(deliveryItemSchema).min(1),
});

export type CreateDeliveryInput = z.infer<typeof createDeliverySchema>;
export type DeliveryItemInput = z.infer<typeof deliveryItemSchema>;

export const updateDeliveryItemQuantitySchema = z.object({
  quantity: z.number().nonnegative(),
  reason: z.string().trim().min(1).nullish(),
});

export type UpdateDeliveryItemQuantityInput = z.infer<typeof updateDeliveryItemQuantitySchema>;

export const searchQuerySchema = z
  .object({
    store_code: z.string().trim().min(1).transform(normalizeStoreCode),
    q: z.string().trim().optional(),
    date: z.string().optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((v) => Boolean(v.q) || Boolean(v.date) || Boolean(v.dateFrom) || Boolean(v.dateTo), {
    message: "Provide a search query (q) and/or a date filter",
  });

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;

export const recentQuerySchema = z.object({
  store_code: z.string().trim().min(1).transform(normalizeStoreCode),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

export type RecentQueryInput = z.infer<typeof recentQuerySchema>;
