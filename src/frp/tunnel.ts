import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import type { ExternalFrpConfig, SelfHostedFrpConfig, TunnelConfig } from "../config.js";

export const SUPPORTED_FRP_VERSION = "0.71.0";

export interface FrpTunnelOptions extends SelfHostedFrpConfig {
  localPort: number;
}

export interface ExternalTomlTunnelOptions extends ExternalFrpConfig {
  localPort: number;
  protectedPorts: number[];
}

export interface TunnelState {
  phase: "stopped" | "starting" | "running" | "stopping" | "failed";
  label: string;
  error?: string;
}

export interface TunnelRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): TunnelState;
}

export interface FrpRuntime {
  version(binary: string): Promise<string>;
  verify(binary: string, configPath: string): Promise<void>;
  spawn(binary: string, configPath: string): ChildProcess;
}

const execFileAsync = promisify(execFile);

const systemRuntime: FrpRuntime = {
  async version(binary) {
    const { stdout, stderr } = await execFileAsync(binary, ["--version"], { timeout: 5_000 });
    return `${stdout}${stderr}`.trim();
  },
  async verify(binary, configPath) {
    await execFileAsync(binary, ["verify", "-c", configPath], { timeout: 10_000 });
  },
  spawn(binary, configPath) {
    return spawn(binary, ["-c", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  },
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderFrpcConfig(options: FrpTunnelOptions): string {
  if (options.verifyServerCertificate && (!options.trustedCaFile || !options.serverName)) {
    throw new Error("FRP server verification requires a trusted CA and server name");
  }
  const tlsClientIdentity = options.clientCertFile && options.clientKeyFile
    ? [
        `transport.tls.certFile = ${tomlString(options.clientCertFile)}`,
        `transport.tls.keyFile = ${tomlString(options.clientKeyFile)}`,
      ]
    : [];
  const tlsServerVerification = options.verifyServerCertificate
    ? [
        `transport.tls.trustedCaFile = ${tomlString(options.trustedCaFile!)}`,
        `transport.tls.serverName = ${tomlString(options.serverName!)}`,
      ]
    : [];

  return [
    `serverAddr = ${tomlString(options.serverAddr)}`,
    `serverPort = ${options.serverPort}`,
    `clientID = ${tomlString(options.clientId)}`,
    `user = ${tomlString(options.user)}`,
    "loginFailExit = true",
    "transport.protocol = \"tcp\"",
    "transport.wireProtocol = \"v2\"",
    "transport.tls.enable = true",
    ...tlsServerVerification,
    ...tlsClientIdentity,
    "auth.method = \"token\"",
    "auth.additionalScopes = [\"HeartBeats\", \"NewWorkConns\"]",
    "auth.tokenSource.type = \"file\"",
    `auth.tokenSource.file.path = ${tomlString(options.tokenFile)}`,
    "log.to = \"console\"",
    "log.level = \"info\"",
    "log.disablePrintColor = true",
    "",
    "[[proxies]]",
    "name = \"remote-codex\"",
    "type = \"http\"",
    "localIP = \"127.0.0.1\"",
    `localPort = ${options.localPort}`,
    `subdomain = ${tomlString(options.subdomain)}`,
    "transport.useEncryption = false",
    "transport.useCompression = false",
    "healthCheck.type = \"http\"",
    "healthCheck.path = \"/healthz\"",
    "healthCheck.intervalSeconds = 10",
    "healthCheck.timeoutSeconds = 3",
    "healthCheck.maxFailed = 3",
    "",
  ].join("\n");
}

async function assertRegularFile(filePath: string, name: string): Promise<void> {
  const file = await stat(filePath);
  if (!file.isFile()) throw new Error(`${name} must point to a regular file`);
}

export async function assertOwnedRegularFile(filePath: string, name: string): Promise<Stats> {
  const link = await lstat(filePath);
  if (link.isSymbolicLink() || !link.isFile()) {
    throw new Error(`${name} must point directly to a regular file`);
  }
  if (typeof process.getuid === "function" && link.uid !== process.getuid()) {
    throw new Error(`${name} must be owned by the current user`);
  }
  await access(filePath, constants.R_OK);
  return link;
}

export async function assertPrivateFile(filePath: string, name: string): Promise<void> {
  const link = await assertOwnedRegularFile(filePath, name);
  if ((link.mode & 0o077) !== 0) {
    throw new Error(`${name} must not be readable or writable by group or other users`);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function validateExternalFrpcConfig(
  contents: string,
  localPort: number,
  protectedPorts: number[],
): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(contents) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`External FRP TOML is invalid: ${processError(error)}`, { cause: error });
  }

  const visitors = parsed.visitors;
  if (Array.isArray(visitors) && visitors.length > 0) {
    throw new Error("External FRP TOML must not contain visitor definitions");
  }
  const includes = parsed.includes;
  if (Array.isArray(includes) && includes.length > 0) {
    throw new Error("External FRP TOML must not include additional configuration files");
  }
  if (!Array.isArray(parsed.proxies) || parsed.proxies.length !== 1) {
    throw new Error("External FRP TOML must contain exactly one proxy");
  }
  const proxy = record(parsed.proxies[0]);
  if (!proxy) throw new Error("External FRP TOML proxy must be a table");
  if (proxy.plugin !== undefined) {
    throw new Error("External FRP TOML proxy must not use a local plugin");
  }
  if (proxy.type !== "http") {
    throw new Error("External FRP TOML proxy type must be http");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(String(proxy.localIP || ""))) {
    throw new Error("External FRP TOML proxy must target a loopback address");
  }
  if (!Number.isInteger(proxy.localPort)) {
    throw new Error("External FRP TOML proxy localPort must be an integer");
  }
  if (protectedPorts.includes(proxy.localPort as number)) {
    throw new Error(`External FRP TOML must not expose protected local port ${proxy.localPort}`);
  }
  if (proxy.localPort !== localPort) {
    throw new Error(`External FRP TOML proxy localPort must match the web service port ${localPort}`);
  }
}

function parseVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
}

function processError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

abstract class ManagedFrpTunnel implements TunnelRunner {
  private child?: ChildProcess;
  private state: TunnelState;

  protected constructor(
    private readonly label: string,
    protected readonly binary: string,
    protected readonly runtime: FrpRuntime,
  ) {
    this.state = { phase: "stopped", label };
  }

  getState(): TunnelState {
    return { ...this.state };
  }

  protected abstract prepareConfig(): Promise<string>;
  protected abstract cleanupConfig(): Promise<void>;

  async start(): Promise<void> {
    if (this.state.phase === "running" || this.state.phase === "starting") return;
    this.state = { phase: "starting", label: this.label };
    try {
      const configPath = await this.prepareConfig();
      await this.runtime.verify(this.binary, configPath);
      const child = this.runtime.spawn(this.binary, configPath);
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[frpc] ${chunk.toString()}`));
      child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[frpc] ${chunk.toString()}`));
      await waitForSpawn(child);
      child.once("exit", (code, signal) => {
        if (this.state.phase !== "stopping" && this.state.phase !== "stopped") {
          const reason = `frpc exited unexpectedly (${signal ?? code ?? "unknown"})`;
          this.state = { phase: "failed", label: this.label, error: reason };
          console.error(reason);
        }
        this.child = undefined;
        void this.cleanupConfig();
      });
      this.state = { phase: "running", label: this.label };
    } catch (error) {
      this.child?.kill("SIGTERM");
      this.child = undefined;
      await this.cleanupConfig();
      const message = processError(error);
      this.state = { phase: "failed", label: this.label, error: message };
      throw new Error(`FRP tunnel failed to start: ${message}`, { cause: error });
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      await this.cleanupConfig();
      this.state = { phase: "stopped", label: this.label };
      return;
    }
    this.state = { phase: "stopping", label: this.label };
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 2_000).unref();
    });
    if (await Promise.race([exited, timeout]) === "timeout") {
      child.kill("SIGKILL");
      const killTimeout = new Promise<void>((resolve) => {
        setTimeout(resolve, 1_000).unref();
      });
      await Promise.race([exited, killTimeout]);
    }
    this.child = undefined;
    await this.cleanupConfig();
    this.state = { phase: "stopped", label: this.label };
  }
}

