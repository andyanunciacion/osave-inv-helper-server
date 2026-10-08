// Turns Vision's DOCUMENT_TEXT_DETECTION word geometry into the OcrResult
// shape frontend-contract.md §6 expects (header + item rows, every field a
// string — the review screen binds them straight to text inputs).
//
// Works from word bounding boxes, not fullTextAnnotation.text: Vision emits
// table cells column-by-column rather than row-by-row, so the plain text has
// no usable row structure. Receipts are photographed, so the page is also
// tilted and warped (the tilt differs by ~5° between the left and right side
// of one photo). Rows are therefore rebuilt by linking each word to its left
// neighbour along the local line direction instead of assuming a straight
// horizontal or a single global rotation.

import type { protos } from "@google-cloud/vision";

type VisionPage = protos.google.cloud.vision.v1.IPage;

export interface ParsedHeader {
  delivery_code: string;
  warehouse_code: string;
  delivery_date: string;
  receipt_store_code: string;
  printout_datetime: string;
}

export type InferredField = "unit_count" | "unit" | "quantity" | "item_price" | "total_item_price";

export interface ParsedItem {
  item_code: string;
  item_name: string;
  unit_count: string;
  unit: string;
  quantity: string;
  item_price: string;
  total_item_price: string;
  // Fields worked out rather than read off the photo — from the printed
  // relationship Total = Qty × Unit/Box × Price, or from this store's earlier
  // deliveries of the same item — usually because staff struck through the
  // cell while checking the delivery. The review screen marks them so they
  // still get a glance.
  inferred: InferredField[];
  // Something handwritten sits on this row: a note after the description
  // (stripped from item_name), or a Qty that disagrees with the printed
  // arithmetic. Quantity stays the *printed* value; staff correct it on the
  // review screen if what arrived differs.
  has_annotation: boolean;
}

// The page's printed totals block ("Total Pcs: / Total Box: / Total Item/s: /
// Total Value:"), as plain strings like every other OCR'd field. "" means not
// read — the white-on-grey labels are usually dropped by Vision, so a number
// is only reported when its meaning is unambiguous. The review screen
// compares these live against the (edited) rows to catch a missed row or a
// misread quantity.
export interface ParsedTotals {
  total_pcs: string;
  total_box: string;
  total_items: string;
  total_value: string;
}

export interface ParsedReceipt {
  header: ParsedHeader;
  items: ParsedItem[];
  totals: ParsedTotals;
}

interface Word {
  text: string;
  x0: number;
  x1: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
  spaceAfter: boolean;
  confidence: number;
}

// Vision's detectedBreak types (SPACE, SURE_SPACE, EOL_SURE_SPACE, LINE_BREAK),
// as either enum names or numbers; HYPHEN and UNKNOWN mean no space.
const SPACE_BREAKS = new Set(["SPACE", "SURE_SPACE", "EOL_SURE_SPACE", "LINE_BREAK", "1", "2", "3", "5"]);

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const norm = (text: string): string => text.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

function extractWords(pages: VisionPage[]): Word[] {
  const words: Word[] = [];
  for (const page of pages) {
    for (const block of page.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const word of paragraph.words ?? []) {
          const vertices = (word.boundingBox?.vertices ?? []).map((p) => ({ x: p.x ?? 0, y: p.y ?? 0 }));
          const text = (word.symbols ?? []).map((s) => s.text ?? "").join("").trim();
          if (vertices.length < 4 || !text) continue;
          const [a, b, c, d] = vertices;
          const symbols = word.symbols ?? [];
          const lastBreak = String(symbols[symbols.length - 1]?.property?.detectedBreak?.type ?? "");
          words.push({
            spaceAfter: SPACE_BREAKS.has(lastBreak),
            text,
            x0: Math.min(a.x, b.x, c.x, d.x),
            x1: Math.max(a.x, b.x, c.x, d.x),
            cx: (a.x + b.x + c.x + d.x) / 4,
            cy: (a.y + b.y + c.y + d.y) / 4,
            w: Math.hypot(b.x - a.x, b.y - a.y),
            h: Math.hypot(d.x - a.x, d.y - a.y),
            angle: Math.atan2(b.y - a.y, b.x - a.x),
            confidence: word.confidence ?? 1,
          });
        }
      }
    }
  }
  return dropOutliers(words);
}

// Diagonal watermarks ("AUGUST 16 2026 DR") stamped over the receipt come back
// as a few huge, steeply rotated words that would otherwise be read as content.
function dropOutliers(words: Word[]): Word[] {
  const medH = median(words.map((w) => w.h));
  const medAngle = median(words.filter((w) => w.w >= w.h).map((w) => w.angle));
  return words.filter((w) => w.h <= 2.5 * medH && (w.w < w.h || Math.abs(w.angle - medAngle) < 0.35));
}

// Angle of the line between two words. Weighted by width because a box around
// a one-character word ("1", ":") is too small to give a reliable angle.
function hopAngle(a: Word, b: Word): number {
  const total = a.w + b.w;
  return total === 0 ? 0 : (a.angle * a.w + b.angle * b.w) / total;
}

function expectedY(from: Word, to: Word): number {
  return from.cy + Math.tan(hopAngle(from, to)) * (to.cx - from.cx);
}

function joinWords(words: Word[]): string {
  let out = "";
  let prev: Word | undefined;
  for (const word of words) {
    if (prev?.spaceAfter) out += " ";
    out += word.text;
    prev = word;
  }
  return out;
}

