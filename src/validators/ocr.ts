import { z } from "zod";
import { normalizeStoreCode } from "../lib/normalize.js";

// Multipart text field sent alongside the "image" file part.
export const ocrBodySchema = z.object({
  store_code: z.string().trim().min(1).transform(normalizeStoreCode),
});

export type OcrBodyInput = z.infer<typeof ocrBodySchema>;
