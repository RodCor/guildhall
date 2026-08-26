import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = (exports as unknown as { default: Fetcher }).default;

describe("Guildhall Worker routing boundary", () => {
  it("returns a structured 404 instead of dereferencing an absent asset binding", async () => {
    const response = await worker.fetch(
      "https://guildhall.test/api/route-that-does-not-exist",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: "NOT_FOUND",
      message: "The requested Guildhall Worker route does not exist",
    });
  });
});