// Words continuing the same physical line to the right of `start`.
function follow(start: Word, pool: Word[]): Word[] {
  const line = [start];
  let cur = start;
  for (;;) {
    let next: Word | undefined;
    for (const w of pool) {
      if (line.includes(w)) continue;
      if (w.x0 < cur.x1 - 0.3 * cur.h || w.x0 - cur.x1 > 3 * cur.h) continue;
      if (Math.abs(w.cy - expectedY(cur, w)) >= 0.5 * cur.h) continue;
      if (!next || w.x0 < next.x0) next = w;
    }
    if (!next) return line;
    line.push(next);
    cur = next;
  }
}

function findSequence(pool: Word[], parts: string[]): Word[] | null {
  const list = pool.filter((w) => norm(w.text));
  for (let i = 0; i + parts.length <= list.length; i++) {
    if (parts.every((part, j) => norm(list[i + j].text) === part)) return list.slice(i, i + parts.length);
  }
  return null;
}

// The value printed to the right of a label. On a tilted photo the value
// sits well above/below the label's own baseline, so the expected height uses
// the candidate's own angle rather than assuming a horizontal line.
function valueRightOf(label: Word[], pool: Word[]): Word[] {
  const last = label[label.length - 1];
  const scored = pool
    .filter((w) => !label.includes(w) && norm(w.text) && w.x0 >= last.x1 - 0.2 * last.h)
    .map((w) => {
      const angle = w.w >= 0.9 * w.h ? w.angle : last.angle;
      return { w, dy: Math.abs(w.cy - (last.cy + Math.tan(angle) * (w.cx - last.cx))) };
    })
    .filter((c) => c.dy < 0.9 * last.h);
  if (scored.length === 0) return [];
  const bestDy = Math.min(...scored.map((c) => c.dy));
  const first = scored
    .filter((c) => c.dy <= bestDy + 0.35 * last.h)
    .sort((a, b) => a.w.x0 - b.w.x0)[0].w;
  return follow(first, pool);
}

function valueBelow(label: Word[], pool: Word[]): Word[] {
  const last = label[label.length - 1];
  const left = Math.min(...label.map((w) => w.x0)) - last.h;
  const right = Math.max(...label.map((w) => w.x1)) + last.h;
  const below = pool.filter(
    (w) =>
      !label.includes(w) &&
      norm(w.text) &&
      w.cx >= left &&
      w.cx <= right &&
      w.cy > last.cy + 0.6 * last.h &&
      w.cy < last.cy + 3.5 * last.h,
  );
  if (below.length === 0) return [];
  const topCy = Math.min(...below.map((w) => w.cy));
  const first = below.filter((w) => w.cy <= topCy + 0.6 * last.h).sort((a, b) => a.x0 - b.x0)[0];
  return follow(first, pool);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function normalizeDate(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const numeric = trimmed.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (numeric) return `${numeric[3]}-${numeric[1]}-${numeric[2]}`;

  const named = trimmed.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (named) {
    const month = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase());
    if (month !== -1) return `${named[3]}-${String(month + 1).padStart(2, "0")}-${named[2].padStart(2, "0")}`;
  }

  // Unrecognized format — leave as-is so it's visibly wrong (and editable)
  // on the review screen rather than silently defaulting to something else.
  return trimmed;
}

const looksLikeDate = (text: string): boolean => /\d{4}/.test(text) && /\d/.test(text) && normalizeDate(text) !== text.trim();

// "August 17, 2026, 11:15:30 AM" -> "2026-08-17T11:15:30". Printed twice per
// page (next to the label, and again in the page footer) on every sample
// receipt seen so far, and identical to the second across every page of the
// same physical printout — which is exactly what makes it a reliable join
// key for filling in a sibling page's store code (see ocr.ts's /reconcile).
function normalizePrintoutDatetime(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const match = trimmed.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return trimmed;

  const [, monthName, day, year, hourRaw, minute, second, meridiem] = match;
  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  if (month === -1) return trimmed;

  let hour = Number.parseInt(hourRaw, 10) % 12;
  if (meridiem.toUpperCase() === "PM") hour += 12;

  return `${year}-${String(month + 1).padStart(2, "0")}-${day.padStart(2, "0")}T${String(hour).padStart(2, "0")}:${minute}:${second}`;
}

interface Footer {
  printoutDatetime: string;
  warehouseCode: string;
}

