// POST /api/ocr/reconcile's cross-check of sibling pages from one print run
// (main-file.md §5 rule 8): a blank store code or Transaction Date is filled
// from pages sharing the printout timestamp, and left blank when ambiguous.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseReceipt } from "../src/lib/receipt-parser.js";

// ocr.ts creates the Supabase and Vision clients at import; reconcile uses neither.
vi.mock("../src/lib/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/lib/vision.js", () => ({ detectReceiptPages: vi.fn() }));

const { reconcilePages } = await import("../src/routes/ocr.js");

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/vision");
const header = (name: string) => parseReceipt(JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"))).header;

const page = (overrides: Partial<ReturnType<typeof header>> = {}) => ({
  delivery_code: "ITPH1",
  warehouse_code: "BUN DC",
  delivery_date: "2026-09-14",
  receipt_store_code: "245",
  printout_datetime: "2026-09-14T23:45:27",
  ...overrides,
});

describe("reconcilePages", () => {
  it("fills the 14 batch's blank dates and store code from page 14", () => {
    const [p14, p14a, p14b] = reconcilePages("245", [header("14"), header("14(1)"), header("14(2)")]);

    expect(p14).toMatchObject({ delivery_date: "2026-09-14", delivery_date_inferred: false, receipt_store_code_inferred: false });
    expect(p14a).toMatchObject({
      delivery_date: "2026-09-14",
      delivery_date_inferred: true,
      receipt_store_code: "245",
      receipt_store_code_inferred: true,
      store_mismatch: false,
    });
    expect(p14b).toMatchObject({ delivery_date: "2026-09-14", delivery_date_inferred: true, receipt_store_code_inferred: false });
  });

  it("leaves a read date as it is, even when a sibling disagrees", () => {
    const [a, b] = reconcilePages("245", [page(), page({ delivery_date: "2026-09-15" })]);
    expect(a).toMatchObject({ delivery_date: "2026-09-14", delivery_date_inferred: false });
    expect(b).toMatchObject({ delivery_date: "2026-09-15", delivery_date_inferred: false });
  });

  it("leaves a blank date blank when siblings disagree", () => {
    const [, , blank] = reconcilePages("245", [page(), page({ delivery_date: "2026-09-15" }), page({ delivery_date: "" })]);
    expect(blank).toMatchObject({ delivery_date: "", delivery_date_inferred: false });
  });

  it("only fills from pages with the same printout timestamp", () => {
    const [, other, noTimestamp] = reconcilePages("245", [
      page(),
      page({ delivery_date: "", printout_datetime: "2026-09-14T23:45:28" }),
      page({ delivery_date: "", printout_datetime: "" }),
    ]);
    expect(other).toMatchObject({ delivery_date: "", delivery_date_inferred: false });
    expect(noTimestamp).toMatchObject({ delivery_date: "", delivery_date_inferred: false });
  });

  it("leaves a blank date blank when no sibling read one", () => {
    const [a, b] = reconcilePages("245", [page({ delivery_date: "" }), page({ delivery_date: " " })]);
    expect(a).toMatchObject({ delivery_date: "", delivery_date_inferred: false });
    expect(b).toMatchObject({ delivery_date: "", delivery_date_inferred: false });
  });

  it("flags a mismatched store code, read or inferred", () => {
    const [read, inferred] = reconcilePages("245", [page({ receipt_store_code: "300" }), page({ receipt_store_code: "" })]);
    expect(read).toMatchObject({ receipt_store_code: "300", store_mismatch: true });
    expect(inferred).toMatchObject({ receipt_store_code: "300", receipt_store_code_inferred: true, store_mismatch: true });
  });
});
