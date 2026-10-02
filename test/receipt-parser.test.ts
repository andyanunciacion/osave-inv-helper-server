// Scores receipt-parser.ts against hand-transcribed ground truth for real
// photographed receipts (test/fixtures/vision/*.json — Vision word geometry
// captured once with scripts/capture-vision-fixtures.ts, so this costs no API
// calls).
//
// Every item field is classed as correct, blank (left for the user to fill
// in on the review screen) or wrong (a value that *looks* read but isn't —
// the dangerous kind, since nothing flags it). The thresholds at the bottom
// are a ratchet: tighten them when the parser improves, never loosen them to
// make a change pass.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyItemHistory, parseReceipt, reconcileItem, type ParsedItem } from "../src/lib/receipt-parser.js";
import { EXPECTED, type Row } from "./fixtures/receipts.expected.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "vision");

const FIELDS = ["item_code", "item_name", "unit_count", "unit", "quantity", "item_price", "total_item_price"] as const;
type Field = (typeof FIELDS)[number];

const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));
const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

function expectedValue(row: Row, field: Field): string | number {
  return row[FIELDS.indexOf(field)];
}

type Outcome = "correct" | "blank" | "wrong";

function judge(field: Field, expected: string | number, actual: string): Outcome {
  if (actual.trim() === "") return "blank";
  if (field === "item_name") return normName(actual) === normName(String(expected)) ? "correct" : "wrong";
  if (field === "item_code" || field === "unit") return actual.trim().toUpperCase() === String(expected) ? "correct" : "wrong";
  const n = num(actual);
  return n !== null && close(n, Number(expected)) ? "correct" : "wrong";
}

