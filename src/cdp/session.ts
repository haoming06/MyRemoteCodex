import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { CdpTarget } from "./target.js";
import { validatedDebuggerUrl } from "./target.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class CdpSession extends EventEmitter {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;

  constructor(
    readonly target: CdpTarget,
    private readonly port: number,
  ) {
    super();
  }

  async open(): Promise<void> {
    if (this.socket) throw new Error("CDP session is already open");
    this.socket = new WebSocket(validatedDebuggerUrl(this.target, this.port));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket?.close();
        reject(new Error("CDP WebSocket connection timed out"));
      }, 5_000);
      this.socket?.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket?.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    this.socket.on("message", (data) => this.handleMessage(data));
    this.socket.on("close", () => this.handleClose());
    this.socket.on("error", () => this.handleClose());
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP session is closed"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      this.socket?.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || "Renderer evaluation failed",
      );
    }
    return response.result?.value as T;
  }

  waitUntilClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => this.once("closed", resolve));
  }

  close(): void {
    this.socket?.close();
    this.handleClose();
  }

  private handleMessage(data: RawData): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(data.toString()) as CdpResponse;
    } catch {
      this.close();
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.emit("event", message.method, message.params);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("CDP session closed"));
    }
    this.pending.clear();
    this.emit("closed");
  }
}
