import type { Request, Response } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPasscode } from "../src/lib/passcode.js";

// The middleware's only Supabase call: stores.passcode_hash for one store.
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("../src/lib/supabase.js", () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: (_column: string, code: string) => ({ maybeSingle: () => lookup(code) }) }) }),
  },
}));

const { requireStoreAccess } = await import("../src/lib/store-auth.js");

let storedHash: string;
beforeAll(async () => {
  storedHash = await hashPasscode("right-pass");
});

beforeEach(() => {
  lookup.mockReset().mockImplementation(async (code: string) => ({
    data: code === "245" ? { passcode_hash: storedHash } : code === "300" ? { passcode_hash: null } : null,
    error: null,
  }));
});

function call({
  headers = {},
  query = {},
  body,
}: { headers?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { get: (name: string) => lower[name.toLowerCase()], query, body } as unknown as Request;
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    locals: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next, run: () => requireStoreAccess(req, res as unknown as Response, next) };
}

const signedIn = { "X-Store-Code": " 245 ", "X-Store-Passcode": "right-pass" };

describe("requireStoreAccess", () => {
  it("lets the right passcode through and records the normalized store", async () => {
    const { res, next, run } = call({ headers: signedIn, query: { store_code: "245" } });
    await run();
    expect(next).toHaveBeenCalled();
    expect(res.locals.authStoreCode).toBe("245");
  });

  it("refuses a request with no store code or passcode", async () => {
    const { res, next, run } = call({ headers: { "X-Store-Code": "245" } });
    await run();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: "unauthorized" });
  });

  it("refuses a wrong passcode", async () => {
    const { res, next, run } = call({ headers: { ...signedIn, "X-Store-Passcode": "wrong-pass" } });
    await run();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: "unauthorized" });
  });

  it("says a store without a passcode, or with no row at all, isn't set up", async () => {
    for (const code of ["300", "999"]) {
      const { res, next, run } = call({ headers: { "X-Store-Code": code, "X-Store-Passcode": "anything" } });
      await run();
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ error: "store_not_set_up" });
    }
  });

  it("forbids naming another store in the query or JSON body", async () => {
    for (const named of [{ query: { store_code: "301" } }, { body: { store_code: "301" } }]) {
      const { res, next, run } = call({ headers: signedIn, ...named });
      await run();
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
  });

  it("compares the named store after normalizing it", async () => {
    const { next, run } = call({ headers: signedIn, body: { store_code: " 245" } });
    await run();
    expect(next).toHaveBeenCalled();
  });
});