// The page footer — "September 14, 2026, 11:45:27 PM , BUN DC , Page 4 of 6" —
// repeats the printout timestamp and the warehouse on every page. Unlike the
// header copy it sits clear of the tilt and of whatever overlaps the top of the
// photo (a neighbouring sheet covered the end of the header timestamp on one
// sample, which cost that page its store-code reconciliation), so it is read
// first and the header is only a fallback. Matched as a token run over every
// word rather than by geometry: a complete month/day/year/time/meridiem
// sequence is a strong enough signature on its own.
function parseFooter(words: Word[]): Footer | null {
  // Vision emits separators like "," as words of their own, so they are
  // dropped up front — "September 14 , 2026 , 11:45:27 PM" and the glued
  // "September 14, 2026, 11:45:27 PM" then both reduce to the same tokens.
  const tokens = words.map((w) => w.text).filter((t) => /[A-Za-z0-9]/.test(t));
  let datetimeOnly: Footer | null = null;

  for (let i = 0; i + 5 <= tokens.length; i++) {
    const [month, day, year, time, meridiem] = tokens.slice(i, i + 5).map((t) => t.replace(/,+$/, ""));
    if (
      !/^[A-Za-z]{3,9}\.?$/.test(month) ||
      MONTHS.indexOf(month.slice(0, 3).toLowerCase()) === -1 ||
      !/^\d{1,2}$/.test(day) ||
      !/^\d{4}$/.test(year) ||
      !/^\d{1,2}:\d{2}:\d{2}$/.test(time) ||
      !/^(AM|PM)$/i.test(meridiem)
    ) {
      continue;
    }

    const printoutDatetime = normalizePrintoutDatetime(`${month} ${day}, ${year}, ${time} ${meridiem}`);

    // ", BUN DC , Page 4 of 6" — the warehouse is everything up to "Page",
    // and only trusted when that marker is there to confirm this is the footer.
    let j = i + 5;
    const warehouse: string[] = [];
    while (j < tokens.length && warehouse.length < 4 && norm(tokens[j]) !== "page") {
      warehouse.push(tokens[j]);
      j++;
    }
    if (warehouse.length > 0 && j < tokens.length && norm(tokens[j]) === "page") {
      return { printoutDatetime, warehouseCode: warehouse.join(" ") };
    }
    datetimeOnly ??= { printoutDatetime, warehouseCode: "" };
  }

  return datetimeOnly;
}

function parseHeader(pool: Word[], footer: Footer | null): ParsedHeader {
  const codeLabel = findSequence(pool, ["inv", "tran", "no"]);
  const fromLabel = findSequence(pool, ["from"]);
  const dateLabel = findSequence(pool, ["transaction", "date"]);
  const printoutLabel = findSequence(pool, ["date", "and", "hour", "of", "printout"]);
  const toWord = pool.find((w) => norm(w.text) === "to");

  const deliveryCode = codeLabel ? joinWords(valueRightOf(codeLabel, pool)).replace(/\s+/g, "") : "";
  const labelWarehouse = fromLabel ? joinWords(valueRightOf(fromLabel, pool)) : "";
  const warehouseCode = footer?.warehouseCode || labelWarehouse;
  const printoutRaw = printoutLabel ? joinWords(valueRightOf(printoutLabel, pool)) : "";
  const printoutDatetime = footer?.printoutDatetime || (printoutRaw ? normalizePrintoutDatetime(printoutRaw) : "");

  let deliveryDate = "";
  if (dateLabel) {
    const candidates = [joinWords(valueBelow(dateLabel, pool)), joinWords(valueRightOf(dateLabel, pool))];
    const date = candidates.find(looksLikeDate);
    if (date) deliveryDate = normalizeDate(date);
  }

  // "To: [store_code] [store_address]" — the first number is the store code;
  // the address is ignored (main-file.md §1).
  let receiptStoreCode = "";
  if (toWord) {
    const toLine = joinWords(valueRightOf([toWord], pool));
    receiptStoreCode = toLine.match(/\d+/)?.[0] ?? "";
  }

  return {
    delivery_code: deliveryCode,
    warehouse_code: warehouseCode,
    delivery_date: deliveryDate,
    receipt_store_code: receiptStoreCode,
    printout_datetime: printoutDatetime,
  };
}

type Curve = (x: number) => number;

// Piecewise-linear reference through the table's header labels, so "how far
// below the header line" can be measured on a tilted/warped photo.
function buildCurve(points: { x: number; y: number }[]): Curve | null {
  if (points.length === 0) return null;
  const pts = [...points].sort((a, b) => a.x - b.x);
  if (pts.length === 1) return () => pts[0].y;
  return (x) => {
    let i = 0;
    while (i < pts.length - 2 && x > pts[i + 1].x) i++;
    const a = pts[i];
    const b = pts[i + 1];
    const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
    return a.y + t * (b.y - a.y);
  };
}

function findLabel(words: Word[], name: string, accept: (w: Word) => boolean = () => true): Word | undefined {
  return words
    .filter((w) => norm(w.text) === name && accept(w))
    .sort((a, b) => a.cy - b.cy)[0];
}

// Where the numeric columns (Unit/Box, UOM, Qty, Sales Price, Total) sit,
// relative to each other, on this receipt template. Lets a header label that
// Vision failed to read (white text on a grey band) be inferred from the ones
// it did read instead of losing the whole table.
const NUMERIC_COLUMN_FRACTIONS = [0, 0.203, 0.389, 0.671, 1];

function fillColumnPositions(known: (number | undefined)[]): number[] | null {
  const points = known.flatMap((x, i) => (x === undefined ? [] : [{ f: NUMERIC_COLUMN_FRACTIONS[i], x }]));
  if (points.length === known.length) return points.map((p) => p.x);
  if (points.length < 2) return null;

  const mf = points.reduce((s, p) => s + p.f, 0) / points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const den = points.reduce((s, p) => s + (p.f - mf) ** 2, 0);
  const scale = points.reduce((s, p) => s + (p.f - mf) * (p.x - mx), 0) / den;
  return NUMERIC_COLUMN_FRACTIONS.map((f, i) => known[i] ?? mx + scale * (f - mf));
}

type TokenType = "int" | "uom" | "money";

