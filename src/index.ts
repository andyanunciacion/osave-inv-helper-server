import "dotenv/config";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { passcodeAttemptLimiter, requireStoreAccess } from "./lib/store-auth.js";
import { storesRouter } from "./routes/stores.js";
import { deliveriesRouter } from "./routes/deliveries.js";
import { searchRouter } from "./routes/search.js";
import { ocrRouter } from "./routes/ocr.js";

const app = express();
const port = process.env.PORT ?? 4000;

// Hosts like Railway/Render put the app behind a proxy, so every request
// arrives from the proxy's IP; TRUST_PROXY (the number of proxy hops) makes
// req.ip the caller's, which the per-IP OCR and passcode limiters key on.
// Off unless set: trusting a proxy that isn't there would let any caller fake
// their IP with an X-Forwarded-For header and dodge those limits.
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY ?? "", 10);
if (Number.isFinite(trustProxyHops) && trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Every /api route needs the store's passcode (src/lib/store-auth.ts);
// /health stays open for the host's health checks. CORS answers preflight
// requests above, before this, so the browser can ask to send the headers.
app.use("/api", passcodeAttemptLimiter, requireStoreAccess);

app.use("/api/stores", storesRouter);
app.use("/api/deliveries", deliveriesRouter);
app.use("/api/search", searchRouter);
app.use("/api/ocr", ocrRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found", message: "route not found" });
});

// Keeps the API's "every response is JSON" contract intact for failures that
// happen before a route handler runs — a multer upload error (e.g. the
// /api/ocr file-size limit) or a malformed JSON body — which would otherwise
// fall through to Express's default HTML error page.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "file_too_large", message: "Image must be 10MB or smaller" });
    }
    return res.status(400).json({ error: "upload_error", message: err.message });
  }
  if (err instanceof SyntaxError && "status" in err && (err as { status?: number }).status === 400 && "body" in err) {
    return res.status(400).json({ error: "invalid_json", message: "Request body must be valid JSON" });
  }
  console.error(err);
  res.status(500).json({ error: "internal_error", message: "Unexpected server error" });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
