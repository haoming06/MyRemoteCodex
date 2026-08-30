import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const PAIRING_CODE = "SECURE23";

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve a local port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The child process may still be binding its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become healthy:\n${logs()}`);
}

function rejectedUpgrade(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode || 0;
      response.destroy();
      resolve(status);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket upgrade unexpectedly succeeded"));
    });
    socket.once("error", reject);
  });
}

describe("server authentication boundary", () => {
  let child: ChildProcess;
  let baseUrl: string;
  let websocketUrl: string;
  let output = "";

  beforeAll(async () => {
    const port = await availablePort();
    const cdpPort = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    websocketUrl = `ws://127.0.0.1:${port}/ws`;
    child = spawn(path.resolve("node_modules/.bin/tsx"), ["src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REMOTE_CODEX_HOST: "127.0.0.1",
        REMOTE_CODEX_PORT: String(port),
        REMOTE_CODEX_CDP_PORT: String(cdpPort),
        REMOTE_CODEX_PAIRING_CODE: PAIRING_CODE,
        REMOTE_CODEX_VIDEO_TRANSPORT: "jpeg",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    await waitForHealth(baseUrl, child, () => output);
  }, 15_000);

  afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  });

  it("requires a same-origin paired session and closes it on logout", async () => {
    const anonymousSession = await fetch(`${baseUrl}/api/session`);
    expect(await anonymousSession.json()).toEqual({ authenticated: false });

    await expect(rejectedUpgrade(websocketUrl, { Origin: baseUrl })).resolves.toBe(401);

    const crossSchemePair = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl.replace("http:", "https:") },
      body: JSON.stringify({ code: PAIRING_CODE }),
    });
    expect(crossSchemePair.status).toBe(403);

    const wrongPair = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ code: "WRONG2345AB" }),
    });
    expect(wrongPair.status).toBe(401);

    const pair = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ code: PAIRING_CODE }),
    });
    expect(pair.status).toBe(200);
    const cookie = pair.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^remote_codex_session=/);
    if (!cookie) throw new Error("Pairing response did not set a session cookie");

    await expect(rejectedUpgrade(websocketUrl, { Cookie: cookie })).resolves.toBe(401);

    const authenticatedSession = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: cookie } });
    expect(await authenticatedSession.json()).toMatchObject({
      authenticated: true,
      mirror: { phase: expect.any(String) },
    });

    const socket = new WebSocket(websocketUrl, { headers: { Cookie: cookie, Origin: baseUrl } });
    await once(socket, "open");
    const closed = once(socket, "close");

    const logout = await fetch(`${baseUrl}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl },
    });
    expect(logout.status).toBe(200);
    const [closeCode] = await closed;
    expect(closeCode).toBe(1008);

    await expect(rejectedUpgrade(websocketUrl, { Cookie: cookie, Origin: baseUrl })).resolves.toBe(401);
  }, 15_000);
});
