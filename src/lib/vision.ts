import { ImageAnnotatorClient } from "@google-cloud/vision";
import type { protos } from "@google-cloud/vision";

let client: ImageAnnotatorClient | null = null;

// Lazy rather than fail-fast-at-module-load (unlike src/lib/supabase.ts):
// OCR is one feature among several, not something every request depends on,
// so a missing key should fail the /api/ocr request, not boot the server.
function getClient(): ImageAnnotatorClient {
  if (client) return client;

  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (credentialsJson) {
    client = new ImageAnnotatorClient({ credentials: JSON.parse(credentialsJson) });
    return client;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Falls back to the service account key file at this path (Application
    // Default Credentials) — convenient for local dev.
    client = new ImageAnnotatorClient();
    return client;
  }

  throw new Error(
    "OCR is not configured: set GOOGLE_APPLICATION_CREDENTIALS_JSON (service account key JSON, as a string) " +
      "or GOOGLE_APPLICATION_CREDENTIALS (path to the key file).",
  );
}

// Returns the per-word geometry, not just fullTextAnnotation.text: Vision
// emits table cells column-by-column, so the plain text has no row structure
// (see src/lib/receipt-parser.ts).
export async function detectReceiptPages(imageBuffer: Buffer): Promise<protos.google.cloud.vision.v1.IPage[]> {
  const [result] = await getClient().documentTextDetection({
    image: { content: imageBuffer },
  });
  return result.fullTextAnnotation?.pages ?? [];
}
