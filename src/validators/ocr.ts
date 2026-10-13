import { z } from "zod";
import { normalizeStoreCode } from "../lib/normalize.js";

// Multipart text field sent alongside the "image" file part.
export const ocrBodySchema = z.object({
  store_code: z.string().trim().min(1).transform(normalizeStoreCode),
});

export type OcrBodyInput = z.infer<typeof ocrBodySchema>;

// One page's header as returned by a prior POST /api/ocr call — sent back
// as-is (not re-uploaded as an image) so /api/ocr/reconcile can cross-check
// sibling pages from the same multi-upload batch without another Vision call.
const draftHeaderSchema = z.object({
  delivery_code: z.string(),
  warehouse_code: z.string(),
  delivery_date: z.string(),
  receipt_store_code: z.string(),
  printout_datetime: z.string(),
});

export const ocrReconcileBodySchema = z.object({
  store_code: z.string().trim().min(1).transform(normalizeStoreCode),
  pages: z.array(draftHeaderSchema).min(1),
});

export type OcrReconcileBodyInput = z.infer<typeof ocrReconcileBodySchema>;
