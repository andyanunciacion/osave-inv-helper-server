import { Router } from "express";
import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { intFromEnv } from "../lib/env.js";
import { normalizeStoreCode } from "../lib/normalize.js";
import { applyItemHistory, parseReceipt, type ItemHistory, type ParsedReceipt } from "../lib/receipt-parser.js";
import { authStoreCode } from "../lib/store-auth.js";
import { supabase } from "../lib/supabase.js";
import { detectReceiptPages } from "../lib/vision.js";
import { ocrBodySchema, ocrReconcileBodySchema, type OcrReconcileBodyInput } from "../validators/ocr.js";

export const ocrRouter = Router();

// Memory storage only — the image is held in a Buffer for the duration of
// this request and never written to disk or any storage bucket, per
// main-file.md §7's text-only pipeline. It's discarded once this handler
// returns.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Staff strike through the UOM cell while checking a delivery, and the
// watermark can hide Unit/Box, so for rows missing either, this store's most
// recent delivery of the same item fills them in (still marked inferred). A
// failed lookup only means less gets filled in — the OCR result still goes
// back.
async function withItemHistory(receipt: ParsedReceipt, storeCode: string): Promise<ParsedReceipt> {
  const codes = [
    ...new Set(
      receipt.items
        .filter((i) => i.item_code && (!i.unit_count || !i.unit || i.inferred.includes("unit")))
        .map((i) => i.item_code),
    ),
  ];
  if (codes.length === 0) return receipt;

  const { data, error } = await supabase
    .from("delivery_items")
    .select("item_code, unit, unit_count")
    .eq("store_code", storeCode)
    .in("item_code", codes)
    .order("created_at", { ascending: false });
  if (error || !data) return receipt;

  const history = new Map<string, ItemHistory>();
  for (const row of data) {
    if (row.item_code && !history.has(row.item_code)) {
      history.set(row.item_code, { unit: row.unit, unit_count: row.unit_count === null ? null : Number(row.unit_count) });
    }
  }
  return applyItemHistory(receipt, history);
}

// Every accepted request is one billed Vision call. The per-IP limit stops a
// buggy client retry loop, so it runs first and counts every request,
// rejected ones included (and before multer buffers a 10MB upload). The
// global daily cap bounds total spend no matter how many IPs are calling, so
// it runs only after the request has passed validation — a rejected upload
// costs nothing and mustn't use up the day's budget. Counters are in-memory,
// so they reset on restart and aren't shared across instances — fine for a
// single small server.
const perIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: intFromEnv("OCR_RATE_LIMIT_PER_MINUTE", 30),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many OCR requests, try again in a minute" },
});

const dailyCapLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: intFromEnv("OCR_DAILY_LIMIT", 300),
  keyGenerator: () => "global",
  standardHeaders: false,
  legacyHeaders: false,
  message: { error: "daily_limit_reached", message: "Daily OCR limit reached, try again tomorrow or enter the receipt manually" },
});

// Validated before the daily cap and before calling Vision, so a bad request
// never costs an API call or a slot in the day's budget.
const validateOcrRequest: RequestHandler = (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: "missing_image", message: "Expected a multipart 'image' field" });
  }
  if (!req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({ error: "invalid_file_type", message: "Uploaded file must be an image" });
  }
  const parsedBody = ocrBodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsedBody.error.issues });
  }
  // The multipart body isn't parsed when requireStoreAccess runs, so the
  // store_code field is checked against the signed-in store here.
  if (parsedBody.data.store_code !== authStoreCode(res)) {
    return res.status(403).json({ error: "forbidden", message: "This request is for a different store" });
  }
  res.locals.storeCode = parsedBody.data.store_code;
  next();
};

