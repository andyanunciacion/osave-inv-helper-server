import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// A store's staff passcode, stored as "scrypt$<salt hex>$<key hex>" in
// stores.passcode_hash — never the passcode itself.

const KEY_LENGTH = 32;

export const MIN_PASSCODE_LENGTH = 6;

// It travels in an HTTP header (X-Store-Passcode), and browsers refuse header
// values outside Latin-1, so passcodes are printable ASCII without spaces.
const PASSCODE_PATTERN = /^[\x21-\x7e]+$/;

export function passcodeProblem(passcode: string): string | null {
  if (passcode.length < MIN_PASSCODE_LENGTH) return `Use at least ${MIN_PASSCODE_LENGTH} characters.`;
  if (!PASSCODE_PATTERN.test(passcode)) return "Use letters, numbers and symbols only — no spaces or accented letters.";
  return null;
}

function deriveKey(passcode: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passcode, salt, length, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPasscode(passcode: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(passcode, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

// A malformed stored hash just fails to match — it never throws.
export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  if (expected.length === 0) return false;
  const actual = await deriveKey(passcode, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}
