import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { normalizeStoreCode } from "../lib/normalize.js";
import { parseReceipt } from "../lib/receipt-parser.js";
import { detectReceiptPages } from "../lib/vision.js";
import { ocrBodySchema, ocrReconcileBodySchema } from "../validators/ocr.js";

export const ocrRouter = Router();

// Memory storage only — the image is held in a Buffer for the duration of
// this request and never written to disk or any storage bucket, per
// main-file.md §7's text-only pipeline. It's discarded once this handler
// returns.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Every accepted request is one billed Vision call. The per-IP limit stops a
// buggy client retry loop; the global daily cap bounds total spend no matter
// how many IPs are calling. Counters are in-memory, so they reset on restart
// and aren't shared across instances — fine for a single small server.
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

ocrRouter.post("/", perIpLimiter, dailyCapLimiter, upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "missing_image", message: "Expected a multipart 'image' field" });
  }
  if (!req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({ error: "invalid_file_type", message: "Uploaded file must be an image" });
  }

  // Validated before calling Vision so a bad request never costs an API call.
  const parsedBody = ocrBodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsedBody.error.issues });
  }
  const { store_code } = parsedBody.data;

  let pages: Awaited<ReturnType<typeof detectReceiptPages>>;
  try {
    pages = await detectReceiptPages(req.file.buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OCR request failed";
    return res.status(502).json({ error: "ocr_failed", message });
  }

  const { header, items } = parseReceipt(pages);

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

  res.json({ header, items });
});

// No Vision call here — it only cross-references header fields the client
// already got back from earlier POST /api/ocr calls in the same multi-page
// upload, so it isn't rate-limited like the endpoint above.
//
// Pages of one physical receipt print an identical "Date and hour of
// printout" (main-file.md §5 rule 8), so when one page's "To:" store code
// came back blank — the digits themselves were under a folded corner, a
// staple, a sticker, whatever — a sibling page from the same print run that
// *did* read cleanly is used to fill it in. Ambiguous (no sibling shares the
// timestamp, or siblings disagree) is left blank, same as today: the user
// fills it in by hand on the review screen rather than trusting a guess.
ocrRouter.post("/reconcile", (req, res) => {
  const parsedBody = ocrReconcileBodySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: "invalid_body", issues: parsedBody.error.issues });
  }
  const { store_code, pages } = parsedBody.data;

  const codesByTimestamp = new Map<string, Set<string>>();
  for (const page of pages) {
    if (!page.printout_datetime || !page.receipt_store_code) continue;
    const codes = codesByTimestamp.get(page.printout_datetime) ?? new Set<string>();
    codes.add(normalizeStoreCode(page.receipt_store_code));
    codesByTimestamp.set(page.printout_datetime, codes);
  }

  const resolvedPages = pages.map((page) => {
    if (page.receipt_store_code) {
      const receiptStoreCode = normalizeStoreCode(page.receipt_store_code);
      return { ...page, receipt_store_code: receiptStoreCode, receipt_store_code_inferred: false, store_mismatch: receiptStoreCode !== store_code };
    }

    const candidates = page.printout_datetime ? codesByTimestamp.get(page.printout_datetime) : undefined;
    if (candidates && candidates.size === 1) {
      const [receiptStoreCode] = candidates;
      return { ...page, receipt_store_code: receiptStoreCode, receipt_store_code_inferred: true, store_mismatch: receiptStoreCode !== store_code };
    }

    return { ...page, receipt_store_code_inferred: false, store_mismatch: false };
  });

  res.json({ pages: resolvedPages });
});
