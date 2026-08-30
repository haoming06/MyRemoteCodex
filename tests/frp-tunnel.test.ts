import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPrivateFile,
  FrpTunnel,
  renderFrpcConfig,
  type FrpRuntime,
  type FrpTunnelOptions,
} from "../src/frp/tunnel.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function options(): Promise<FrpTunnelOptions> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "frp-tunnel-test-"));
  directories.push(directory);
  const tokenFile = path.join(directory, "frp-token");
  const gatewayTokenFile = path.join(directory, "gateway-token");
  const trustedCaFile = path.join(directory, "ca.pem");
  await writeFile(tokenFile, "frp-secret", { mode: 0o600 });
  await writeFile(gatewayTokenFile, "gateway-secret-with-at-least-32-bytes", { mode: 0o600 });
  await writeFile(trustedCaFile, "test-ca", { mode: 0o644 });
  return {
    binary: "frpc",
    serverAddr: "frp.example.com",
    serverPort: 7000,
    clientId: "device_01",
    user: "tenant_01",
    subdomain: "device-01",
    tokenFile,
    gatewayTokenFile,
    verifyServerCertificate: true,
    trustedCaFile,
    serverName: "frp.example.com",
    localPort: 4310,
  };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: null,
    stderr: null,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    }),
  });
  return child;
}

describe("FRP tunnel", () => {
  it("renders a narrow HTTP proxy without embedding either secret", async () => {
    const tunnelOptions = await options();
    const config = renderFrpcConfig(tunnelOptions);

    expect(config).toContain('transport.tls.enable = true');
    expect(config).toContain('transport.tls.trustedCaFile =');
    expect(config).toContain('transport.tls.serverName = "frp.example.com"');
    expect(config).toContain('auth.tokenSource.type = "file"');
    expect(config).toContain('type = "http"');
    expect(config).toContain('localIP = "127.0.0.1"');
    expect(config).toContain("localPort = 4310");
    expect(config).toContain('healthCheck.path = "/healthz"');
    expect(config).not.toContain(tunnelOptions.gatewayTokenFile);
    expect(config).not.toContain("frp-secret");
    expect(config).not.toContain("9341");
  });

  it("keeps TLS encryption but omits identity verification in compatibility mode", async () => {
    const tunnelOptions = await options();
    tunnelOptions.verifyServerCertificate = false;
    tunnelOptions.trustedCaFile = undefined;
    tunnelOptions.serverName = undefined;
    const config = renderFrpcConfig(tunnelOptions);

    expect(config).toContain('transport.tls.enable = true');
    expect(config).not.toContain("transport.tls.trustedCaFile");
    expect(config).not.toContain("transport.tls.serverName");
  });

  it("requires private secret-file permissions", async () => {
    const tunnelOptions = await options();
    await chmod(tunnelOptions.tokenFile, 0o644);
    await expect(assertPrivateFile(tunnelOptions.tokenFile, "token"))
      .rejects.toThrow("group or other users");
  });

  it("verifies, starts, reports, and stops the exact supported frpc version", async () => {
    const tunnelOptions = await options();
    const child = fakeChild();
    let generatedConfigPath = "";
    const runtime: FrpRuntime = {
      version: vi.fn(async () => "0.71.0"),
      verify: vi.fn(async (_binary, configPath) => {
        generatedConfigPath = configPath;
        expect((await stat(configPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(configPath, "utf8")).toContain("localPort = 4310");
      }),
      spawn: vi.fn(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }),
    };
    const tunnel = new FrpTunnel(tunnelOptions, runtime);

    await tunnel.start();
    expect(tunnel.getState()).toEqual({ phase: "running", subdomain: "device-01" });
    expect(generatedConfigPath).not.toBe("");

    await tunnel.stop();
    expect(tunnel.getState()).toEqual({ phase: "stopped", subdomain: "device-01" });
    await expect(stat(path.dirname(generatedConfigPath))).rejects.toThrow();
  });

  it("fails closed when frpc is not v0.71.0", async () => {
    const tunnelOptions = await options();
    const runtime: FrpRuntime = {
      version: vi.fn(async () => "0.70.0"),
      verify: vi.fn(),
      spawn: vi.fn(),
    };
    const tunnel = new FrpTunnel(tunnelOptions, runtime);

    await expect(tunnel.start()).rejects.toThrow("expected 0.71.0");
    expect(tunnel.getState().phase).toBe("failed");
    expect(runtime.verify).not.toHaveBeenCalled();
  });
});