// Order-preserving alignment of expected rows to parsed rows (LCS), where a
// pair can match on item code or on the printed total — the two cells that
// survive best — so one dropped or split row doesn't shift every row after it.
function align(expected: Row[], parsed: ParsedItem[]): [number, number][] {
  const matches = (e: Row, p: ParsedItem): boolean =>
    (p.item_code !== "" && p.item_code === e[0]) || (num(p.total_item_price) !== null && close(num(p.total_item_price)!, e[6]));
  const n = expected.length;
  const m = parsed.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = matches(expected[i], parsed[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (matches(expected[i], parsed[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) pairs.push([i++, j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

interface Tally {
  correct: number;
  blank: number;
  wrong: number;
}

function score() {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, { correct: 0, blank: 0, wrong: 0 }])) as Record<Field, Tally>;
  const header: Tally = { correct: 0, blank: 0, wrong: 0 };
  const totals: Tally = { correct: 0, blank: 0, wrong: 0 };
  let missedRows = 0;
  let extraRows = 0;
  let expectedRows = 0;

  for (const [name, page] of Object.entries(EXPECTED)) {
    const pages = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
    const parsed = parseReceipt(pages);

    for (const [key, value] of Object.entries(page.header)) {
      if (value === null) continue;
      const actual = parsed.header[key as keyof typeof parsed.header] ?? "";
      header[actual === "" ? "blank" : actual === value ? "correct" : "wrong"]++;
    }

    // A printed total the page doesn't have (Total Pcs on a page with no
    // PIECE rows, or no totals block at all) must come back blank.
    for (const key of ["total_pcs", "total_box", "total_items", "total_value"] as const) {
      const value = page.footer?.[key] ?? null;
      const actual = parsed.totals[key];
      if (actual === "") totals[value === null ? "correct" : "blank"]++;
      else totals[value !== null && close(Number(actual), value) ? "correct" : "wrong"]++;
    }

    const pairs = align(page.items, parsed.items);
    expectedRows += page.items.length;
    missedRows += page.items.length - pairs.length;
    extraRows += parsed.items.length - pairs.length;
    // A row that wasn't found at all counts as blank in every field.
    for (const f of FIELDS) fields[f].blank += page.items.length - pairs.length;
    for (const [i, j] of pairs) {
      for (const f of FIELDS) fields[f][judge(f, expectedValue(page.items[i], f), parsed.items[j][f])]++;
    }
  }

  return { fields, header, totals, missedRows, extraRows, expectedRows };
}

describe("ground truth (receipts.expected.ts) is self-consistent", () => {
  for (const [name, page] of Object.entries(EXPECTED)) {
    it(`${name}: every row satisfies Qty × Unit/Box × Price = Total, and rows add up to the printed footer`, () => {
      for (const [code, , unitCount, , qty, price, total] of page.items) {
        expect(close(qty * unitCount * price, total), `row ${code}`).toBe(true);
      }
      if (!page.footer) return;
      const sumQty = (unit: "BOX" | "PIECE") => page.items.filter((r) => r[3] === unit).reduce((s, r) => s + r[4], 0);
      expect(sumQty("BOX")).toBe(page.footer.total_box);
      expect(sumQty("PIECE")).toBe(page.footer.total_pcs ?? 0);
      expect(new Set(page.items.map((r) => r[0])).size).toBe(page.footer.total_items);
      expect(close(page.items.reduce((s, r) => s + r[6], 0), page.footer.total_value)).toBe(true);
    });
  }
});

describe("receipt-parser accuracy on real photos", () => {
  const result = score();

  it("reports per-field accuracy", () => {
    const pct = (t: Tally) => `${((100 * t.correct) / (t.correct + t.blank + t.wrong)).toFixed(1)}%`;
    const rows = FIELDS.map((f) => `${f.padEnd(17)} ${String(result.fields[f].correct).padStart(4)} ${String(result.fields[f].blank).padStart(6)} ${String(result.fields[f].wrong).padStart(6)}   ${pct(result.fields[f])}`);
    console.log(
      [
        `rows: ${result.expectedRows} expected, ${result.missedRows} missed, ${result.extraRows} extra`,
        `field             correct  blank  wrong`,
        ...rows,
        `${"header".padEnd(17)} ${String(result.header.correct).padStart(4)} ${String(result.header.blank).padStart(6)} ${String(result.header.wrong).padStart(6)}   ${pct(result.header)}`,
        `${"totals block".padEnd(17)} ${String(result.totals.correct).padStart(4)} ${String(result.totals.blank).padStart(6)} ${String(result.totals.wrong).padStart(6)}   ${pct(result.totals)}`,
      ].join("\n"),
    );
  });

  // Ratchet — see the note at the top of this file. Out of 211 rows.
  // Baseline before struck-through cells were handled (2026-10-02): quantity
  // 77 correct / 134 blank, unit 180, item_price 200 with 2 wrong.
  const MIN_CORRECT: Record<Field, number> = {
    item_code: 211,
    item_name: 210,
    unit_count: 209,
    unit: 209,
    quantity: 207,
    item_price: 209,
    total_item_price: 211,
  };
  // A wrong value is worse than a blank one — nothing on the review screen
  // points at it. Only the OCR's own misreading of "Mlk" as "Mik" is allowed.
  const MAX_WRONG: Record<Field, number> = {
    item_code: 0,
    item_name: 1,
    unit_count: 0,
    unit: 0,
    quantity: 0,
    item_price: 0,
    total_item_price: 0,
  };

  for (const f of FIELDS) {
    it(`${f}: at least ${MIN_CORRECT[f]} correct, at most ${MAX_WRONG[f]} wrong`, () => {
      expect(result.fields[f].correct).toBeGreaterThanOrEqual(MIN_CORRECT[f]);
      expect(result.fields[f].wrong).toBeLessThanOrEqual(MAX_WRONG[f]);
    });
  }

  it("never misreads a row or a printed total", () => {
    expect(result.missedRows).toBe(0);
    expect(result.extraRows).toBe(0);
    expect(result.totals.wrong).toBe(0);
    expect(result.header.wrong).toBe(0);
  });
});

describe("reconcileItem", () => {
  const row = (cells: Partial<ParsedItem>): ParsedItem => ({
    item_code: "4557",
    item_name: "Juice Drink Orange Batata 250ml",
    unit_count: "",
    unit: "",
    quantity: "",
    item_price: "",
    total_item_price: "",
    inferred: [],
    has_annotation: false,
    ...cells,
  });

  it("solves a struck-through Qty from Total ÷ (Unit/Box × Price) and marks it inferred", () => {
    const out = reconcileItem(row({ unit_count: "12", unit: "BOX", item_price: "65.75", total_item_price: "1578.00" }));
    expect(out.quantity).toBe("2");
    expect(out.inferred).toEqual(["quantity"]);
    expect(out.has_annotation).toBe(false);
  });

  it("splits a tick-glued qty digit off the price (\"2✓7.75\" read as 27.75)", () => {
    const out = reconcileItem(row({ unit_count: "10", unit: "BOX", item_price: "27.75", total_item_price: "155.00" }));
    expect(out.item_price).toBe("7.75");
    expect(out.quantity).toBe("2");
    expect(out.inferred).toEqual(expect.arrayContaining(["item_price", "quantity"]));
  });

  it("keeps the printed Qty when a handwritten count disagrees, and flags the row", () => {
    const out = reconcileItem(row({ unit_count: "24", unit: "BOX", quantity: "3", item_price: "56.50", total_item_price: "2712.00" }));
    expect(out.quantity).toBe("2");
    expect(out.has_annotation).toBe(true);
  });

  it("solves an unreadable price from Qty", () => {
    const out = reconcileItem(row({ unit_count: "10", unit: "BOX", quantity: "1", total_item_price: "1450.00" }));
    expect(out.item_price).toBe("145.00");
    expect(out.inferred).toEqual(["item_price"]);
  });

  it("infers UOM from Unit/Box, and Unit/Box 1 from a PIECE row", () => {
    expect(reconcileItem(row({ unit_count: "1", quantity: "10", item_price: "799.00", total_item_price: "7990.00" })).unit).toBe("PIECE");
    expect(reconcileItem(row({ unit_count: "24", quantity: "1", item_price: "1.50", total_item_price: "36.00" })).unit).toBe("BOX");
    const piece = reconcileItem(row({ unit: "PIECE", item_price: "84.00", total_item_price: "168.00" }));
    expect(piece.unit_count).toBe("1");
    expect(piece.quantity).toBe("2");
  });

  it("leaves a row alone when only Qty × Price is known — that's ambiguous", () => {
    const out = reconcileItem(row({ unit_count: "24", unit: "BOX", total_item_price: "2376.00" }));
    expect(out.quantity).toBe("");
    expect(out.item_price).toBe("");
  });

  it("leaves a row that can't be made to add up as read", () => {
    const out = reconcileItem(row({ unit_count: "12", unit: "BOX", quantity: "2", item_price: "65.75", total_item_price: "1000.00" }));
    expect(out).toMatchObject({ quantity: "2", item_price: "65.75", inferred: [] });
  });
});

describe("applyItemHistory", () => {
  it("fills a Unit/Box hidden under the watermark from this store's history, then solves Qty", () => {
    const receipt = {
      header: { delivery_code: "", warehouse_code: "", delivery_date: "", receipt_store_code: "", printout_datetime: "" },
      totals: { total_pcs: "", total_box: "", total_items: "", total_value: "" },
      items: [
        {
          item_code: "8102",
          item_name: "Japanese Siomai Dimsum Factory 500g",
          unit_count: "",
          unit: "",
          quantity: "",
          item_price: "119.00",
          total_item_price: "4760.00",
          inferred: [],
          has_annotation: false,
        },
      ],
    };
    const [item] = applyItemHistory(receipt, new Map([["8102", { unit: "BOX", unit_count: 40 }]])).items;
    expect(item).toMatchObject({ unit_count: "40", unit: "BOX", quantity: "1" });
    expect(item.inferred).toEqual(expect.arrayContaining(["unit_count", "unit", "quantity"]));
  });
});