ocrRouter.post("/", perIpLimiter, upload.single("image"), validateOcrRequest, dailyCapLimiter, async (req, res) => {
  const image = req.file as Express.Multer.File;
  const store_code: string = res.locals.storeCode;

  let pages: Awaited<ReturnType<typeof detectReceiptPages>>;
  try {
    pages = await detectReceiptPages(image.buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OCR request failed";
    return res.status(502).json({ error: "ocr_failed", message });
  }

  const parsed = parseReceipt(pages);
  const { header } = parsed;

  // A receipt printed for another store must never reach this store's
  // records. An unreadable "To:" is not treated as a mismatch here — it comes
  // back blank so the user can type it from the paper — but
  // POST /api/deliveries requires receipt_store_code and re-checks it.
  const receiptStoreCode = normalizeStoreCode(header.receipt_store_code);
  if (receiptStoreCode && receiptStoreCode !== store_code) {
    return res.status(409).json({
      error: "store_mismatch",
      message: `This receipt is addressed to store ${receiptStoreCode}, not store ${store_code}`,
      store_code,
      receipt_store_code: receiptStoreCode,
    });
  }

  const { items, totals } = await withItemHistory(parsed, store_code);
  res.json({ header, items, totals });
});

type DraftHeader = OcrReconcileBodyInput["pages"][number];

// For each printout timestamp, the distinct non-blank values one header field
// was read as across the pages printed at that moment.
function valuesByPrintout(pages: DraftHeader[], read: (page: DraftHeader) => string): Map<string, Set<string>> {
  const byPrintout = new Map<string, Set<string>>();
  for (const page of pages) {
    const value = read(page);
    if (!page.printout_datetime || !value) continue;
    const values = byPrintout.get(page.printout_datetime) ?? new Set<string>();
    values.add(value);
    byPrintout.set(page.printout_datetime, values);
  }
  return byPrintout;
}

// The value a page's siblings agree on, or "" when none of them read it or
// they disagree.
function siblingValue(page: DraftHeader, byPrintout: Map<string, Set<string>>): string {
  const values = page.printout_datetime ? byPrintout.get(page.printout_datetime) : undefined;
  return values?.size === 1 ? [...values][0] : "";
}

// Pages of one physical receipt print an identical "Date and hour of
// printout" (main-file.md §5 rule 8), so when one page's "To:" store code,
// Transaction Date or Inv. Tran. No. came back blank — under a folded corner,
// a staple, a sticker, or cut off by the photo's tilt — a sibling page from
// the same print run that *did* read cleanly is used to fill it in. Ambiguous
// (no sibling shares the timestamp, or siblings disagree) is left blank: the
// user fills it in by hand on the review screen rather than trusting a guess.
//
// A read value is never overwritten, even when siblings disagree with it. For
// the delivery code that disagreement matters (a misread code saves as a
// second, bogus delivery), but which page is wrong is for staff to decide:
// the review screen compares each page's code against its siblings' and
// blocks Confirm until they match or staff keep it (frontend-contract.md §6).
export function reconcilePages(storeCode: string, pages: DraftHeader[]) {
  const storeCodes = valuesByPrintout(pages, (page) => normalizeStoreCode(page.receipt_store_code));
  const dates = valuesByPrintout(pages, (page) => page.delivery_date.trim());
  const deliveryCodes = valuesByPrintout(pages, (page) => page.delivery_code.trim());

  return pages.map((page) => {
    const readStoreCode = normalizeStoreCode(page.receipt_store_code);
    const receiptStoreCode = readStoreCode || siblingValue(page, storeCodes);
    const readDate = page.delivery_date.trim();
    const deliveryDate = readDate || siblingValue(page, dates);
    const readDeliveryCode = page.delivery_code.trim();
    const deliveryCode = readDeliveryCode || siblingValue(page, deliveryCodes);
    return {
      ...page,
      delivery_code: deliveryCode,
      delivery_code_inferred: !readDeliveryCode && deliveryCode !== "",
      receipt_store_code: receiptStoreCode,
      receipt_store_code_inferred: !readStoreCode && receiptStoreCode !== "",
      store_mismatch: receiptStoreCode !== "" && receiptStoreCode !== storeCode,
      delivery_date: deliveryDate,
      delivery_date_inferred: !readDate && deliveryDate !== "",
    };
  });
}

// No Vision call here — it only cross-references header fields the client
// already got back from earlier POST /api/ocr calls in the same multi-page
// upload, so it isn't rate-limited like the endpoint above.
ocrRouter.post("/reconcile", (req, res) => {
  const parsedBody = ocrReconcileBodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsedBody.error.issues });
  }
  const { store_code, pages } = parsedBody.data;
  res.json({ pages: reconcilePages(store_code, pages) });
});
