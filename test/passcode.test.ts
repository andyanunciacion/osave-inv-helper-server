import { describe, expect, it } from "vitest";
import { hashPasscode, passcodeProblem, verifyPasscode } from "../src/lib/passcode.js";

describe("hashPasscode / verifyPasscode", () => {
  it("accepts the passcode it hashed and nothing else", async () => {
    const stored = await hashPasscode("store-245!");
    expect(stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(await verifyPasscode("store-245!", stored)).toBe(true);
    expect(await verifyPasscode("store-245", stored)).toBe(false);
    expect(await verifyPasscode("", stored)).toBe(false);
  });

  it("salts each hash, so the same passcode never stores the same text", async () => {
    expect(await hashPasscode("same-code")).not.toBe(await hashPasscode("same-code"));
  });

  it("treats a malformed stored hash as a non-match instead of throwing", async () => {
    for (const stored of ["", "plaintext", "scrypt$abcd", "bcrypt$aa$bb", "scrypt$aa$"]) {
      expect(await verifyPasscode("anything", stored)).toBe(false);
    }
  });
});

describe("passcodeProblem", () => {
  it("accepts printable ASCII of at least 6 characters", () => {
    expect(passcodeProblem("abc123")).toBeNull();
    expect(passcodeProblem("S7ore#245")).toBeNull();
  });

  it("rejects short passcodes and ones a browser can't send in a header", () => {
    expect(passcodeProblem("12345")).not.toBeNull();
    expect(passcodeProblem("has space")).not.toBeNull();
    expect(passcodeProblem("piñata99")).not.toBeNull();
  });
});
