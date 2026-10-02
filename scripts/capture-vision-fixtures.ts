// One-off: runs each receipt photo in a folder through Google Vision once and
// saves the word geometry receipt-parser.ts reads, so parser changes can be
// regression-tested offline without paying for another Vision call.
//
//   npx tsx scripts/capture-vision-fixtures.ts <image-dir> <out-dir>
//
// Every image is one billed Vision call. Existing fixtures are skipped, so
// re-running only captures new photos.
//
// Only the fields the parser uses are kept (word boxes, symbol text, breaks,
// confidences) — page/block geometry and everything else is dropped to keep
// the files small.

import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { protos } from "@google-cloud/vision";
import { detectReceiptPages } from "../src/lib/vision.js";

type VisionPage = protos.google.cloud.vision.v1.IPage;

const IMAGE_EXT = /\.(jpe?g|jfif|png|webp)$/i;

function reduce(pages: VisionPage[]): VisionPage[] {
  return pages.map((page) => ({
    width: page.width,
    height: page.height,
    blocks: (page.blocks ?? []).map((block) => ({
      paragraphs: (block.paragraphs ?? []).map((paragraph) => ({
        words: (paragraph.words ?? []).map((word) => ({
          confidence: word.confidence,
          boundingBox: { vertices: (word.boundingBox?.vertices ?? []).map((v) => ({ x: v.x ?? 0, y: v.y ?? 0 })) },
          symbols: (word.symbols ?? []).map((symbol) => ({
            text: symbol.text,
            confidence: symbol.confidence,
            ...(symbol.property?.detectedBreak
              ? { property: { detectedBreak: { type: symbol.property.detectedBreak.type } } }
              : {}),
          })),
        })),
      })),
    })),
  }));
}

async function main(): Promise<void> {
  const [imageDir, outDir] = process.argv.slice(2);
  if (!imageDir || !outDir) {
    console.error("usage: npx tsx scripts/capture-vision-fixtures.ts <image-dir> <out-dir>");
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const files = (await readdir(imageDir)).filter((f) => IMAGE_EXT.test(f)).sort();

  for (const file of files) {
    const outPath = path.join(outDir, `${path.parse(file).name}.json`);
    if (existsSync(outPath)) {
      console.log(`skip     ${file} (fixture exists)`);
      continue;
    }
    const pages = await detectReceiptPages(await readFile(path.join(imageDir, file)));
    await writeFile(outPath, `${JSON.stringify(reduce(pages))}\n`);
    console.log(`captured ${file} -> ${outPath}`);
  }
}

await main();
