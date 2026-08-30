import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { H264Frame } from "./frame-stream.js";
import { H264FrameStreamParser } from "./frame-stream.js";

export type VideoQualityProfile = "normal" | "high";

export interface NativeCaptureProfile {
  fps: number;
  maxWidth: number;
  bitrate: number;
}

export interface NativeCaptureOptions {
  binary: string;
  bundleId: string;
  profiles: Record<VideoQualityProfile, NativeCaptureProfile>;
}

export interface NativeCaptureEvents {
  frame: [H264Frame];
  state: [{ phase: "stopped" | "starting" | "running" | "failed"; detail?: string }];
}

export interface NativeCaptureRuntime {
  host: string;
  port: number;
  tokenPath: string;
  platform: NodeJS.Platform;
  launchApp: (appPath: string) => Promise<void>;
}

interface NativeStatus {
  type: "ready" | "error";
  detail: string;
}

const DAEMON_HOST = "127.0.0.1";
const DAEMON_PORT = 43_891;
const DAEMON_TOKEN_NAME = "my-remote-codex-capture.token";

export function nativeCaptureAppPath(binary: string): string | undefined {
  const appPath = path.dirname(path.dirname(path.dirname(binary)));
  return appPath.endsWith(".app") ? appPath : undefined;
}

export class MacOSNativeCapture extends EventEmitter<NativeCaptureEvents> {
  private socket?: Socket;
  private startPromise?: Promise<void>;
  private profile: VideoQualityProfile = "normal";
  private stopping = false;

  private readonly runtime: NativeCaptureRuntime;

  constructor(
    private readonly options: NativeCaptureOptions,
    runtime: Partial<NativeCaptureRuntime> = {},
  ) {
    super();
    this.runtime = {
      host: DAEMON_HOST,
      port: DAEMON_PORT,
      tokenPath: path.join(os.tmpdir(), DAEMON_TOKEN_NAME),
      platform: process.platform,
      launchApp,
      ...runtime,
    };
  }

  available(): boolean {
    if (this.runtime.platform !== "darwin") return false;
    const appPath = nativeCaptureAppPath(this.options.binary);
    if (!appPath) return false;
    try {
      fs.accessSync(this.options.binary, fs.constants.X_OK);
      fs.accessSync(path.join(appPath, "Contents", "Info.plist"), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.socket) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.connectHelper();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async setProfile(profile: VideoQualityProfile): Promise<void> {
    if (profile === this.profile) return;
    this.profile = profile;
    if (!this.socket) return;
    await this.stop();
    await this.start();
  }

  requestKeyframe(): void {
    if (this.socket?.writable) this.socket.write("keyframe\n");
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    this.stopping = true;
    if (socket.writable) socket.end("stop\n");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 1_500);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.stopping = false;
    this.emit("state", { phase: "stopped" });
  }

  private async connectHelper(): Promise<void> {
    if (!this.available()) throw new Error("macOS 原生采集应用不可用，请先运行 npm run build:native:macos");
    const appPath = nativeCaptureAppPath(this.options.binary)!;
    this.emit("state", { phase: "starting" });

    let socket: Socket;
    try {
      socket = await connectDaemon(this.runtime.host, this.runtime.port, 250);
    } catch {
      await this.runtime.launchApp(appPath);
      socket = await waitForDaemon(this.runtime.host, this.runtime.port, 5_000);
    }

    let token: string;
    try {
      const tokenStat = fs.statSync(this.runtime.tokenPath);
      if (tokenStat.uid !== process.getuid?.() || (tokenStat.mode & 0o077) !== 0) {
        throw new Error("unsafe token permissions");
      }
      token = fs.readFileSync(this.runtime.tokenPath, "utf8").trim();
    } catch {
      socket.destroy();
      throw new Error("无法读取 My Remote Codex Capture 本机鉴权令牌");
    }
    if (!/^[A-Fa-f0-9]{64}$/.test(token)) {
      socket.destroy();
      throw new Error("My Remote Codex Capture 本机鉴权令牌无效");
    }

    this.socket = socket;
    const parser = new H264FrameStreamParser();
    let ready = false;
    let prelude = Buffer.alloc(0);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error("等待 My Remote Codex Capture 启动超时"));
      }, 15_000);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("error", onStartupError);
        socket.off("close", onStartupClose);
      };
      const fail = (error: Error) => {
        cleanup();
        if (this.socket === socket) this.socket = undefined;
        reject(error);
      };
      const onStartupError = (error: Error) => fail(error);
      const onStartupClose = () => fail(new Error("My Remote Codex Capture 在启动视频前退出"));

      socket.on("data", (chunk: Buffer) => {
        if (ready) {
          this.consumeFrames(parser, chunk, socket);
          return;
        }
        prelude = Buffer.concat([prelude, chunk]);
        const newline = prelude.indexOf(0x0a);
        if (newline < 0) {
          if (prelude.length > 8_192) fail(new Error("原生采集握手无效"));
          return;
        }
        let status: NativeStatus;
        try {
          status = JSON.parse(prelude.subarray(0, newline).toString("utf8")) as NativeStatus;
        } catch {
          fail(new Error("原生采集握手无效"));
          return;
        }
        if (status.type === "error") {
          fail(new Error(status.detail || "原生采集启动失败"));
          socket.destroy();
          return;
        }
        if (status.type !== "ready") {
          fail(new Error("原生采集握手无效"));
          socket.destroy();
          return;
        }
        ready = true;
        cleanup();
        this.emit("state", { phase: "running", detail: status.detail });
        const remaining = prelude.subarray(newline + 1);
        prelude = Buffer.alloc(0);
        if (remaining.length) this.consumeFrames(parser, remaining, socket);
        resolve();
      });
      socket.once("error", onStartupError);
      socket.once("close", onStartupClose);
      socket.write(`${JSON.stringify({
        ...this.options.profiles[this.profile],
        bundleId: this.options.bundleId,
        token,
      })}\n`);
    });

    socket.on("error", (error) => {
      if (!this.stopping) this.emit("state", { phase: "failed", detail: error.message });
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.stopping) {
        this.emit("state", { phase: "failed", detail: "My Remote Codex Capture 连接已断开" });
      }
    });
  }

  private consumeFrames(parser: H264FrameStreamParser, chunk: Buffer, socket: Socket): void {
    try {
      for (const frame of parser.push(chunk)) this.emit("frame", frame);
    } catch (error) {
      this.emit("state", {
        phase: "failed",
        detail: error instanceof Error ? error.message : "原生视频流无效",
      });
      socket.destroy();
    }
  }
}

async function launchApp(appPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-gj", "-n", appPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(
        stderr.includes("NSOSStatusErrorDomain")
          ? "当前进程无法通过 LaunchServices 启动 My Remote Codex Capture；请手动打开该应用"
          : stderr.trim() || "无法启动 My Remote Codex Capture.app",
      ));
    });
  });
}

async function waitForDaemon(host: string, port: number, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      return await connectDaemon(host, port, 250);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`无法连接 My Remote Codex Capture.app：${lastError?.message || "本机端口未就绪"}`);
}

function connectDaemon(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("连接原生采集应用超时"));
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve(socket);
    });
    socket.once("error", onError);
  });
}
