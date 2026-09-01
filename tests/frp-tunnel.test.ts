import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPrivateFile,
  ExternalTomlFrpTunnel,
  FrpTunnel,
  renderFrpcConfig,
  validateExternalFrpcConfig,
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
    kind: "self-hosted",
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
    expect(tunnel.getState()).toEqual({ phase: "running", label: "device-01" });
    expect(generatedConfigPath).not.toBe("");

    await tunnel.stop();
    expect(tunnel.getState()).toEqual({ phase: "stopped", label: "device-01" });
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

  it("accepts one loopback HTTP proxy for the configured web service", () => {
    expect(() => validateExternalFrpcConfig(`
serverAddr = "frp.example.com"
serverPort = 7000
auth.token = "secret"

[[proxies]]
name = "remote-codex"
type = "http"
localIP = "127.0.0.1"
localPort = 4310
customDomains = ["device.tunnel.example"]
`, 4310, [9341])).not.toThrow();
  });

  it("rejects external configs that expose CDP, other services, or visitors", () => {
    const proxy = (localPort: number, extra = "") => `
[[proxies]]
name = "unsafe"
type = "http"
localIP = "127.0.0.1"
localPort = ${localPort}
${extra}`;
    expect(() => validateExternalFrpcConfig(proxy(9341), 4310, [9341]))
      .toThrow("must not expose protected local port 9341");
    expect(() => validateExternalFrpcConfig(proxy(8080), 4310, [9341]))
      .toThrow("must match the web service port 4310");
    expect(() => validateExternalFrpcConfig(`${proxy(4310)}\n[[visitors]]\nname = "visitor"`, 4310, [9341]))
      .toThrow("must not contain visitor definitions");
    expect(() => validateExternalFrpcConfig(`includes = ["other.toml"]\n${proxy(4310)}`, 4310, [9341]))
      .toThrow("must not include additional configuration files");
    expect(() => validateExternalFrpcConfig(`${proxy(4310)}\n[proxies.plugin]\ntype = "static_file"`, 4310, [9341]))
      .toThrow("must not use a local plugin");
  });

  it("runs an external TOML without pinning the provider's frpc version", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "frp-external-test-"));
    directories.push(directory);
    const configFile = path.join(directory, "nicefrp.toml");
    await writeFile(configFile, `
[[proxies]]
name = "remote-codex"
type = "http"
localIP = "127.0.0.1"
localPort = 4310
`, { mode: 0o600 });
    const child = fakeChild();
    const runtime: FrpRuntime = {
      version: vi.fn(async () => "99.0.0"),
      verify: vi.fn(),
      spawn: vi.fn(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }),
    };
    const tunnel = new ExternalTomlFrpTunnel({
      kind: "external-toml",
      binary: "frpc",
      configFile,
      localPort: 4310,
      protectedPorts: [9341],
    }, runtime);

    await tunnel.start();
    expect(runtime.version).not.toHaveBeenCalled();
    expect(runtime.verify).toHaveBeenCalledWith("frpc", configFile);
    expect(tunnel.getState()).toEqual({ phase: "running", label: "nicefrp.toml" });
    await tunnel.stop();
  });
});
