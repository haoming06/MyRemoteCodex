import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { assertPrivateFile } from "./tunnel.js";

export const GATEWAY_TOKEN_HEADER = "x-remote-codex-gateway-token";

export class GatewayAccess {
  private constructor(private readonly token: Buffer) {}

  static async fromFile(filePath: string): Promise<GatewayAccess> {
    await assertPrivateFile(filePath, "REMOTE_CODEX_FRP_GATEWAY_TOKEN_FILE");
    const rawToken = (await readFile(filePath, "utf8")).trim();
    const characterCount = Array.from(rawToken).length;
    if (characterCount < 8 || characterCount > 512) {
      throw new Error("REMOTE_CODEX_FRP_GATEWAY_TOKEN_FILE must contain 8-512 characters");
    }
    const token = Buffer.from(rawToken, "utf8");
    return new GatewayAccess(token);
  }

  accepts(headers: IncomingHttpHeaders): boolean {
    const raw = headers[GATEWAY_TOKEN_HEADER];
    if (typeof raw !== "string") return false;
    const candidate = Buffer.from(raw, "utf8");
    return candidate.length === this.token.length && timingSafeEqual(candidate, this.token);
  }
}
