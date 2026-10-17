import type { RequestHandler } from "express";
import { STORE_CODE_HEADER } from "./store-auth.js";

type Level = "info" | "warn" | "error";

// One JSON object per line on stdout. Railway reads `level` and `message` and
// makes every other field filterable in its log explorer (@status:500,
// @store:S001, @error:unauthorized).
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, message, ...fields }));
}

// Logs every request once, when its response is done or the caller hangs up.
// Headers and bodies are never logged: the passcode travels in
// X-Store-Passcode, and receipts are store data. Only the response's `error`
// code and message are kept — a 401 alone doesn't say whether the passcode
// was wrong or the store isn't set up — plus its `status`, since a rejected
// delivery is still a 200 (frontend-contract.md §2).
export const requestLogger: RequestHandler = (req, res, next) => {
  const start = performance.now();
  const outcome: Record<string, unknown> = {};

  const json = res.json.bind(res);
  res.json = (body) => {
    const { error, message, status } = (body ?? {}) as Record<string, unknown>;
    if (typeof error === "string") {
      outcome.error = error;
      if (typeof message === "string") outcome.error_message = message;
    }
    if (typeof status === "string") outcome.outcome = status;
    return json(body);
  };

  res.once("close", () => {
    const durationMs = Math.round(performance.now() - start);
    const aborted = !res.writableFinished;
    const status = res.statusCode;
    const level: Level = status >= 500 ? "error" : status >= 400 || aborted ? "warn" : "info";
    log(level, `${req.method} ${req.originalUrl} ${aborted ? "aborted" : status} ${durationMs}ms`, {
      method: req.method,
      path: req.originalUrl,
      status,
      duration_ms: durationMs,
      aborted: aborted || undefined,
      // The store it signed in as, or else the one it tried to (a 401/403).
      store: res.locals.authStoreCode as string | undefined,
      store_attempted: res.locals.authStoreCode ? undefined : req.get(STORE_CODE_HEADER) || undefined,
      ip: req.ip,
      ...outcome,
    });
  });

  next();
};
