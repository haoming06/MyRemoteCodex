import { randomBytes, timingSafeEqual } from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_FAILURES_PER_ADDRESS = 8;
const MAX_GLOBAL_FAILURES = 256;
const MAX_TRACKED_ADDRESSES = 4_096;
export const SESSION_COOKIE = "remote_codex_session";

interface AttemptWindow {
  count: number;
  resetAt: number;
}

export interface PairingManagerOptions {
  code?: string;
  sessionTtlMs: number;
  now?: () => number;
}

export type PairResult =
  | { ok: true; sessionId: string; expiresAt: number }
  | { ok: false; status: 401 | 429 };

function generatedCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class PairingManager {
  readonly code: string;
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, AttemptWindow>();
  private globalAttempts?: AttemptWindow;
  private readonly now: () => number;

  constructor(private readonly options: PairingManagerOptions) {
    this.code = (options.code || generatedCode()).trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(this.code)) {
      throw new Error("Pairing code must contain exactly 8 letters or digits 2-9");
    }
    this.now = options.now || Date.now;
  }

  pair(remoteAddress: string, submittedCode: string): PairResult {
    const now = this.now();
    const normalized = submittedCode.trim().toUpperCase();
    if (equalSecret(normalized, this.code)) {
      this.attempts.delete(remoteAddress);
      for (const [sessionId, expiresAt] of this.sessions) {
        if (expiresAt <= now) this.sessions.delete(sessionId);
      }
      const sessionId = randomBytes(32).toString("base64url");
      const expiresAt = now + this.options.sessionTtlMs;
      this.sessions.set(sessionId, expiresAt);
      return { ok: true, sessionId, expiresAt };
    }

    const globalWindow = !this.globalAttempts || this.globalAttempts.resetAt <= now
      ? { count: 0, resetAt: now + 60_000 }
      : this.globalAttempts;
    if (globalWindow.count >= MAX_GLOBAL_FAILURES) return { ok: false, status: 429 };

    if (!this.attempts.has(remoteAddress) && this.attempts.size >= MAX_TRACKED_ADDRESSES) {
      for (const [address, attempt] of this.attempts) {
        if (attempt.resetAt <= now) this.attempts.delete(address);
      }
      if (this.attempts.size >= MAX_TRACKED_ADDRESSES) return { ok: false, status: 429 };
    }
    const current = this.attempts.get(remoteAddress);
    const window = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + 60_000 }
      : current;

    if (window.count >= MAX_FAILURES_PER_ADDRESS) {
      this.attempts.set(remoteAddress, window);
      return { ok: false, status: 429 };
    }

    window.count += 1;
    globalWindow.count += 1;
    this.attempts.set(remoteAddress, window);
    this.globalAttempts = globalWindow;
    return { ok: false, status: 401 };
  }

  validate(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const expiresAt = this.sessions.get(sessionId);
    if (!expiresAt) return false;
    if (expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  expiresAt(sessionId: string | undefined): number | undefined {
    if (!sessionId || !this.validate(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  revoke(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      continue;
    }
  }
  return cookies;
}

export function sessionCookie(
  sessionId: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
