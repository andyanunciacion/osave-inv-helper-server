// Sets (or changes) a store's staff passcode, creating the store if it doesn't
// exist yet. A store can't be used from the app until it has one
// (src/lib/store-auth.ts). Changing it signs every phone out of that store —
// staff get asked for the new passcode on their next request.
//
//   npm run store:passcode -- <store_code> [store name]
//
// The passcode is typed at a prompt, not passed as an argument, so it doesn't
// end up in shell history. It's shown as you type it.

import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { normalizeStoreCode } from "../src/lib/normalize.js";
import { hashPasscode, passcodeProblem } from "../src/lib/passcode.js";
import { supabase } from "../src/lib/supabase.js";

const [rawStoreCode, ...nameParts] = process.argv.slice(2);
const storeCode = normalizeStoreCode(rawStoreCode ?? "");
if (!storeCode) {
  console.error("Usage: npm run store:passcode -- <store_code> [store name]");
  process.exit(1);
}

const prompt = createInterface({ input: process.stdin, output: process.stdout });
const passcode = await prompt.question(`New passcode for store ${storeCode}: `);
const confirmation = await prompt.question("Type it again: ");
prompt.close();

const problem = passcodeProblem(passcode);
if (problem) {
  console.error(problem);
  process.exit(1);
}
if (passcode !== confirmation) {
  console.error("The two passcodes don't match — nothing was changed.");
  process.exit(1);
}

const { data: existing, error: readError } = await supabase
  .from("stores")
  .select("name")
  .eq("store_code", storeCode)
  .maybeSingle();
if (readError) {
  console.error(`Couldn't read store ${storeCode}: ${readError.message}`);
  process.exit(1);
}

// Keep an existing store's name unless a new one was given.
const name = nameParts.join(" ").trim() || existing?.name || storeCode;
const { error: writeError } = await supabase
  .from("stores")
  .upsert({ store_code: storeCode, name, passcode_hash: await hashPasscode(passcode) });
if (writeError) {
  console.error(`Couldn't save the passcode: ${writeError.message}`);
  process.exit(1);
}

console.log(`${existing ? "Updated" : "Created"} store ${storeCode} (${name}) with the new passcode.`);