// Left-to-right order of the numeric columns on the receipt. A row can be
// missing any of them (OCR misses, or a cell hidden under the watermark), so
// tokens are matched to these slots by type + order + nearest tracked column
// position instead of by counting columns.
const NUMERIC_SLOTS: { field: "unit_count" | "unit" | "quantity" | "item_price" | "total_item_price"; type: TokenType }[] = [
  { field: "unit_count", type: "int" },
  { field: "unit", type: "uom" },
  { field: "quantity", type: "int" },
  { field: "item_price", type: "money" },
  { field: "total_item_price", type: "money" },
];

const MONEY_RE = /^\$?\d{1,3}(?:,\d{3})*\.\d{2}$|^\$?\d+\.\d{2}$/;
const INT_RE = /^\d{1,4}$|^\d{1,3}(?:,\d{3})+$/;

// Staff tick or strike through the UOM and Qty cells while checking a
// delivery, and the pen stroke comes back glued to the cell's text ("-BOX",
// "_BOX", "10-", "-65.75").
const STROKE_EDGES = /^[-_~+=*'"`|.,:;–—]+|[-_~+=*'"`|,:;–—]+$/g;

// A stroke through a price's first digit makes Vision read it as a letter:
// "T19.00" is 119.00, "To.00" is 10.00. Only applied to a token that already
// ends like money.
const DIGIT_LOOKALIKES: Record<string, string> = { O: "0", o: "0", D: "0", T: "1", t: "1", I: "1", l: "1", "|": "1" };

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

// "DOX", "B0X", "PIEGE" — a struck-through UOM is still recognisably one of
// the two units this template prints.
function readUom(text: string): "BOX" | "PIECE" | null {
  const t = text.toUpperCase();
  if (/^(PIECE|PCS|PC)$/.test(t)) return "PIECE";
  if (t === "BOX") return "BOX";
  if (t.length === 3 && editDistance(t, "BOX") === 1 && /OX$|^BO/.test(t)) return "BOX";
  if (t.length >= 4 && editDistance(t, "PIECE") <= 1) return "PIECE";
  return null;
}

interface Token {
  type: TokenType;
  value: string;
}

function readToken(raw: string): Token | null {
  const text = raw.replace(STROKE_EDGES, "");
  if (!text) return null;
  if (MONEY_RE.test(text)) return { type: "money", value: cleanNumber(text) };
  if (INT_RE.test(text)) return { type: "int", value: cleanNumber(text) };
  const uom = readUom(text);
  if (uom) return { type: "uom", value: uom };
  if (/\d/.test(text) && /\.\d{2}$/.test(text)) {
    const fixed = text.replace(/[A-Za-z|]/g, (c) => DIGIT_LOOKALIKES[c] ?? c);
    if (MONEY_RE.test(fixed)) return { type: "money", value: cleanNumber(fixed) };
  }
  return null;
}

function assignSlots(types: TokenType[], xs: number[], slotX: number[]): number[] {
  const SKIP_COST = 400;
  let best = { cost: Infinity, slots: [] as number[] };
  const current: number[] = [];

  const search = (i: number, nextSlot: number, cost: number): void => {
    if (cost >= best.cost) return;
    if (i === types.length) {
      best = { cost, slots: [...current] };
      return;
    }
    for (let k = nextSlot; k < NUMERIC_SLOTS.length; k++) {
      if (NUMERIC_SLOTS[k].type !== types[i]) continue;
      current.push(k);
      search(i + 1, k + 1, cost + Math.abs(xs[i] - slotX[k]));
      current.pop();
    }
    current.push(-1);
    search(i + 1, nextSlot, cost + SKIP_COST);
    current.pop();
  };

  search(0, 0, 0);
  return best.slots;
}

const cleanNumber = (text: string): string => text.replace(/[$,]/g, "");

interface Fragment {
  tokens: Word[];
  slope: number | null;
  sumX: number;
  sumY: number;
}

// Slope (dy/dx) of the line through a fragment's word centers. A single word
// or a short run can't give a reliable slope, so those return null.
function fitSlope(tokens: Word[]): number | null {
  if (tokens.length < 2) return null;
  const xs = tokens.map((t) => t.cx);
  if (Math.max(...xs) - Math.min(...xs) < 250) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = tokens.reduce((s, t) => s + t.cy, 0) / tokens.length;
  let num = 0;
  let den = 0;
  for (const t of tokens) {
    num += (t.cx - mx) * (t.cy - my);
    den += (t.cx - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

const makeFragment = (tokens: Word[]): Fragment => ({
  tokens,
  slope: fitSlope(tokens),
  sumX: tokens.reduce((s, t) => s + t.cx, 0),
  sumY: tokens.reduce((s, t) => s + t.cy, 0),
});

const fragmentX = (f: Fragment): number => f.sumX / f.tokens.length;

const medianSlope = (fragments: Fragment[]): number =>
  median(fragments.map((f) => f.slope).filter((s): s is number => s !== null));

// Height of a fragment's line at `x`, extended along its own slope (or a
// fallback when it's too short to fit one).
function heightAtX(f: Fragment, x: number, fallbackSlope: number): number {
  return f.sumY / f.tokens.length + (f.slope ?? fallbackSlope) * (x - fragmentX(f));
}

// Merges fragments that sit on the same line, closest first. Only used within
// one side of the table (all-left or all-right), where fragments are close
// enough that a shared slope is accurate.
function mergeCollinear(input: Fragment[], medH: number): Fragment[] {
  let fragments = input;
  const fallback = medianSlope(fragments);
  const heightAt = (f: Fragment, slope: number): number => (f.sumY - slope * f.sumX) / f.tokens.length;

  for (;;) {
    let best: { a: number; b: number; dy: number } | null = null;
    for (let a = 0; a < fragments.length; a++) {
      for (let b = a + 1; b < fragments.length; b++) {
        const slopes = [fragments[a].slope, fragments[b].slope].filter((s): s is number => s !== null);
        const slope = slopes.length ? slopes.reduce((s, v) => s + v, 0) / slopes.length : fallback;
        const dy = Math.abs(heightAt(fragments[a], slope) - heightAt(fragments[b], slope));
        if (dy <= medH && (!best || dy < best.dy)) best = { a, b, dy };
      }
    }
    if (!best) return fragments;
    const { a, b } = best;
    const merged = makeFragment([...fragments[a].tokens, ...fragments[b].tokens]);
    fragments = [...fragments.filter((_, i) => i !== a && i !== b), merged];
  }
}

// Pairs the left halves of rows (SAN + description) with the right halves
// (unit/qty/price/total) that Vision left as separate fragments. Both lists
// run top to bottom in the same order, and the vertical offset between a
// row's two halves changes only slowly from one row to the next — so the
// pairing is the longest monotone chain of pairs whose offsets stay
// consistent. This survives what a per-pair geometric guess can't: a page
// that curls (2° tilt on the left vs 6° on the right) and rows whose right
// half Vision couldn't read at all. `firstOffset` (taken from the table's
// header labels) anchors the chain so it can't slip by a whole row.
function pairHalves(
  left: number[],
  right: number[],
  firstOffset: number,
  startTolerance: number,
  stepTolerance: number,
): [number, number][] {
  const offset = (i: number, j: number): number => right[j] - left[i];
  const length = left.map(() => right.map(() => 0));
  const from = left.map(() => right.map((): [number, number] | null => null));
  let best = { length: 0, i: -1, j: -1 };

  for (let i = 0; i < left.length; i++) {
    for (let j = 0; j < right.length; j++) {
      const o = offset(i, j);
      let bestLength = Math.abs(o - firstOffset) <= startTolerance ? 1 : 0;
      let bestFrom: [number, number] | null = null;
      for (let pi = i - 1; pi >= 0; pi--) {
        for (let pj = j - 1; pj >= 0; pj--) {
          if (length[pi][pj] + 1 > bestLength && length[pi][pj] > 0 && Math.abs(o - offset(pi, pj)) <= stepTolerance) {
            bestLength = length[pi][pj] + 1;
            bestFrom = [pi, pj];
          }
        }
      }
      length[i][j] = bestLength;
      from[i][j] = bestFrom;
      if (bestLength > best.length) best = { length: bestLength, i, j };
    }
  }

  const pairs: [number, number][] = [];
  let cursor: [number, number] | null = best.length > 0 ? [best.i, best.j] : null;
  while (cursor) {
    pairs.push(cursor);
    cursor = from[cursor[0]][cursor[1]];
  }
  return pairs.reverse();
}

// Groups table words into rows.
//  1. Link adjacent words / adjacent columns (short hops, where a word's own
//     angle is reliable) into fragments. A word's box angle on near-horizontal
//     text is off by ~1°, which is 20+px over the ~1000px between the
//     description and the price columns — nearly half a row — so long hops
//     are not decided from a single word's angle.
//  2. Merge fragments within the left half and within the right half.
//  3. Pair the remaining left-only and right-only fragments (pairHalves).
function groupIntoRows(tokens: Word[], medH: number, numericStart: number, curve: Curve): Word[][] {
  const sorted = [...tokens].sort((a, b) => a.cx - b.cx);
  const parent = sorted.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  const maxGap = 9 * medH;
  sorted.forEach((t, i) => {
    let best = -1;
    let bestX1 = -Infinity;
    sorted.forEach((p, j) => {
      if (j === i || p.x1 > t.x0 + 0.3 * t.h || p.x1 <= bestX1 || t.x0 - p.x1 > maxGap) return;
      if (Math.abs(t.cy - expectedY(p, t)) <= 0.8 * medH) {
        best = j;
        bestX1 = p.x1;
      }
    });
    if (best >= 0) parent[root(i)] = root(best);
  });

  const byRoot = new Map<number, Word[]>();
  sorted.forEach((t, i) => {
    const key = root(i);
    byRoot.set(key, [...(byRoot.get(key) ?? []), t]);
  });
  const fragments = [...byRoot.values()].map(makeFragment);

  const whole = fragments.filter((f) => f.tokens.some((t) => t.cx < numericStart) && f.tokens.some((t) => t.cx >= numericStart));
  const leftOnly = mergeCollinear(fragments.filter((f) => f.tokens.every((t) => t.cx < numericStart)), medH);
  const rightOnly = mergeCollinear(fragments.filter((f) => f.tokens.every((t) => t.cx >= numericStart)), medH);

  const rows = whole.map((f) => f.tokens);
  if (leftOnly.length === 0 || rightOnly.length === 0) {
    return [...rows, ...leftOnly.map((f) => f.tokens), ...rightOnly.map((f) => f.tokens)];
  }

  const leftX = median(leftOnly.map(fragmentX));
  const rightX = median(rightOnly.map(fragmentX));
  const leftSlope = medianSlope(leftOnly);
  const rightSlope = medianSlope(rightOnly);
  const byY = (list: Fragment[], x: number, slope: number) =>
    list.map((f) => ({ f, y: heightAtX(f, x, slope) })).sort((a, b) => a.y - b.y);
  const L = byY(leftOnly, leftX, leftSlope);
  const R = byY(rightOnly, rightX, rightSlope);

  const pairs = pairHalves(
    L.map((l) => l.y),
    R.map((r) => r.y),
    curve(rightX) - curve(leftX),
    1.3 * medH,
    0.8 * medH,
  );

  const pairedL = new Set(pairs.map(([i]) => i));
  const pairedR = new Set(pairs.map(([, j]) => j));
  for (const [i, j] of pairs) rows.push([...L[i].f.tokens, ...R[j].f.tokens]);
  L.forEach((l, i) => !pairedL.has(i) && rows.push(l.f.tokens));
  R.forEach((r, j) => !pairedR.has(j) && rows.push(r.f.tokens));
  return rows;
}

// The SAN header label. A neighbouring sheet caught at the edge of the photo
// can show its own SAN column (with its own "SAN" label), so the label
// nearest "Description" on its left wins over simply the topmost one.
function findSanLabel(words: Word[], desc: Word | undefined): Word | undefined {
  if (!desc) return findLabel(words, "san");
  const dist = (w: Word): number => Math.hypot(w.cx - desc.cx, w.cy - desc.cy);
  return words.filter((w) => norm(w.text) === "san" && w.cx < desc.cx).sort((a, b) => dist(a) - dist(b))[0];
}

// Staff write notes after the printed description ("- missing 1 box",
// "- confirmed ok"). Vision reads handwriting at low confidence (~0.3-0.6 vs
// 0.8+ for print) and the notes start with a dash, so the description ends at
// the first dash whose tail is mostly low-confidence words.
function splitAnnotation(words: Word[]): { name: Word[]; annotated: boolean } {
  for (let i = 1; i < words.length; i++) {
    if (!/^[-~–—]/.test(words[i].text)) continue;
    const tail = words.slice(i);
    if (tail.reduce((s, w) => s + w.confidence, 0) / tail.length < 0.7) return { name: words.slice(0, i), annotated: true };
  }
  return { name: words, annotated: false };
}

const CELL_FIELDS = ["unit_count", "unit", "quantity", "item_price", "total_item_price"] as const;

// On a strongly tilted photo a row's two halves can still come out unpaired:
// the description with nothing (or only Unit/Box) to its right, next to an
// item that has numbers but no description. Adjacent, and not both claiming
// the same cell, they're one row.
function mergeSplitRows(items: ParsedItem[]): ParsedItem[] {
  const named = (i: ParsedItem): boolean => Boolean(i.item_code || i.item_name);
  const out: ParsedItem[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (!prev || named(prev) === named(item)) {
      out.push(item);
      continue;
    }
    const [base, extra] = named(prev) ? [prev, item] : [item, prev];
    if (base.total_item_price || CELL_FIELDS.some((f) => base[f] && extra[f])) {
      out.push(item);
      continue;
    }
    const cells = Object.fromEntries(CELL_FIELDS.filter((f) => extra[f]).map((f) => [f, extra[f]]));
    out[out.length - 1] = { ...base, ...cells, has_annotation: base.has_annotation || extra.has_annotation };
  }
  return out;
}

const positive = (text: string): number | null => {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
};

// Qty and Unit/Box are whole numbers; the tolerance only absorbs float noise
// from the division, not a real mismatch.
function whole(x: number): number | null {
  const r = Math.round(x);
  return r >= 1 && r <= 99999 && Math.abs(x - r) < 1e-6 * Math.max(1, x) ? r : null;
}

// Printed totals are exact to the cent on every sample receipt.
const agrees = (u: number, q: number, p: number, t: number): boolean => Math.abs(u * q * p - t) < 0.006;

// "2✓7.75" reads as "27.75": a tick running from the Qty cell into the price
// glues the qty digit onto it. Dropping that digit is a second reading of the
// price, and the dropped digit hints at the qty.
function priceReadings(raw: string): { price: number; qtyHint: number | null }[] {
  const price = positive(raw);
  if (price === null) return [];
  const glued = raw.match(/^(\d)(\d+\.\d{2})$/);
  return glued
    ? [{ price, qtyHint: null }, { price: Number(glued[2]), qtyHint: Number(glued[1]) }]
    : [{ price, qtyHint: null }];
}

// Fills cells from the row's own printed arithmetic, Total = Qty × Unit/Box ×
// Sales Price (main-file.md §4). Staff strike through Qty and UOM while
// checking a delivery and Vision mostly can't read what's under the stroke,
// but Unit/Box and Total are left clean — so Qty comes back as the one whole
// number that makes the row add up. A filled cell is listed in `inferred`,
// never passed off as read. A row that can't be made to add up is left as
// read; the review screen flags the mismatch.
export function reconcileItem(item: ParsedItem): ParsedItem {
  const out: ParsedItem = { ...item, inferred: [...item.inferred] };
  const set = (field: InferredField, value: string): void => {
    out[field] = value;
    if (!out.inferred.includes(field)) out.inferred.push(field);
  };

  // A PIECE row's Unit/Box is always 1, so a struck-through one is known.
  if (!out.unit_count && out.unit === "PIECE") set("unit_count", "1");

  const u = positive(out.unit_count);
  const q = positive(out.quantity);
  const t = positive(out.total_item_price);
  const readings = priceReadings(out.item_price);

  if (u !== null && t !== null && readings.length > 0) {
    const solved = readings.flatMap((r) => {
      const qty = whole(t / (u * r.price));
      return qty === null ? [] : [{ ...r, qty }];
    });
    const pick =
      solved.find((s) => s.qty === q) ??
      solved.find((s) => s.qtyHint === null) ??
      solved.find((s) => s.qtyHint === s.qty) ??
      solved[0];
    if (pick) {
      if (pick.price !== readings[0].price) set("item_price", pick.price.toFixed(2));
      if (pick.qty !== q) {
        // A Qty was read but the printed arithmetic says otherwise — usually a
        // handwritten count next to the struck-through printed one.
        if (q !== null) out.has_annotation = true;
        set("quantity", String(pick.qty));
      }
    }
  } else if (u !== null && t !== null && q !== null) {
    const price = Math.round((t / (u * q)) * 100) / 100;
    if (agrees(u, q, price, t)) set("item_price", price.toFixed(2));
  } else if (u === null && t !== null && q !== null && readings.length > 0) {
    const unitCount = whole(t / (q * readings[0].price));
    if (unitCount !== null) set("unit_count", String(unitCount));
  } else if (t === null && u !== null && q !== null && readings.length > 0) {
    set("total_item_price", (u * q * readings[0].price).toFixed(2));
  }

  // Unit/Box 1 is sold by the piece on every receipt seen so far, anything
  // else by the box. (ocr.ts prefers this store's history for the item.)
  const unitCount = positive(out.unit_count);
  if (!out.unit && unitCount !== null) set("unit", unitCount === 1 ? "PIECE" : "BOX");
  return out;
}

export interface ItemHistory {
  unit: string | null;
  unit_count: number | null;
}

// Fills a struck-through UOM, or a Unit/Box hidden under the watermark, from
// how this store last received the same item, then re-runs the row
// arithmetic now that more of the row is known.
export function applyItemHistory(receipt: ParsedReceipt, history: Map<string, ItemHistory>): ParsedReceipt {
  const items = receipt.items.map((item) => {
    const known = history.get(item.item_code);
    if (!known) return item;
    const out: ParsedItem = { ...item, inferred: [...item.inferred] };
    if (known.unit && (!out.unit || out.inferred.includes("unit"))) {
      out.unit = known.unit;
      if (!out.inferred.includes("unit")) out.inferred.push("unit");
    }
    if (known.unit_count && !out.unit_count) {
      out.unit_count = String(known.unit_count);
      out.inferred.push("unit_count");
    }
    return reconcileItem(out);
  });
  return { ...receipt, items };
}

const NO_TOTALS: ParsedTotals = { total_pcs: "", total_box: "", total_items: "", total_value: "" };

// Reads the printed totals block. "Total Value:" is reliable (its label
// survives and the amount sits right of it). The Pcs/Box/Item/s labels are
// usually dropped, leaving a bare stack of numbers that is only read when its
// meaning is unambiguous: three numbers are Pcs, Box, Item/s; two are Box,
// Item/s only on a page without PIECE rows (the template omits Total Pcs
// then). Vision sometimes reads one cell twice ("222" over "23"); the
// lower-confidence duplicate is dropped.
function parseTotals(region: Word[], columnX: number[], medH: number, hasPieceRows: boolean): ParsedTotals {
  const totals = { ...NO_TOTALS };

  const valueLabel = region.find((w) => norm(w.text) === "value");
  if (valueLabel) {
    const amount = region
      .filter((w) => w.cx > valueLabel.x1 && Math.abs(w.cy - valueLabel.cy) < 1.2 * medH && readToken(w.text)?.type === "money")
      .sort((a, b) => a.x0 - b.x0)[0];
    if (amount) totals.total_value = cleanNumber(amount.text);
  }

  const left = columnX[1] - 0.6 * (columnX[2] - columnX[1]);
  const right = columnX[3] + 0.3 * (columnX[4] - columnX[3]);
  const stack = region
    .filter((w) => w.cx >= left && w.cx <= right && readToken(w.text)?.type === "int")
    .sort((a, b) => b.confidence - a.confidence)
    .filter((w, i, all) => !all.slice(0, i).some((o) => Math.abs(o.cy - w.cy) < 0.5 * medH && Math.abs(o.cx - w.cx) < medH))
    .sort((a, b) => a.cy - b.cy)
    .map((w) => cleanNumber(w.text));

  if (stack.length === 3) [totals.total_pcs, totals.total_box, totals.total_items] = stack;
  else if (stack.length === 2 && !hasPieceRows) [totals.total_box, totals.total_items] = stack;
  return totals;
}

function parseItems(
  words: Word[],
  pool: Word[],
  medH: number,
): { items: ParsedItem[]; totals: ParsedTotals; headerPool: Word[] } {
  const desc = findLabel(words, "description");
  const san = findSanLabel(words, desc);
  const unit = findLabel(words, "unit");
  const uom = findLabel(words, "uom");
  const qty = findLabel(words, "qty");
  const sales = findLabel(words, "sales");
  const total = findLabel(words, "total", (w) => (sales ? w.cx > sales.cx : qty ? w.cx > qty.cx : true));

  const labels = [san, desc, unit, uom, qty, sales, total].filter((w): w is Word => Boolean(w));
  const curve = buildCurve(labels.map((w) => ({ x: w.cx, y: w.cy })));
  const numericX = fillColumnPositions([unit?.cx, uom?.cx, qty?.cx, sales?.cx, total?.cx]);
  if (!curve || !numericX) return { items: [], totals: { ...NO_TOTALS }, headerPool: pool };

  const yr = (w: Word): number => w.cy - curve(w.cx);
  const tableTop = 2.2 * medH;
  const headerPool = words.filter((w) => yr(w) < tableTop);

  const initialNumericStart = numericX[0] - 0.5 * (numericX[1] - numericX[0]);
  const rows = groupIntoRows(
    words.filter((w) => yr(w) >= tableTop),
    medH,
    initialNumericStart,
    curve,
  )
    .map((ws) => {
      const sorted = [...ws].sort((a, b) => a.x0 - b.x0);
      return { words: sorted, leftYr: yr(sorted[0]), meanYr: ws.reduce((s, w) => s + yr(w), 0) / ws.length };
    })
    .sort((a, b) => a.meanYr - b.meanYr);

  // The "Total Box: / Total Item/s: / Total Value:" block marks the end of the
  // item rows; the page footer printed below it must not be read as an item.
  // Vision often drops the white-on-grey "Box"/"Item/s"/"Value" words, leaving
  // a lone "Total", so a row that starts with "Total" counts as a footer too.
  const isFooter = (ws: Word[]): boolean =>
    norm(ws[0].text) === "total" ||
    ws.some((w, i) => norm(w.text) === "total" && ["box", "items", "value"].includes(norm(ws[i + 1]?.text ?? "")));
  const footerYr = Math.min(...rows.filter((r) => isFooter(r.words)).map((r) => r.leftYr));
  const itemRows = rows.filter((r) => !isFooter(r.words) && r.leftYr < footerYr - 0.5 * medH);

  // Column x positions, tracked down the table so a page tilted enough to
  // shift columns sideways across dozens of rows still lines up row to row.
  // Index 0 is the SAN column, 1.. are NUMERIC_SLOTS.
  const sanX = san ? san.cx : desc ? desc.cx - 250 : -Infinity;
  const columnX = [sanX, ...numericX];
  const sanReach = san && desc ? Math.max(40, 0.5 * (desc.x0 - san.cx)) : 80;

  const items: ParsedItem[] = [];

  for (const row of itemRows) {
    const numericStart = columnX[1] - 0.5 * (columnX[2] - columnX[1]);
    // Anything well left of the SAN column belongs to a neighbouring sheet
    // caught at the edge of the photo, not to this row.
    const left = row.words.filter((w) => w.cx < numericStart && w.cx >= columnX[0] - 2.5 * sanReach);
    const numeric = row.words
      .filter((w) => w.cx >= numericStart)
      .map((w) => ({ w, token: readToken(w.text) }))
      .filter((t): t is { w: Word; token: Token } => t.token !== null);

    const slots = assignSlots(
      numeric.map((t) => t.token.type),
      numeric.map((t) => t.w.cx),
      columnX.slice(1),
    );

    const item: ParsedItem = {
      item_code: "",
      item_name: "",
      unit_count: "",
      unit: "",
      quantity: "",
      item_price: "",
      total_item_price: "",
      inferred: [],
      has_annotation: false,
    };

    const deltas: number[] = [];
    const seen = new Set<number>();
    numeric.forEach((t, i) => {
      const slot = slots[i];
      if (slot < 0) return;
      item[NUMERIC_SLOTS[slot].field] = t.token.value;
      deltas.push(t.w.cx - columnX[slot + 1]);
      columnX[slot + 1] = t.w.cx;
      seen.add(slot + 1);
    });

    let nameWords = left;
    if (left.length > 0 && left[0].cx < columnX[0] + sanReach) {
      item.item_code = left[0].text;
      deltas.push(left[0].cx - columnX[0]);
      columnX[0] = left[0].cx;
      seen.add(0);
      nameWords = left.slice(1);
    }
    const { name, annotated } = splitAnnotation(nameWords);
    item.item_name = joinWords(name);
    item.has_annotation = annotated;

    const shift = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : 0;
    columnX.forEach((_, k) => {
      if (!seen.has(k)) columnX[k] += shift;
    });

    if (item.item_code || item.item_price || item.total_item_price) items.push(item);
  }

  const reconciled = mergeSplitRows(items).map(reconcileItem);
  const totalsRegion = Number.isFinite(footerYr)
    ? words.filter((w) => yr(w) > footerYr - 0.6 * medH && yr(w) < footerYr + 4.5 * medH)
    : [];
  const totals = parseTotals(totalsRegion, columnX, medH, reconciled.some((i) => i.unit === "PIECE"));

  return { items: reconciled, totals, headerPool };
}

export function parseReceipt(pages: VisionPage[]): ParsedReceipt {
  const words = extractWords(pages);
  const medH = median(words.map((w) => w.h));
  const { items, totals, headerPool } = parseItems(words, words, medH);

  return {
    header: parseHeader(headerPool, parseFooter(words)),
    items,
    totals,
  };
}
