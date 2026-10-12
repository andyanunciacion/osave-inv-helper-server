import type { RequestHandler, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { intFromEnv } from "./env.js";
import { normalizeStoreCode } from "./normalize.js";
import { verifyPasscode } from "./passcode.js";
import { supabase } from "./supabase.js";

// Per-store access (frontend-contract.md §10). Every /api request carries the
// session's store code and that store's staff passcode as headers; the
// passcode is checked against stores.passcode_hash. A store with no passcode
// can't be used until one is set (scripts/set-store-passcode.ts).
export const STORE_CODE_HEADER = "X-Store-Code";
export const STORE_PASSCODE_HEADER = "X-Store-Passcode";

// The store this request signed in as. Only valid after requireStoreAccess.
export function authStoreCode(res: Response): string {
  return res.locals.authStoreCode as string;
}

// Wrong passcodes per IP before that IP is locked out for the window, so the
// passcode can't be guessed by brute force. Only 401s count — a signed-in
// store's normal traffic never does. Relies on `trust proxy` (src/index.ts)
// to see the caller's IP rather than the host's proxy.
export const passcodeAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: intFromEnv("PASSCODE_ATTEMPTS_PER_15_MIN", 10),
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "too_many_attempts", message: "Too many wrong passcodes, try again in 15 minutes" },
});

// Any store_code a request names in its query string or JSON body must be
// the one it signed in as. A multipart body (/api/ocr) isn't parsed yet at
// this point, so that route checks its own field against authStoreCode.
function namedStoreCodes(query: unknown, body: unknown): string[] {
  const fromQuery = (query as Record<string, unknown> | undefined)?.store_code;
  const fromBody = (body as Record<string, unknown> | undefined)?.store_code;
  return [fromQuery, fromBody].filter((v): v is string => typeof v === "string").map(normalizeStoreCode);
}

export const requireStoreAccess: RequestHandler = async (req, res, next) => {
  const storeCode = normalizeStoreCode(req.get(STORE_CODE_HEADER) ?? "");
  const passcode = req.get(STORE_PASSCODE_HEADER) ?? "";
  if (!storeCode || !passcode) {
    return res.status(401).json({ error: "unauthorized", message: "Store code and passcode are required" });
  }

  const { data: store, error } = await supabase
    .from("stores")
    .select("passcode_hash")
    .eq("store_code", storeCode)
    .maybeSingle();
  if (error) {
    return res.status(500).json({ error: "internal_error", message: error.message });
  }
  // Unknown store and store without a passcode look the same: neither can be
  // used until someone sets it up.
  if (!store?.passcode_hash) {
    return res.status(401).json({ error: "store_not_set_up", message: `Store ${storeCode} hasn't been set up yet` });
  }
  if (!(await verifyPasscode(passcode, store.passcode_hash))) {
    return res.status(401).json({ error: "unauthorized", message: "Wrong passcode for this store" });
  }

  if (namedStoreCodes(req.query, req.body).some((code) => code !== storeCode)) {
    return res.status(403).json({ error: "forbidden", message: "This request is for a different store" });
  }

  res.locals.authStoreCode = storeCode;
  next();
};
