import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { CdpMirror, type MirrorFrame, type MirrorState } from "../src/cdp/mirror.js";

function waitForEvent<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for mock CDP")), 3_000);
    register((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

describe("CdpMirror", () => {
  it("discovers a verified app target, streams frames, and forwards input", async () => {
    const commands: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
    const methods: string[] = [];
    let visibilityState: "hidden" | "visible" = "hidden";
    let commandsAtConnected = 0;
    let activeSocket: WebSocket | undefined;
    let port = 0;
    const server = http.createServer((request, response) => {
      if (request.url !== "/json/list") {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify([{
        id: "mock-page",
        type: "page",
        title: "Codex test renderer",
        url: "app://codex/index.html",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/mock-page`,
      }]));
    });
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/devtools/page/mock-page") {
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket) => {
      activeSocket = socket;
      socket.on("message", (raw) => {
        const command = JSON.parse(raw.toString()) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        commands.push(command);
        methods.push(command.method);
        const expression = String(command.params?.expression);
        const result = command.method === "Runtime.evaluate"
          ? {
              result: {
                value: expression.includes("location.protocol")
                  ? {
                      codex: true,
                      visible: true,
                      width: 1280,
                      height: 800,
                      deviceScaleFactor: 2,
                    }
                  : expression === "document.visibilityState"
                    ? visibilityState
                    : true,
              },
            }
          : command.method === "Page.captureScreenshot"
            ? { data: Buffer.from("fallback-frame").toString("base64") }
            : {};
        socket.send(JSON.stringify({ id: command.id, result }));
        if (command.method === "Page.startScreencast") {
          queueMicrotask(() => socket.send(JSON.stringify({
            method: "Page.screencastFrame",
            params: {
              data: Buffer.from("mock-frame").toString("base64"),
              sessionId: 7,
              metadata: { deviceWidth: 1280, deviceHeight: 800 },
            },
          })));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as AddressInfo).port;

    const mirror = new CdpMirror({
      cdpPort: port,
      jpegQuality: 80,
      maxFrameWidth: 1600,
      maxFrameHeight: 1200,
      normalMaxFps: 20,
      highJpegQuality: 92,
      highMaxFrameWidth: 4096,
      highMaxFrameHeight: 4096,
      highMaxFps: 30,
      backgroundCaptureDelayMs: 40,
      backgroundCaptureIntervalMs: 20,
      reconnectDelayMs: 20,
    });

    try {
      const connected = waitForEvent<MirrorState>((resolve) => {
        mirror.on("state", (state: MirrorState) => {
          if (state.phase === "connected") {
            commandsAtConnected = commands.length;
            resolve(state);
          }
        });
      });
      const frame = waitForEvent<MirrorFrame>((resolve) => mirror.once("frame", resolve));
      mirror.start();

      await expect(connected).resolves.toMatchObject({
        phase: "connected",
        viewport: { width: 1280, height: 800 },
      });
      await expect(frame).resolves.toMatchObject({ sessionId: 7 });

      const initialScreencast = commands.find((command) => command.method === "Page.startScreencast");
      expect(initialScreencast?.params).toEqual({
        format: "jpeg",
        quality: 80,
        maxWidth: 1600,
        maxHeight: 1200,
        everyNthFrame: 1,
      });
      expect(commands.slice(0, commandsAtConnected).map((command) => command.method)).toContain(
        "Page.captureScreenshot",
      );

      const qualitySwitchStart = commands.length;
      await mirror.setQualityProfile("high");
      const qualitySwitchCommands = commands.slice(qualitySwitchStart);
      const qualityLifecycleCommands = qualitySwitchCommands.filter((command) =>
        ["Page.stopScreencast", "Page.startScreencast"].includes(command.method));

      expect(qualityLifecycleCommands.map((command) => command.method)).toEqual([
        "Page.stopScreencast",
        "Page.startScreencast",
      ]);
      expect(qualityLifecycleCommands[1]?.params).toEqual({
        format: "jpeg",
        quality: 92,
        maxWidth: 2560,
        maxHeight: 1600,
        everyNthFrame: 1,
      });
      expect(mirror.getState()).toMatchObject({
        phase: "connected",
        qualityProfile: "high",
        stream: {
          jpegQuality: 92,
          maxWidth: 2560,
          maxHeight: 1600,
          maxFps: 30,
        },
      });

      const repeatedSwitchStart = commands.length;
      await mirror.setQualityProfile("high");
      expect(commands.slice(repeatedSwitchStart)).toEqual([]);

      await mirror.dispatchPointer({ type: "mousePressed", x: 100, y: 60, button: "left" });

      const keyboardStart = commands.length;
      await mirror.dispatchKey({
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        repeat: true,
      });
      await mirror.dispatchKey({
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
      });
      const keyboardCommands = commands.slice(keyboardStart);

      expect(keyboardCommands).toHaveLength(2);
      expect(keyboardCommands[0]?.params).toMatchObject({
        type: "rawKeyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        autoRepeat: true,
      });
      expect(keyboardCommands[1]?.params).toMatchObject({
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });

      const submitStart = commands.length;
      await mirror.submitText("中文补充指令");
      const submitCommands = commands.slice(submitStart);

      expect(methods).toContain("Page.startScreencast");
      expect(methods).toContain("Page.screencastFrameAck");
      expect(methods).toContain("Input.dispatchMouseEvent");
      expect(submitCommands.map((command) => command.method)).toEqual([
        "Runtime.evaluate",
        "Input.insertText",
        "Input.dispatchKeyEvent",
        "Input.dispatchKeyEvent",
        "Runtime.evaluate",
      ]);
      expect(submitCommands[1]?.params).toEqual({ text: "中文补充指令" });
      expect(submitCommands[0]?.params?.expression).toContain("contenteditable");
      expect(submitCommands[2]?.params).toMatchObject({
        type: "rawKeyDown",
        key: "Enter",
        windowsVirtualKeyCode: 13,
      });

      const fallbackFrame = waitForEvent<MirrorFrame>((resolve) => {
        mirror.on("frame", (nextFrame: MirrorFrame) => {
          if (nextFrame.sessionId === 0) resolve(nextFrame);
        });
      });
      await expect(fallbackFrame).resolves.toMatchObject({
        data: Buffer.from("fallback-frame").toString("base64"),
        sessionId: 0,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      });
      expect(methods).toContain("Page.captureScreenshot");
      expect(mirror.getState()).toMatchObject({ captureMode: "screenshot-fallback" });

      const restoredScreencast = waitForEvent<MirrorState>((resolve) => {
        mirror.on("state", (state: MirrorState) => {
          if (state.captureMode === "screencast") resolve(state);
        });
      });
      visibilityState = "visible";
      await expect(restoredScreencast).resolves.toMatchObject({
        phase: "connected",
        captureMode: "screencast",
      });
    } finally {
      mirror.stop();
      activeSocket?.close();
      await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
