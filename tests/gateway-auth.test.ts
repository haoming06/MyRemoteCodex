import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayAccess, GATEWAY_TOKEN_HEADER } from "../src/frp/gateway-auth.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tokenFile(
  mode = 0o600,
  token = "an-independent-gateway-token-with-32-bytes",
): Promise<{ filePath: string; token: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-auth-test-"));
  directories.push(directory);
  const filePath = path.join(directory, "token");
  await writeFile(filePath, `${token}\n`, { mode });
  await chmod(filePath, mode);
  return { filePath, token };
}

describe("GatewayAccess", () => {
  it("accepts only the exact gateway-injected token", async () => {
    const { filePath, token } = await tokenFile();
    const access = await GatewayAccess.fromFile(filePath);

    expect(access.accepts({ [GATEWAY_TOKEN_HEADER]: token })).toBe(true);
    expect(access.accepts({ [GATEWAY_TOKEN_HEADER]: `${token}-wrong` })).toBe(false);
    expect(access.accepts({})).toBe(false);
  });

  it("rejects a secret file readable by other users", async () => {
    const { filePath } = await tokenFile(0o644);
    await expect(GatewayAccess.fromFile(filePath)).rejects.toThrow("group or other users");
  });

  it("requires at least 8 Unicode characters instead of 32 UTF-8 bytes", async () => {
    const shortToken = await tokenFile(0o600, "密".repeat(7));
    await expect(GatewayAccess.fromFile(shortToken.filePath)).rejects.toThrow("8-512 characters");

    const validToken = await tokenFile(0o600, "密".repeat(8));
    await expect(GatewayAccess.fromFile(validToken.filePath)).resolves.toBeInstanceOf(GatewayAccess);
  });
});
