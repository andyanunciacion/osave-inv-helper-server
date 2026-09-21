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
}

export interface ParsedItem {
  item_code: string;
  item_name: string;
  unit_count: string;
  unit: string;
  quantity: string;
  item_price: string;
  total_item_price: string;
}

export interface ParsedReceipt {
  header: ParsedHeader;
  items: ParsedItem[];
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

function parseHeader(pool: Word[]): ParsedHeader {
  const codeLabel = findSequence(pool, ["inv", "tran", "no"]);
  const fromLabel = findSequence(pool, ["from"]);
  const dateLabel = findSequence(pool, ["transaction", "date"]);
  const toWord = pool.find((w) => norm(w.text) === "to");

  const deliveryCode = codeLabel ? joinWords(valueRightOf(codeLabel, pool)).replace(/\s+/g, "") : "";
  const warehouseCode = fromLabel ? joinWords(valueRightOf(fromLabel, pool)) : "";

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

function tokenType(text: string): TokenType | null {
  if (MONEY_RE.test(text)) return "money";
  if (/^\d{1,4}$/.test(text)) return "int";
  if (/^(box|piece|pcs|pc)$/i.test(text)) return "uom";
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

function parseItems(words: Word[], pool: Word[], medH: number): { items: ParsedItem[]; headerPool: Word[] } {
  const san = findLabel(words, "san");
  const desc = findLabel(words, "description");
  const unit = findLabel(words, "unit");
  const uom = findLabel(words, "uom");
  const qty = findLabel(words, "qty");
  const sales = findLabel(words, "sales");
  const total = findLabel(words, "total", (w) => (sales ? w.cx > sales.cx : qty ? w.cx > qty.cx : true));

  const labels = [san, desc, unit, uom, qty, sales, total].filter((w): w is Word => Boolean(w));
  const curve = buildCurve(labels.map((w) => ({ x: w.cx, y: w.cy })));
  const numericX = fillColumnPositions([unit?.cx, uom?.cx, qty?.cx, sales?.cx, total?.cx]);
  if (!curve || !numericX) return { items: [], headerPool: pool };

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
    const left = row.words.filter((w) => w.cx < numericStart);
    const numeric = row.words
      .filter((w) => w.cx >= numericStart)
      .map((w) => ({ w, type: tokenType(w.text) }))
      .filter((t): t is { w: Word; type: TokenType } => t.type !== null);

    const slots = assignSlots(
      numeric.map((t) => t.type),
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
    };

    const deltas: number[] = [];
    const seen = new Set<number>();
    numeric.forEach((t, i) => {
      const slot = slots[i];
      if (slot < 0) return;
      const { field } = NUMERIC_SLOTS[slot];
      item[field] = field === "unit" ? (/^piece|pcs?$/i.test(t.w.text) ? "PIECE" : "BOX") : cleanNumber(t.w.text);
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
    item.item_name = joinWords(nameWords);

    const shift = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : 0;
    columnX.forEach((_, k) => {
      if (!seen.has(k)) columnX[k] += shift;
    });

    if (item.item_code || item.item_price || item.total_item_price) items.push(item);
  }

  return { items, headerPool };
}

export function parseReceipt(pages: VisionPage[]): ParsedReceipt {
  const words = extractWords(pages);
  const medH = median(words.map((w) => w.h));
  const { items, headerPool } = parseItems(words, words, medH);

  return {
    header: parseHeader(headerPool),
    items,
  };
}