export class FrpTunnel extends ManagedFrpTunnel {
  private tempDirectory?: string;
  private cleanupPromise?: Promise<void>;

  constructor(
    private readonly options: FrpTunnelOptions,
    runtime: FrpRuntime = systemRuntime,
  ) {
    super(options.subdomain, options.binary, runtime);
  }

  protected async prepareConfig(): Promise<string> {
    await assertPrivateFile(this.options.tokenFile, "REMOTE_CODEX_FRP_TOKEN_FILE");
    if (this.options.verifyServerCertificate) {
      await assertRegularFile(this.options.trustedCaFile!, "REMOTE_CODEX_FRP_TRUSTED_CA");
    }
    if (this.options.clientCertFile && this.options.clientKeyFile) {
      await assertRegularFile(this.options.clientCertFile, "REMOTE_CODEX_FRP_CLIENT_CERT");
      await assertPrivateFile(this.options.clientKeyFile, "REMOTE_CODEX_FRP_CLIENT_KEY");
    }
    const reportedVersion = parseVersion(await this.runtime.version(this.options.binary));
    if (reportedVersion !== SUPPORTED_FRP_VERSION) {
      throw new Error(
        `Unsupported frpc version ${reportedVersion || "unknown"}; expected ${SUPPORTED_FRP_VERSION}`,
      );
    }
    this.tempDirectory = await mkdtemp(path.join(os.tmpdir(), "my-remote-codex-frp-"));
    const configPath = path.join(this.tempDirectory, "frpc.toml");
    await writeFile(configPath, renderFrpcConfig(this.options), { mode: 0o600, flag: "wx" });
    return configPath;
  }

  protected async cleanupConfig(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const directory = this.tempDirectory;
    this.tempDirectory = undefined;
    if (!directory) return;
    this.cleanupPromise = rm(directory, { recursive: true, force: true })
      .finally(() => { this.cleanupPromise = undefined; });
    return this.cleanupPromise;
  }
}

export class ExternalTomlFrpTunnel extends ManagedFrpTunnel {
  constructor(
    private readonly options: ExternalTomlTunnelOptions,
    runtime: FrpRuntime = systemRuntime,
  ) {
    super(path.basename(options.configFile), options.binary, runtime);
  }

  protected async prepareConfig(): Promise<string> {
    await assertOwnedRegularFile(this.options.configFile, "REMOTE_CODEX_FRP_CONFIG_FILE");
    validateExternalFrpcConfig(
      await readFile(this.options.configFile, "utf8"),
      this.options.localPort,
      this.options.protectedPorts,
    );
    return this.options.configFile;
  }

  protected async cleanupConfig(): Promise<void> {}
}

export function createTunnelRunner(
  config: TunnelConfig,
  localPort: number,
  protectedPorts: number[],
): TunnelRunner {
  return config.kind === "external-toml"
    ? new ExternalTomlFrpTunnel({ ...config, localPort, protectedPorts })
    : new FrpTunnel({ ...config, localPort });
}
