import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeH264Frame } from "../src/video/frame-stream.js";
import { MacOSNativeCapture } from "../src/video/native-capture.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    fs.rmSync(cleanupPath, { force: true, recursive: true });
  }
});

describe("native capture transport", () => {
  it("authenticates and receives H.264 frames over loopback TCP", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remote-codex-capture-test-"));
    cleanupPaths.push(fixtureRoot);
    const appPath = path.join(fixtureRoot, "My Remote Codex Capture.app");
    const binary = path.join(appPath, "Contents", "MacOS", "remote-codex-capture");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "fixture", { mode: 0o755 });
    fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), "fixture");
    const tokenPath = path.join(fixtureRoot, "capture.token");
    const token = "a".repeat(64);
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });

    const server = net.createServer((socket) => {
      let request = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        request = Buffer.concat([request, chunk]);
        const newline = request.indexOf(0x0a);
        if (newline < 0) return;
        const message = JSON.parse(request.subarray(0, newline).toString("utf8")) as {
          bundleId: string;
          token: string;
        };
        expect(message).toMatchObject({ bundleId: "com.openai.codex", token });
        socket.write(`${JSON.stringify({ type: "ready", detail: "fixture ready" })}\n`);
        socket.write(encodeH264Frame({
          keyframe: true,
          width: 1280,
          height: 720,
          timestamp90k: 90_000,
          data: Buffer.from([0, 0, 0, 1, 0x65]),
        }));
        socket.removeAllListeners("data");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");

    const capture = new MacOSNativeCapture({
      binary,
      bundleId: "com.openai.codex",
      profiles: {
        normal: { fps: 30, maxWidth: 1600, bitrate: 3_000_000 },
        high: { fps: 45, maxWidth: 2560, bitrate: 7_000_000 },
      },
    }, {
      host: "127.0.0.1",
      port: address.port,
      tokenPath,
      platform: "darwin",
      launchApp: async () => { throw new Error("fixture daemon should already be running"); },
    });

    const framePromise = new Promise<Parameters<Parameters<typeof capture.once>[1]>[0]>((resolve) => {
      capture.once("frame", resolve);
    });
    await capture.start();
    await expect(framePromise).resolves.toMatchObject({
      keyframe: true,
      width: 1280,
      height: 720,
      timestamp90k: 90_000,
    });
    await capture.stop();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
