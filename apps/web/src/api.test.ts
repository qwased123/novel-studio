import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

describe("api client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns JSON payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(api<{ ok: boolean }>("/api/health")).resolves.toEqual({ ok: true });
  });

  it("preserves server error messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "版本冲突" }), { status: 409, headers: { "Content-Type": "application/json" } }));
    await expect(api("/api/document")).rejects.toEqual(expect.objectContaining({ message: "版本冲突", status: 409 }));
  });
});
