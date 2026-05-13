import { describe, it, expect } from "vitest";
import { upgradeCacheControlTtl } from "./credential-proxy.js";

describe("upgradeCacheControlTtl", () => {
  it("adds ttl=1h to ephemeral cache_control on /v1/messages", () => {
    const body = Buffer.from(
      JSON.stringify({
        system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
        tools: [{ name: "t", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const r = upgradeCacheControlTtl(body, "/v1/messages");
    expect(r.modified).toBe(true);
    expect(r.upgradedCount).toBe(2);
    const parsed = JSON.parse(r.body.toString());
    expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(parsed.tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("leaves explicit ttl alone", () => {
    const body = Buffer.from(
      JSON.stringify({ system: [{ cache_control: { type: "ephemeral", ttl: "5m" } }] }),
    );
    const r = upgradeCacheControlTtl(body, "/v1/messages");
    expect(r.modified).toBe(false);
    expect(r.body).toBe(body);
  });

  it("is a no-op on non-/v1/messages paths", () => {
    const body = Buffer.from(JSON.stringify({ cache_control: { type: "ephemeral" } }));
    const r = upgradeCacheControlTtl(body, "/v1/something");
    expect(r.modified).toBe(false);
  });

  it("handles empty body", () => {
    expect(upgradeCacheControlTtl(Buffer.alloc(0), "/v1/messages").modified).toBe(false);
  });

  it("handles non-JSON body", () => {
    expect(upgradeCacheControlTtl(Buffer.from("not json"), "/v1/messages").modified).toBe(false);
  });

  it("walks nested arrays", () => {
    const body = Buffer.from(
      JSON.stringify({ a: [{ b: { cache_control: { type: "ephemeral" } } }] }),
    );
    const r = upgradeCacheControlTtl(body, "/v1/messages");
    expect(r.modified).toBe(true);
    expect(r.upgradedCount).toBe(1);
  });
});
