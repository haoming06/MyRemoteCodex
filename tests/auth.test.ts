import { describe, expect, it } from "vitest";
import { PairingManager, parseCookies, sessionCookie, SESSION_COOKIE } from "../src/auth.js";

describe("PairingManager", () => {
  it("generates an 8-character pairing code by default", () => {
    const manager = new PairingManager({ sessionTtlMs: 60_000 });
    expect(manager.code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("requires exactly 8 characters", () => {
    expect(() => new PairingManager({ code: "ABCD23456", sessionTtlMs: 60_000 }))
      .toThrow("Pairing code must contain exactly 8 letters or digits 2-9");
  });

  it("matches pairing codes without regard to letter case", () => {
    const manager = new PairingManager({ code: "abcd2345", sessionTtlMs: 60_000 });

    expect(manager.pair("127.0.0.1", "AbCd2345").ok).toBe(true);
  });

  it("creates, validates, and revokes a session", () => {
    const manager = new PairingManager({ code: "ABCD2345", sessionTtlMs: 60_000 });
    const result = manager.pair("127.0.0.1", "abcd2345");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(manager.validate(result.sessionId)).toBe(true);
    expect(manager.expiresAt(result.sessionId)).toBe(result.expiresAt);
    manager.revoke(result.sessionId);
    expect(manager.validate(result.sessionId)).toBe(false);
    expect(manager.expiresAt(result.sessionId)).toBeUndefined();
  });

  it("expires sessions using the configured clock", () => {
    let now = 1_000;
    const manager = new PairingManager({
      code: "ABCD2345",
      sessionTtlMs: 100,
      now: () => now,
    });
    const result = manager.pair("127.0.0.1", "ABCD2345");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    now = 1_101;
    expect(manager.validate(result.sessionId)).toBe(false);
  });

  it("rate limits repeated failures without locking out the correct code", () => {
    const manager = new PairingManager({ code: "ABCD2345", sessionTtlMs: 60_000 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(manager.pair("192.0.2.10", "WRONG234")).toEqual({ ok: false, status: 401 });
    }
    expect(manager.pair("192.0.2.10", "WRONG234")).toEqual({ ok: false, status: 429 });
    expect(manager.pair("192.0.2.10", "ABCD2345").ok).toBe(true);
  });

  it("rate limits distributed failures globally", () => {
    const manager = new PairingManager({ code: "ABCD2345", sessionTtlMs: 60_000 });
    for (let attempt = 0; attempt < 256; attempt += 1) {
      expect(manager.pair(`192.0.2.${attempt}`, "WRONG234")).toEqual({ ok: false, status: 401 });
    }
    expect(manager.pair("198.51.100.1", "WRONG234")).toEqual({ ok: false, status: 429 });
    expect(manager.pair("198.51.100.1", "ABCD2345").ok).toBe(true);
  });
});

describe("session cookie", () => {
  it("uses HttpOnly strict cookies and can be parsed", () => {
    const header = sessionCookie("session value", 120, true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Secure");
    expect(parseCookies(header).get(SESSION_COOKIE)).toBe("session value");
  });
});
