import { describe, expect, it } from "vitest";
import { validatedDebuggerUrl, type CdpTarget } from "../src/cdp/target.js";

function target(overrides: Partial<CdpTarget> = {}): CdpTarget {
  return {
    id: "page.123",
    type: "page",
    title: "Codex",
    url: "app://codex/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/page.123",
    ...overrides,
  };
}

describe("validatedDebuggerUrl", () => {
  it("accepts an app page on the exact loopback port and target path", () => {
    expect(validatedDebuggerUrl(target(), 9341)).toBe(
      "ws://127.0.0.1:9341/devtools/page/page.123",
    );
  });

  it.each([
    { url: "https://example.com", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/page.123" },
    { url: "app://codex/index.html", webSocketDebuggerUrl: "ws://192.0.2.1:9341/devtools/page/page.123" },
    { url: "app://codex/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/page.123" },
    { url: "app://codex/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/other" },
  ])("rejects an endpoint outside the constrained target", (overrides) => {
    expect(() => validatedDebuggerUrl(target(overrides), 9341)).toThrow();
  });
});
